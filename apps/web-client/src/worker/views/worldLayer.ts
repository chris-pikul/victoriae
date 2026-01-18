import type { VictoriaeLayer, TgpuContext, TgpuRenderPass, Viewport } from '../types';
import { SAB_OFFSETS } from '../../shared/constants';
import { MapManager } from '../managers/MapManager';
import * as d from 'typegpu/data';

/**
 * World layer - renders the base tilemap
 * Uses MapManager to get tilemap data (passive listener - no local generation)
 */
export class WorldLayer implements VictoriaeLayer {
    layerId: number = -1; // Will be assigned by ViewManager
    visible: boolean = true;
    viewport: Viewport | null = null; // Full screen - no viewport restriction

    private device: GPUDevice | null = null;
    private cameraUniformBuffer: GPUBuffer | null = null;
    private mapManager: MapManager;
    private tilesetTexture: GPUTexture | null = null;
    private tilesetTextureView: GPUTextureView | null = null;
    private tilesetSampler: GPUSampler | null = null;
    private tilemapBindGroup: GPUBindGroup | null = null;
    private tilemapBindGroupLayout: GPUBindGroupLayout | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private canvas: OffscreenCanvas | null = null;
    private format: GPUTextureFormat | null = null;

    constructor(mapManager: MapManager) {
        this.mapManager = mapManager;
    }

