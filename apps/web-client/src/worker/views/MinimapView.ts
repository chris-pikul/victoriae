import type { VictoriaeLayer, TgpuContext, TgpuRenderPass, Viewport } from '../types';
import { MapManager } from '../managers/MapManager';

const MINIMAP_SIZE = 200; // Size of minimap in pixels (square)
const MINIMAP_MARGIN = 10; // Margin from screen edge

/**
 * MinimapView - High-performance minimap overlay
 * 
 * Reuses the MapManager storage buffer and renders with simplified hardcoded colors
 * for a clean pixel-art look. Shows the entire map at all times with a fixed camera.
 */
export class MinimapView implements VictoriaeLayer {
    layerId: number = -1; // Will be assigned by ViewManager
    visible: boolean = true;
    viewport: Viewport | null = null; // Fixed viewport in top-right corner
    
    private device: GPUDevice | null = null;
    private mapManager: MapManager;
    private minimapBindGroup: GPUBindGroup | null = null;
    private minimapBindGroupLayout: GPUBindGroupLayout | null = null;
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

        // Set fixed viewport to top-right corner
        const screenWidth = this.canvas.width || 800;
        const screenHeight = this.canvas.height || 600;
        this.viewport = {
            x: screenWidth - MINIMAP_SIZE - MINIMAP_MARGIN,
            y: MINIMAP_MARGIN,
            width: MINIMAP_SIZE,
            height: MINIMAP_SIZE,
        };

        // Create bind group layout for minimap
        // Only needs: storage buffer (map data) and minimap uniform (map size + viewport info)
        this.minimapBindGroupLayout = this.device.createBindGroupLayout({
            label: 'minimap-bind-group-layout',
            entries: [
                {
                    binding: 0, // Map storage buffer (reused from MapManager)
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: {
                        type: 'read-only-storage',
                    },
                },
                {
                    binding: 1, // Minimap uniform (map size, viewport position and size)
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: {
                        type: 'uniform',
                    },
                },
            ],
        });

