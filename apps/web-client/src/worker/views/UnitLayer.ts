import type { VictoriaeLayer, TgpuContext, TgpuRenderPass, Viewport } from '../types';
import { SAB_OFFSETS } from '../../shared/constants';
import { EntityManager } from '../managers/EntityManager';
import { MapManager } from '../managers/MapManager';
import * as d from 'typegpu/data';

/**
 * UnitLayer - Renders units using GPU instancing
 * 
 * Uses a single 1x1 quad mesh and instancing to render all units in one draw call.
 * Each unit's position and type are read from the EntityManager storage buffer.
 */
export class UnitLayer implements VictoriaeLayer {
    layerId: number = -1; // Will be assigned by ViewManager
    visible: boolean = true;
    viewport: Viewport | null = null; // Full screen - no viewport restriction
    
    private device: GPUDevice | null = null;
    private entityManager: EntityManager;
    private mapManager: MapManager;
    private cameraUniformBuffer: GPUBuffer | null = null;
    private unitBindGroup: GPUBindGroup | null = null;
    private unitBindGroupLayout: GPUBindGroupLayout | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private canvas: OffscreenCanvas | null = null;
    private format: GPUTextureFormat | null = null;
    private lastBufferVersion: number = -1; // Track buffer version to detect changes

    constructor(entityManager: EntityManager, mapManager: MapManager) {
        this.entityManager = entityManager;
        this.mapManager = mapManager;
    }