    init(context: TgpuContext): void {
        this.device = context.device;
        this.canvas = context.canvas;
        this.format = context.format;

        // Define CameraUniform struct using TypeGPU data types
        const CameraUniform = d.struct({
            pos: d.vec2f,
            zoom: d.f32,
            screenSize: d.vec2f,
        });

        // Create bind group layout for tilemap
        const tilemapBindGroupLayout = this.device.createBindGroupLayout({
            label: 'tilemap-bind-group-layout',
            entries: [
                {
                    binding: 0, // Camera uniform
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: {
                        type: 'uniform',
                    },
                },
                {
                    binding: 1, // Tilemap storage buffer
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: {
                        type: 'read-only-storage',
                    },
                },
                {
                    binding: 2, // Tileset texture
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {
                        sampleType: 'float',
                    },
                },
                {
                    binding: 3, // Tileset sampler
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: {
                        type: 'filtering',
                    },
                },
            ],
        });

        // Create uniform buffer for camera
        const uniformBufferSize = 32; // Aligned to 16 bytes
        this.cameraUniformBuffer = this.device.createBuffer({
            label: 'camera-uniform-buffer',
            size: uniformBufferSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Note: Tilemap storage buffer is managed by MapManager
        // We don't generate any data here - we're a passive listener
        // The buffer will be created/updated when UPDATE_MAP message arrives

        // Create placeholder tileset texture
        const TILE_SIZE = 32;
        const TILESET_COLS = 4;
        const TILESET_ROWS = 1;
        const tilesetWidth = TILE_SIZE * TILESET_COLS;
        const tilesetHeight = TILE_SIZE * TILESET_ROWS;
        const tilesetData = new Uint8Array(tilesetWidth * tilesetHeight * 4);

        const tileColors = [
            [100, 250, 100, 255],  // Tile 0: Green
            [250, 100, 100, 255],  // Tile 1: Red
            [100, 100, 250, 255],  // Tile 2: Blue
            [250, 250, 100, 255],  // Tile 3: Yellow
        ];

        for (let tileId = 0; tileId < TILESET_COLS; tileId++) {
            const tileX = tileId * TILE_SIZE;
            const color = tileColors[tileId];

            for (let y = 0; y < TILE_SIZE; y++) {
                for (let x = 0; x < TILE_SIZE; x++) {
                    const px = tileX + x;
                    const py = y;
                    const idx = (py * tilesetWidth + px) * 4;

                    const variation = Math.sin(x * 0.5) * Math.sin(y * 0.5) * 20;
                    tilesetData[idx] = Math.max(0, Math.min(255, color[0] + variation));
                    tilesetData[idx + 1] = Math.max(0, Math.min(255, color[1] + variation));
                    tilesetData[idx + 2] = Math.max(0, Math.min(255, color[2] + variation));
                    tilesetData[idx + 3] = 255;
                }
            }
        }

        this.tilesetTexture = this.device.createTexture({
            label: 'tileset-texture',
            size: [tilesetWidth, tilesetHeight],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        this.device.queue.writeTexture(
            { texture: this.tilesetTexture },
            tilesetData,
            { bytesPerRow: tilesetWidth * 4, rowsPerImage: tilesetHeight },
            { width: tilesetWidth, height: tilesetHeight }
        );

        this.tilesetTextureView = this.tilesetTexture.createView();

        this.tilesetSampler = this.device.createSampler({
            label: 'tileset-sampler',
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        // Create bind group for tilemap (will be created lazily when map data arrives)
        // We'll create it in ensureBindGroup() when MapManager has data
        this.tilemapBindGroup = null;

        // Store bind group layout for later use
        this.tilemapBindGroupLayout = tilemapBindGroupLayout;

        // Create shader module for fullscreen tilemap
        const shaderModule = this.device.createShaderModule({
            label: 'tilemap-shader',
            code: `
                struct CameraUniform {
                    pos: vec2<f32>,
                    zoom: f32,
                    screenSize: vec2<f32>,
                };
                
                @group(0) @binding(0) var<uniform> camera: CameraUniform;
                @group(0) @binding(1) var<storage, read> tilemap: array<u32>;
                @group(0) @binding(2) var tileset: texture_2d<f32>;
                @group(0) @binding(3) var tilesetSampler: sampler;
                
                const MAP_SIZE: u32 = 64u;
                const TILESET_COLS: u32 = 4u;
                
                @vertex
                fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
                    var pos = vec2<f32>(-1.0, -1.0);
                    if (vertexIndex == 1u) {
                        pos = vec2<f32>(3.0, -1.0);
                    } else if (vertexIndex == 2u) {
                        pos = vec2<f32>(-1.0, 3.0);
                    }
                    return vec4<f32>(pos, 0.0, 1.0);
                }
                
                @fragment
                fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
                    let screenPos = fragCoord.xy;
                    let screenSize = camera.screenSize;
                    
                    if (screenSize.x <= 0.0 || screenSize.y <= 0.0) {
                        return vec4<f32>(0.1, 0.1, 0.1, 1.0);
                    }
                    
                    let zoom = max(camera.zoom, 0.001);
                    let ndcRaw = (screenPos / screenSize) * 2.0 - 1.0;
                    let ndc = vec2<f32>(ndcRaw.x, -ndcRaw.y);
                    
                    let aspectRatio = screenSize.x / screenSize.y;
                    let worldSizeY = 2.0 / zoom;
                    let worldSizeX = worldSizeY * aspectRatio;
                    let worldPos = vec2<f32>(
                        ndc.x * (worldSizeX * 0.5) + camera.pos.x,
                        ndc.y * (worldSizeY * 0.5) + camera.pos.y
                    );
                    
                    let tileCoord = vec2<i32>(floor(worldPos));
                    let clampedX = clamp(tileCoord.x, 0, i32(MAP_SIZE) - 1);
                    let clampedY = clamp(tileCoord.y, 0, i32(MAP_SIZE) - 1);
                    
                    let isOutOfBounds = tileCoord.x < 0 || tileCoord.x >= i32(MAP_SIZE) || 
                                        tileCoord.y < 0 || tileCoord.y >= i32(MAP_SIZE);
                    
                    let tileIndex = u32(clampedY) * MAP_SIZE + u32(clampedX);
                    let tileId = tilemap[tileIndex];
                    
                    let tileUV = fract(worldPos);
                    let tilesetU = (f32(tileId) + tileUV.x) / f32(TILESET_COLS);
                    let tilesetV = tileUV.y;
                    
                    let color = textureSample(tileset, tilesetSampler, vec2<f32>(tilesetU, tilesetV));
                    
                    if (isOutOfBounds) {
                        return color * 0.3;
                    }
                    
                    return color;
                }
            `,
        });

        const pipelineLayout = this.device.createPipelineLayout({
            label: 'tilemap-pipeline-layout',
            bindGroupLayouts: [tilemapBindGroupLayout],
        });

        this.pipeline = this.device.createRenderPipeline({
            label: 'tilemap-pipeline',
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format!,
                }],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });
    }

    update(sabView: Float32Array, deltaTime: number): void {
        if (!this.device || !this.cameraUniformBuffer || !this.canvas) return;

        // Read camera values from SharedArrayBuffer
        const camX = sabView[SAB_OFFSETS.CAMERA_X] || 0.0;
        const camY = sabView[SAB_OFFSETS.CAMERA_Y] || 0.0;
        const camZoom = sabView[SAB_OFFSETS.CAMERA_ZOOM] || 1.0;
        const screenWidth = this.canvas.width || 800;
        const screenHeight = this.canvas.height || 600;

        // Update SAB with current screen dimensions
        sabView[SAB_OFFSETS.SCREEN_WIDTH] = screenWidth;
        sabView[SAB_OFFSETS.SCREEN_HEIGHT] = screenHeight;

        // Update camera uniform buffer
        const uniformData = new Float32Array(8);
        uniformData[0] = camX;
        uniformData[1] = camY;
        uniformData[2] = camZoom;
        uniformData[3] = 0.0;
        uniformData[4] = screenWidth;
        uniformData[5] = screenHeight;
        uniformData[6] = 0.0;
        uniformData[7] = 0.0;

        this.device.queue.writeBuffer(this.cameraUniformBuffer, 0, uniformData.buffer);

        // Update bind group if map data is now available
        this.ensureBindGroup();
    }

    /**
     * Ensure bind group is created when map data is available
     */
    private ensureBindGroup(): void {
        if (!this.device || !this.tilemapBindGroupLayout || this.tilemapBindGroup) {
            return; // Already created or not ready
        }

        const storageBuffer = this.mapManager.getStorageBuffer();
        if (!storageBuffer) {
            return; // Map data not available yet
        }

        // Create bind group now that we have map data
        this.tilemapBindGroup = this.device.createBindGroup({
            label: 'tilemap-bind-group',
            layout: this.tilemapBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.cameraUniformBuffer!,
                    },
                },
                {
                    binding: 1,
                    resource: {
                        buffer: storageBuffer,
                    },
                },
                {
                    binding: 2,
                    resource: this.tilesetTextureView!,
                },
                {
                    binding: 3,
                    resource: this.tilesetSampler!,
                },
            ],
        });

        console.log('Victoriae [Worker Thread]: WorldLayer bind group created with map data');
    }

    render(
        pass: TgpuRenderPass | null,
        needsNewPass: boolean,
        textureView: GPUTextureView,
        commandEncoder: GPUCommandEncoder,
        screenWidth: number,
        screenHeight: number
    ): GPURenderPassEncoder | null {
        if (!this.pipeline || !this.tilemapBindGroup) return pass?.encoder || null;

        let renderPass: GPURenderPassEncoder;

        if (needsNewPass) {
            // Create a new render pass (for the base layer - clears the screen)
            renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: textureView,
                    clearValue: { r: 0.102, g: 0.102, b: 0.102, a: 1.0 }, // #1a1a1a
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            });
        } else {
            // Use existing render pass (for overlays)
            if (!pass) {
                throw new Error('Cannot use existing pass without pass object');
            }
            renderPass = pass.encoder;
        }

        // Apply viewport scissoring if viewport is set
        if (this.viewport) {
            renderPass.setViewport(
                this.viewport.x,
                this.viewport.y,
                this.viewport.width,
                this.viewport.height,
                0.0, // minDepth
                1.0  // maxDepth
            );
            renderPass.setScissorRect(
                Math.floor(this.viewport.x),
                Math.floor(this.viewport.y),
                Math.ceil(this.viewport.width),
                Math.ceil(this.viewport.height)
            );
        } else {
            // Full screen viewport
            renderPass.setViewport(0, 0, screenWidth, screenHeight, 0.0, 1.0);
            renderPass.setScissorRect(0, 0, screenWidth, screenHeight);
        }

        // Ensure bind group exists (may be created lazily when map data arrives)
        this.ensureBindGroup();

        // Skip rendering if map data not available yet
        if (!this.tilemapBindGroup) {
            return renderPass;
        }

        // Draw tilemap
        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.tilemapBindGroup);
        renderPass.draw(3, 1, 0, 0);

        // Return the render pass so subsequent layers can use it
        return renderPass;
    }
}