        // Create uniform buffer for minimap settings
        // Layout: mapSize (u32), viewportX (f32), viewportY (f32), viewportWidth (f32), viewportHeight (f32)
        const minimapUniformBuffer = this.device.createBuffer({
            label: 'minimap-uniform',
            size: 32, // 5 values = 20 bytes, padded to 32
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Create shader module for simplified minimap rendering
        const shaderModule = this.device.createShaderModule({
            label: 'minimap-shader',
            code: `
                struct MinimapUniform {
                    mapSize: f32,  // Stored as f32, will be cast to u32
                    viewportX: f32,
                    viewportY: f32,
                    viewportWidth: f32,
                    viewportHeight: f32,
                    padding1: f32,
                    padding2: f32,
                    padding3: f32,
                };
                
                @group(0) @binding(0) var<storage, read> tilemap: array<u32>;
                @group(0) @binding(1) var<uniform> minimap: MinimapUniform;
                
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
                    // fragCoord is in screen pixel coordinates
                    // We need to check if we're within the minimap viewport
                    let screenPos = fragCoord.xy;
                    
                    // Check if fragment is within minimap viewport
                    if (screenPos.x < minimap.viewportX || 
                        screenPos.x >= minimap.viewportX + minimap.viewportWidth ||
                        screenPos.y < minimap.viewportY || 
                        screenPos.y >= minimap.viewportY + minimap.viewportHeight) {
                        // Outside viewport - return transparent (will be clipped by scissor anyway)
                        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
                    }
                    
                    // Convert screen position to viewport-relative coordinates (0 to 1)
                    let viewportX = (screenPos.x - minimap.viewportX) / minimap.viewportWidth;
                    let viewportY = (screenPos.y - minimap.viewportY) / minimap.viewportHeight;
                    
                    // Calculate world position (entire map visible)
                    // Minimap shows entire map, so world coordinates go from 0 to mapSize
                    let mapSizeF = minimap.mapSize;
                    let mapSizeU = u32(mapSizeF);
                    
                    // Convert viewport coordinates to world coordinates
                    // Viewport goes from 0 to 1, world goes from 0 to mapSize
                    let worldX = viewportX * mapSizeF;
                    let worldY = viewportY * mapSizeF;
                    
                    // Clamp to map bounds
                    let tileX = clamp(i32(floor(worldX)), 0, i32(mapSizeU) - 1);
                    let tileY = clamp(i32(floor(worldY)), 0, i32(mapSizeU) - 1);
                    
                    // Get tile ID from storage buffer
                    let tileIndex = u32(tileY) * mapSizeU + u32(tileX);
                    let tileId = tilemap[tileIndex];
                    
                    // Return hardcoded color based on tile ID (simplified pixel-art look)
                    // Tile ID 0-3 map to different terrain colors
                    var color: vec4<f32>;
                    
                    if (tileId == 0u) {
                        // Grass - Green
                        color = vec4<f32>(0.2, 0.8, 0.2, 1.0);
                    } else if (tileId == 1u) {
                        // Forest - Dark Green
                        color = vec4<f32>(0.1, 0.5, 0.1, 1.0);
                    } else if (tileId == 2u) {
                        // Water - Blue
                        color = vec4<f32>(0.2, 0.4, 0.9, 1.0);
                    } else if (tileId == 3u) {
                        // Mountain - Brown/Gray
                        color = vec4<f32>(0.5, 0.4, 0.3, 1.0);
                    } else {
                        // Unknown - Dark Gray
                        color = vec4<f32>(0.1, 0.1, 0.1, 1.0);
                    }
                    
                    return color;
                }
            `,
        });

        const pipelineLayout = this.device.createPipelineLayout({
            label: 'minimap-pipeline-layout',
            bindGroupLayouts: [this.minimapBindGroupLayout],
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

        // Store uniform buffer for later updates
        this.minimapUniformBuffer = minimapUniformBuffer;

        // Bind group will be created lazily when map data is available
        this.minimapBindGroup = null;
    }

    private minimapUniformBuffer: GPUBuffer | null = null;

    update(sabView: Float32Array, deltaTime: number): void {
        if (!this.device || !this.minimapUniformBuffer) return;

        // Update viewport position based on current screen size
        if (this.canvas && this.viewport) {
            const screenWidth = this.canvas.width || 800;
            const screenHeight = this.canvas.height || 600;
            this.viewport.x = screenWidth - MINIMAP_SIZE - MINIMAP_MARGIN;
            this.viewport.y = MINIMAP_MARGIN;
            this.viewport.width = MINIMAP_SIZE;
            this.viewport.height = MINIMAP_SIZE;
        }

        // Get map size from MapManager and update uniform with map size and viewport info
        const mapSize = this.mapManager.getMapSize();
        if (mapSize > 0 && this.viewport) {
            // Layout: mapSize (u32), viewportX (f32), viewportY (f32), viewportWidth (f32), viewportHeight (f32)
            const uniformData = new Float32Array(8); // 8 floats = 32 bytes
            uniformData[0] = mapSize; // u32 as f32 (will be cast in shader)
            uniformData[1] = this.viewport.x;
            uniformData[2] = this.viewport.y;
            uniformData[3] = this.viewport.width;
            uniformData[4] = this.viewport.height;
            uniformData[5] = 0.0; // padding
            uniformData[6] = 0.0; // padding
            uniformData[7] = 0.0; // padding

            this.device.queue.writeBuffer(this.minimapUniformBuffer, 0, uniformData.buffer);

            // Ensure bind group is created when map data is available
            this.ensureBindGroup();
        }
    }

    /**
     * Ensure bind group is created when map data is available
     */
    private ensureBindGroup(): void {
        if (!this.device || !this.minimapBindGroupLayout || this.minimapBindGroup) {
            return; // Already created or not ready
        }

        const storageBuffer = this.mapManager.getStorageBuffer();
        if (!storageBuffer || !this.minimapUniformBuffer) {
            return; // Map data not available yet
        }

        // Create bind group now that we have map data
        // Reuses the same storage buffer as WorldView (one source of truth)
        this.minimapBindGroup = this.device.createBindGroup({
            label: 'minimap-bind-group',
            layout: this.minimapBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: storageBuffer, // Reused from MapManager - shared with WorldView
                    },
                },
                {
                    binding: 1,
                    resource: {
                        buffer: this.minimapUniformBuffer,
                    },
                },
            ],
        });

        console.log('Victoriae [Worker Thread]: MinimapView bind group created with shared map data');
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
        if (!this.minimapBindGroup) {
            return pass?.encoder || null;
        }

        // Minimap always uses existing pass (never creates new one - it's an overlay)
        if (!pass) {
            throw new Error('MinimapView requires existing render pass');
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
        renderPass.setBindGroup(0, this.minimapBindGroup);
        renderPass.draw(3, 1, 0, 0);

        // Return existing pass for potential subsequent layers
        return renderPass;
    }
}
