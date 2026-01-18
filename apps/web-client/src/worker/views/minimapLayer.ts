import type { VictoriaeLayer, TgpuContext, TgpuRenderPass, Viewport } from '../types';
import { SAB_OFFSETS } from '../../shared/constants';
import { MapManager } from '../managers/MapManager';
import * as d from 'typegpu/data';

const MINIMAP_SIZE = 200; // Size of minimap in pixels (square)

/**
 * Minimap layer - renders a small overview of the entire map in the top-right corner
 * Uses MapManager to get tilemap data (passive listener - no local generation)
 */
export class MinimapLayer implements VictoriaeLayer {
    layerId: number = -1; // Will be assigned by ViewManager
    visible: boolean = true;
    viewport: Viewport | null = null; // Will be set in init based on screen size
    
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

        // Set viewport to top-right corner
        // We'll update this dynamically based on screen size
        const screenWidth = this.canvas.width || 800;
        const screenHeight = this.canvas.height || 600;
        const margin = 10;
        this.viewport = {
            x: screenWidth - MINIMAP_SIZE - margin,
            y: margin,
            width: MINIMAP_SIZE,
            height: MINIMAP_SIZE,
        };

        // Define CameraUniform struct (same as WorldLayer)
        const CameraUniform = d.struct({
            pos: d.vec2f,
            zoom: d.f32,
            screenSize: d.vec2f,
        });

        // Create bind group layout for tilemap (same as WorldLayer)
        const tilemapBindGroupLayout = this.device.createBindGroupLayout({
            label: 'minimap-bind-group-layout',
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
            label: 'minimap-camera-uniform-buffer',
            size: uniformBufferSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Note: Tilemap storage buffer is managed by MapManager
        // We don't generate any data here - we're a passive listener
        // The buffer will be created/updated when UPDATE_MAP message arrives

        // Create placeholder tileset texture (same as WorldLayer)
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
            label: 'minimap-tileset-texture',
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
            label: 'minimap-tileset-sampler',
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        // Create bind group for tilemap (will be created lazily when map data arrives)
        // We'll create it in ensureBindGroup() when MapManager has data
        this.tilemapBindGroup = null;
        
        // Store bind group layout for later use
        this.tilemapBindGroupLayout = tilemapBindGroupLayout;

        // Create shader module for minimap (same as WorldLayer but with different camera settings)
        const shaderModule = this.device.createShaderModule({
            label: 'minimap-shader',
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
            label: 'minimap-pipeline-layout',
            bindGroupLayouts: [tilemapBindGroupLayout],
        });

        this.pipeline = this.device.createRenderPipeline({
            label: 'minimap-pipeline',
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
        if (!this.device || !this.cameraUniformBuffer || !this.canvas || !this.viewport) return;

        // Update viewport position based on current screen size
        const screenWidth = this.canvas.width || 800;
        const screenHeight = this.canvas.height || 600;
        const margin = 10;
        this.viewport.x = screenWidth - MINIMAP_SIZE - margin;
        this.viewport.y = margin;
        this.viewport.width = MINIMAP_SIZE;
        this.viewport.height = MINIMAP_SIZE;

        // Get map size from MapManager (dynamic, not hardcoded)
        const mapSize = this.mapManager.getMapSize();
        if (mapSize === 0) {
            return; // Map data not available yet
        }

        // Minimap camera: centered on map, zoomed out to show entire map
        // Camera position: center of map
        const minimapCamX = mapSize * 0.5; // Center of map
        const minimapCamY = mapSize * 0.5; // Center of map
        
        // Calculate zoom to fit entire map in minimap
        // We want the entire map to fit in the minimap viewport
        // worldSizeY = 2.0 / zoom, and we want worldSizeY >= mapSize
        // So: 2.0 / zoom >= mapSize => zoom <= 2.0 / mapSize
        const minimapZoom = 2.0 / mapSize; // Zoom to show entire map

        // Update camera uniform buffer with minimap camera settings
        const uniformData = new Float32Array(8);
        uniformData[0] = minimapCamX;
        uniformData[1] = minimapCamY;
        uniformData[2] = minimapZoom;
        uniformData[3] = 0.0;
        uniformData[4] = MINIMAP_SIZE; // Use minimap size as screen size for coordinate calculation
        uniformData[5] = MINIMAP_SIZE;
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
            label: 'minimap-bind-group',
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

        console.log('Victoriae [Worker Thread]: MinimapLayer bind group created with map data');
    }

    render(
        pass: TgpuRenderPass | null,
        needsNewPass: boolean,
        textureView: GPUTextureView,
        commandEncoder: GPUCommandEncoder,
        screenWidth: number,
        screenHeight: number
    ): GPURenderPassEncoder | null {
        if (!this.pipeline || !this.viewport) return pass?.encoder || null;

        // Ensure bind group exists (may be created lazily when map data arrives)
        this.ensureBindGroup();

        // Skip rendering if map data not available yet
        if (!this.tilemapBindGroup) {
            return pass?.encoder || null;
        }

        // Minimap always uses existing pass (never creates new one)
        if (!pass) {
            throw new Error('Minimap layer requires existing render pass');
        }

        const renderPass = pass.encoder;

        // Apply viewport scissoring to restrict rendering to minimap area
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

        // Draw minimap
        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.tilemapBindGroup);
        renderPass.draw(3, 1, 0, 0);

        // Return existing pass for potential subsequent layers
        return renderPass;
    }
}