    init(context: TgpuContext): void {
        this.device = context.device;
        this.canvas = context.canvas;
        this.format = context.format;

        // Define CameraUniform struct (same as WorldLayer)
        const CameraUniform = d.struct({
            pos: d.vec2f,
            zoom: d.f32,
            screenSize: d.vec2f,
        });

        // Create bind group layout for units
        this.unitBindGroupLayout = this.device.createBindGroupLayout({
            label: 'unit-bind-group-layout',
            entries: [
                {
                    binding: 0, // Camera uniform
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: {
                        type: 'uniform',
                    },
                },
                {
                    binding: 1, // Unit storage buffer (for instancing and fragment coloring)
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: {
                        type: 'read-only-storage',
                    },
                },
            ],
        });

        // Create uniform buffer for camera
        const uniformBufferSize = 32; // Aligned to 16 bytes
        this.cameraUniformBuffer = this.device.createBuffer({
            label: 'unit-camera-uniform-buffer',
            size: uniformBufferSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Create shader module for GPU instanced unit rendering
        const shaderModule = this.device.createShaderModule({
            label: 'unit-shader',
            code: `
                struct CameraUniform {
                    pos: vec2<f32>,
                    zoom: f32,
                    screenSize: vec2<f32>,
                };
                
                @group(0) @binding(0) var<uniform> camera: CameraUniform;
                @group(0) @binding(1) var<storage, read> units: array<f32>; // Flat array: [x, y, typeId, state] per unit
                
                // Unit quad size in world units (1 tile = 1 world unit)
                const UNIT_SIZE: f32 = 0.8; // Slightly smaller than a tile for visibility
                
                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) instanceIndex: f32, // Pass instance index to fragment shader
                    @location(1) quadUV: vec2<f32>, // Pass quad UV coordinates for border rendering
                };
                
                @vertex
                fn vs_main(
                    @builtin(vertex_index) vertexIndex: u32,
                    @builtin(instance_index) instanceIndex: u32
                ) -> VertexOutput {
                    // Get unit data for this instance
                    // Format: [x, y, typeId, state] per unit = 4 floats per unit
                    let unitOffset = instanceIndex * 4u;
                    let unitX = units[unitOffset + 0u];
                    let unitY = units[unitOffset + 1u];
                    // typeId and state are available but not needed in vertex shader
                    
                    // Create a 1x1 quad centered at origin
                    // For triangle-strip: vertices form two triangles
                    // Order: bottom-left, bottom-right, top-left, top-right
                    var quadPos = vec2<f32>(0.0, 0.0);
                    var quadUV = vec2<f32>(0.0, 0.0);
                    if (vertexIndex == 0u) {
                        quadPos = vec2<f32>(-0.5, -0.5); // bottom-left
                        quadUV = vec2<f32>(0.0, 0.0);
                    } else if (vertexIndex == 1u) {
                        quadPos = vec2<f32>(0.5, -0.5);  // bottom-right
                        quadUV = vec2<f32>(1.0, 0.0);
                    } else if (vertexIndex == 2u) {
                        quadPos = vec2<f32>(-0.5, 0.5);  // top-left
                        quadUV = vec2<f32>(0.0, 1.0);
                    } else if (vertexIndex == 3u) {
                        quadPos = vec2<f32>(0.5, 0.5);   // top-right
                        quadUV = vec2<f32>(1.0, 1.0);
                    }
                    
                    // Scale quad to unit size
                    quadPos = quadPos * UNIT_SIZE;
                    
                    // Offset quad to unit's world position
                    // Units are positioned at tile centers (x + 0.5, y + 0.5)
                    let worldPos = vec2<f32>(unitX + 0.5, unitY + 0.5) + quadPos;
                    
                    // Transform world position to screen space using camera
                    let screenSize = camera.screenSize;
                    let zoom = max(camera.zoom, 0.001);
                    
                    // Calculate world-to-screen transformation (matches WorldLayer shader)
                    let aspectRatio = screenSize.x / screenSize.y;
                    let worldSizeY = 2.0 / zoom;
                    let worldSizeX = worldSizeY * aspectRatio;
                    
                    // Convert world position to NDC
                    // In WorldLayer: worldPos.y = ndc.y * (worldSizeY * 0.5) + camera.pos.y
                    // where ndc.y is already flipped (ndc.y = -ndcRaw.y)
                    // Therefore: ndc.y = (worldPos.y - camera.pos.y) / (worldSizeY * 0.5)
                    // Note: ndc.y is already the flipped value, so we don't flip it again
                    let worldOffset = worldPos - camera.pos;
                    let ndcX = worldOffset.x / (worldSizeX * 0.5);
                    let ndcY = worldOffset.y / (worldSizeY * 0.5);
                    
                    // ndcY is already the flipped value (matches WorldLayer's ndc.y)
                    let ndc = vec2<f32>(ndcX, ndcY);
                    
                    var output: VertexOutput;
                    output.position = vec4<f32>(ndc, 0.0, 1.0);
                    output.instanceIndex = f32(instanceIndex); // Pass to fragment shader
                    output.quadUV = quadUV; // Pass quad UV for border rendering
                    return output;
                }
                
                @fragment
                fn fs_main(
                    @location(0) instanceIndex: f32,
                    @location(1) quadUV: vec2<f32>
                ) -> @location(0) vec4<f32> {
                    // Get unit data for this instance
                    // Format: [x, y, typeId, state] per unit = 4 floats per unit
                    let unitOffset = u32(instanceIndex) * 4u;
                    let unitTypeId = units[unitOffset + 2u];
                    let unitState = units[unitOffset + 3u];
                    
                    // Check if unit is selected (bit 0 of state flags)
                    // UnitState.SELECTED = 1 << 0 = 1
                    let isSelected = (u32(unitState) & 1u) != 0u;
                    
                    // Return color based on unit type (simple placeholder colors)
                    var color: vec4<f32>;
                    
                    if (unitTypeId == 0.0) {
                        // Warrior - Red
                        color = vec4<f32>(1.0, 0.2, 0.2, 1.0);
                    } else if (unitTypeId == 1.0) {
                        // Archer - Green
                        color = vec4<f32>(0.2, 1.0, 0.2, 1.0);
                    } else if (unitTypeId == 2.0) {
                        // Cavalry - Blue
                        color = vec4<f32>(0.2, 0.2, 1.0, 1.0);
                    } else if (unitTypeId == 3.0) {
                        // Settler - Yellow
                        color = vec4<f32>(1.0, 1.0, 0.2, 1.0);
                    } else {
                        // Unknown - White
                        color = vec4<f32>(1.0, 1.0, 1.0, 1.0);
                    }
                    
                    // Apply visual indication for selected units
                    if (isSelected) {
                        // Brighten selected units
                        color = color * 1.3;
                        
                        // Add a bright border around selected units
                        let borderWidth = 0.15;
                        let isBorder = quadUV.x < borderWidth || quadUV.x > (1.0 - borderWidth) ||
                                      quadUV.y < borderWidth || quadUV.y > (1.0 - borderWidth);
                        if (isBorder) {
                            // Bright yellow/white border for selected units
                            color = vec4<f32>(1.0, 1.0, 0.5, 1.0);
                        }
                    } else {
                        // Slightly dim unselected units for contrast
                        color = color * 0.9;
                    }
                    
                    return color;
                }
            `,
        });

        const pipelineLayout = this.device.createPipelineLayout({
            label: 'unit-pipeline-layout',
            bindGroupLayouts: [this.unitBindGroupLayout],
        });

        this.pipeline = this.device.createRenderPipeline({
            label: 'unit-pipeline',
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
                topology: 'triangle-strip',
            },
        });

        // Bind group will be created lazily when unit data is available
        this.unitBindGroup = null;
    }

    update(sabView: Float32Array, deltaTime: number): void {
        if (!this.device || !this.cameraUniformBuffer || !this.canvas) return;

        // Read camera values from SharedArrayBuffer
        const camX = sabView[SAB_OFFSETS.CAMERA_X] || 0.0;
        const camY = sabView[SAB_OFFSETS.CAMERA_Y] || 0.0;
        const camZoom = sabView[SAB_OFFSETS.CAMERA_ZOOM] || 1.0;
        const screenWidth = this.canvas.width || 800;
        const screenHeight = this.canvas.height || 600;

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

        this.device.queue.writeBuffer(this.cameraUniformBuffer, 0, uniformData);

        // Update entity manager interpolation for smooth movement
        this.entityManager.update(deltaTime);

        // Update bind group if unit data is now available
        this.ensureBindGroup();
    }

    /**
     * Ensure bind group is created when unit data is available
     */
    private ensureBindGroup(): void {
        if (!this.device || !this.unitBindGroupLayout) {
            return; // Not ready
        }

        const storageBuffer = this.entityManager.getStorageBuffer();
        if (!storageBuffer || !this.cameraUniformBuffer) {
            return; // Unit data not available yet
        }

        // Check if buffer version changed - if so, invalidate bind group
        const currentBufferVersion = this.entityManager.getBufferVersion();
        if (currentBufferVersion !== this.lastBufferVersion) {
            // Buffer changed - invalidate old bind group
            this.unitBindGroup = null;
            this.lastBufferVersion = currentBufferVersion;
        }

        // Create bind group if it doesn't exist
        if (!this.unitBindGroup) {
            this.unitBindGroup = this.device.createBindGroup({
                label: 'unit-bind-group',
                layout: this.unitBindGroupLayout,
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: this.cameraUniformBuffer,
                        },
                    },
                    {
                        binding: 1,
                        resource: {
                            buffer: storageBuffer,
                        },
                    },
                ],
            });
            console.log('Victoriae [Worker Thread]: UnitLayer bind group created with unit data');
        }
    }

    render(
        pass: TgpuRenderPass | null,
        needsNewPass: boolean,
        textureView: GPUTextureView,
        commandEncoder: GPUCommandEncoder,
        screenWidth: number,
        screenHeight: number
    ): GPURenderPassEncoder | null {
        if (!this.pipeline) return pass?.encoder || null;

        // Ensure bind group exists (may be created lazily when unit data arrives)
        this.ensureBindGroup();

        // Skip rendering if unit data not available yet
        if (!this.unitBindGroup) {
            return pass?.encoder || null;
        }

        // Get unit count
        const unitCount = this.entityManager.getUnitCount();
        if (unitCount === 0) {
            return pass?.encoder || null; // No units to render
        }

        // Units always use existing pass (never creates new one - it's an overlay)
        if (!pass) {
            throw new Error('UnitLayer requires existing render pass');
        }

        const renderPass = pass.encoder;

        // Apply viewport scissoring if viewport is set
        if (this.viewport) {
            renderPass.setViewport(
                this.viewport.x,
                this.viewport.y,
                this.viewport.width,
                this.viewport.height,
                0.0,
                1.0
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

        // Draw all units using GPU instancing
        // Single quad (4 vertices) drawn once per unit (instanceCount)
        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.unitBindGroup);
        renderPass.draw(4, unitCount, 0, 0); // 4 vertices, unitCount instances

        // Return existing pass for potential subsequent layers
        return renderPass;
    }
}
