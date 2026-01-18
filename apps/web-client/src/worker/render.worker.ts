import { SAB_OFFSETS } from '../shared/constants';
import tgpu from 'typegpu';

let canvas: OffscreenCanvas;
let sabView: Float32Array;
let root: any;
let device: GPUDevice;
let context: GPUCanvasContext;
let pipeline: GPURenderPipeline;
let format: GPUTextureFormat;

self.onmessage = async (e: MessageEvent) => {
    const { type, canvas: receivedCanvas, sab } = e.data;

    if (type === 'INIT') {
        canvas = receivedCanvas;
        sabView = new Float32Array(sab);
        await startRendering();
    }
};

async function startRendering() {
    // Initialize TypeGPU root context - this creates the GPU device
    root = await tgpu.init();
    device = root.device;
    
    // Get WebGPU context from OffscreenCanvas and configure it with TypeGPU's device
    context = canvas.getContext('webgpu') as GPUCanvasContext;
    if (!context) {
        throw new Error('Failed to get WebGPU context from OffscreenCanvas');
    }
    
    format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device: device,
        format: format,
        alphaMode: 'opaque',
    });
    
    console.log('Victoriae: TypeGPU Root Initialized');
    
    // Create shader module for triangle
    const shaderModule = device.createShaderModule({
        label: 'triangle-shader',
        code: `
            @vertex
            fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
                var positions = array<vec2<f32>, 3>(
                    vec2<f32>(0.0, 0.5),   // Top
                    vec2<f32>(-0.5, -0.5), // Bottom left
                    vec2<f32>(0.5, -0.5)   // Bottom right
                );
                let pos = positions[vertexIndex];
                return vec4<f32>(pos, 0.0, 1.0);
            }
            
            @fragment
            fn fs_main() -> @location(0) vec4<f32> {
                return vec4<f32>(0.2, 0.6, 1.0, 1.0); // Blue color
            }
        `,
    });
    
    // Create render pipeline
    pipeline = device.createRenderPipeline({
        label: 'triangle-pipeline',
        layout: 'auto',
        vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [{
                format: format,
            }],
        },
        primitive: {
            topology: 'triangle-list',
        },
    });
    
    // Start render loop
    const frame = () => {
        // Read from SharedArrayBuffer (for future camera/input usage)
        const camX = sabView[SAB_OFFSETS.CAMERA_X];
        
        // Get current texture view
        const textureView = context.getCurrentTexture().createView();
        
        // Create command encoder
        const commandEncoder = device.createCommandEncoder();
        
        // Begin render pass with dark grey clear color (#1a1a1a)
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.102, g: 0.102, b: 0.102, a: 1.0 }, // #1a1a1a
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        
        // Draw triangle
        renderPass.setPipeline(pipeline);
        renderPass.draw(3, 1, 0, 0);
        renderPass.end();
        
        // Submit commands
        device.queue.submit([commandEncoder.finish()]);
        
        requestAnimationFrame(frame);
    };
    
    requestAnimationFrame(frame);
}