import type { VictoriaeLayer, TgpuContext, TgpuRenderPass, Viewport } from '../types';

/**
 * Test overlay layer - renders a simple colored rectangle overlay
 * Demonstrates layered composition
 */
export class TestOverlayLayer implements VictoriaeLayer {
    layerId: number = -1; // Will be assigned by ViewManager
    visible: boolean = true;
    viewport: Viewport | null = null; // Full screen - no viewport restriction
    
    private device: GPUDevice | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private format: GPUTextureFormat | null = null;

    init(context: TgpuContext): void {
        this.device = context.device;
        this.format = context.format;

        // Create a simple shader for the overlay
        const shaderModule = this.device.createShaderModule({
            label: 'overlay-shader',
            code: `
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
                    // Draw a semi-transparent red overlay in the top-right corner
                    // This is a simple test to show overlay composition
                    let screenPos = fragCoord.xy;
                    let screenSize = vec2<f32>(800.0, 600.0); // Approximate, could be passed as uniform
                    
                    // Calculate if we're in the top-right quadrant
                    let ndc = (screenPos / screenSize) * 2.0 - 1.0;
                    let inTopRight = ndc.x > 0.0 && ndc.y > 0.0;
                    
                    if (inTopRight) {
                        // Semi-transparent red overlay
                        return vec4<f32>(1.0, 0.0, 0.0, 0.3);
                    }
                    
                    // Transparent elsewhere (don't draw)
                    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
                }
            `,
        });

        this.pipeline = this.device.createRenderPipeline({
            label: 'overlay-pipeline',
            layout: 'auto',
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format!,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                        },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });
    }

    update(sabView: Float32Array, deltaTime: number): void {
        // Test overlay doesn't need updates
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

        // Overlay always uses existing pass (never creates new one)
        if (!pass) {
            throw new Error('Overlay layer requires existing render pass');
        }

        const renderPass = pass.encoder;

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

        // Draw overlay
        renderPass.setPipeline(this.pipeline);
        renderPass.draw(3, 1, 0, 0);

        // Return existing pass for potential subsequent layers
        return renderPass;
    }
}
