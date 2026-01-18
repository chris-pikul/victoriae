import tgpu from 'typegpu';
import { ViewManager } from './viewManager';
import { WorldLayer } from './views/worldLayer';
import { TestOverlayLayer } from './views/testOverlayLayer';
import { MinimapView } from './views/MinimapView';
import { MapManager } from './managers/MapManager';
import type { TgpuContext } from './types';

let canvas: OffscreenCanvas;
let sabView: Float32Array;
let root: any;
let device: GPUDevice;
let context: GPUCanvasContext;
let format: GPUTextureFormat;
let viewManager: ViewManager;
let mapManager: MapManager;
let gpuContext: TgpuContext | null = null;

self.onmessage = async (e: MessageEvent) => {
    const { type, canvas: receivedCanvas, sab, width, height, data } = e.data;

    if (type === 'INIT') {
        console.log('Victoriae [Worker Thread]: Received INIT message', {
            canvas: receivedCanvas ? `OffscreenCanvas (${receivedCanvas.width}x${receivedCanvas.height})` : 'MISSING',
            sab: sab ? `SharedArrayBuffer (${sab.byteLength} bytes)` : 'MISSING'
        });

        if (!receivedCanvas) {
            console.error('Victoriae [Worker Thread]: ERROR - No canvas received in INIT message');
            return;
        }

        if (!sab) {
            console.error('Victoriae [Worker Thread]: ERROR - No SharedArrayBuffer received in INIT message');
            return;
        }

        canvas = receivedCanvas;
        sabView = new Float32Array(sab);

        console.log('Victoriae [Worker Thread]: Canvas and SAB stored, starting rendering...');
        await startRendering();
    } else if (type === 'RESIZE') {
        // Resize the OffscreenCanvas (this must be done in the worker thread)
        // The screen dimensions are already updated in the SAB by the main thread
        if (width && height) {
            canvas.width = width;
            canvas.height = height;

            // Reconfigure the WebGPU context to match new canvas size
            // This ensures the context uses the correct resolution
            if (context) {
                context.configure({
                    device: device,
                    format: format,
                    alphaMode: 'opaque',
                });
            }
        }
    } else if (type === 'UPDATE_MAP') {
        // Receive map data from main thread (zero-copy transfer)
        console.log('Victoriae [Worker Thread]: Received UPDATE_MAP message', {
            data: data ? `Uint32Array (${data.length} elements)` : 'MISSING'
        });

        if (!data || !(data instanceof Uint32Array)) {
            console.error('Victoriae [Worker Thread]: ERROR - Invalid map data received');
            return;
        }

        // Calculate map size from data length (assuming square map)
        const mapSize = Math.sqrt(data.length);
        if (!Number.isInteger(mapSize)) {
            console.error('Victoriae [Worker Thread]: ERROR - Invalid map size (not a perfect square)', {
                tileCount: data.length
            });
            return;
        }

        // Update MapManager with new data
        if (mapManager) {
            mapManager.updateMapData(data, mapSize);
            console.log('Victoriae [Worker Thread]: MapManager updated with new map data', {
                mapSize,
                tileCount: data.length
            });
        } else {
            console.warn('Victoriae [Worker Thread]: MapManager not initialized yet, storing data for later');
            // Store data temporarily if MapManager isn't ready
            // This shouldn't happen in normal flow, but handle gracefully
        }
    }
};

async function startRendering() {
    console.log('Victoriae [Worker Thread]: Initializing TypeGPU...');

    // Initialize TypeGPU root context - this creates the GPU device
    root = await tgpu.init();
    device = root.device;

    console.log('Victoriae [Worker Thread]: TypeGPU initialized, GPU device:', device);

    // Get WebGPU context from OffscreenCanvas and configure it with TypeGPU's device
    context = canvas.getContext('webgpu') as GPUCanvasContext;
    if (!context) {
        console.error('Victoriae [Worker Thread]: ERROR - Failed to get WebGPU context from OffscreenCanvas');
        throw new Error('Failed to get WebGPU context from OffscreenCanvas');
    }

    format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device: device,
        format: format,
        alphaMode: 'opaque',
    });

    console.log('Victoriae [Worker Thread]: WebGPU context configured', {
        format: format,
        canvasSize: `${canvas.width}x${canvas.height}`
    });

    // Initialize MapManager (passive listener for map data)
    mapManager = new MapManager();
    mapManager.init(device);

    // Create GPU context for layers
    gpuContext = {
        root,
        device,
        canvas,
        context,
        format,
    };

    // Initialize ViewManager
    viewManager = new ViewManager();
    viewManager.init(gpuContext);

    // Add the base WorldLayer (renders the tilemap) - uses MapManager
    viewManager.add(new WorldLayer(mapManager));

    // Add the MinimapView (renders simplified overview in top-right corner) - uses MapManager
    // Added at higher index so it renders as an overlay above WorldLayer
    viewManager.add(new MinimapView(mapManager));

    // Add the test overlay layer (demonstrates layered composition)
    // viewManager.add(new TestOverlayLayer()); // Commented out for now

    console.log('Victoriae [Worker Thread]: ViewManager initialized, starting render loop...');

    // Start render loop
    let lastFrameTime = performance.now();
    let frameCount = 0;
    const frame = () => {
        const now = performance.now();
        const deltaTime = (now - lastFrameTime) / 1000; // Convert to seconds
        lastFrameTime = now;

        // Update all visible layers
        viewManager.update(sabView, deltaTime);

        // Get current texture view
        const textureView = context.getCurrentTexture().createView();

        // Create single command encoder for the frame
        const commandEncoder = device.createCommandEncoder();

        // Get screen dimensions from canvas
        const screenWidth = canvas.width || 800;
        const screenHeight = canvas.height || 600;

        // Render all visible layers (uses single command encoder)
        viewManager.render(commandEncoder, textureView, screenWidth, screenHeight);

        // Submit commands
        device.queue.submit([commandEncoder.finish()]);

        // Log first frame to confirm pipeline is active
        frameCount++;
        if (frameCount === 1) {
            console.log('Victoriae [Worker Thread]: First frame rendered - pipeline is active!');
        }

        requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
}