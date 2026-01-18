import { SAB_SIZE, SAB_OFFSETS } from '../shared/constants';
import RenderWorker from '../worker/render.worker?worker';
import { setupInput } from './input';
import { WorldContainer } from './logic/WorldContainer';

function resizeCanvas(canvas: HTMLCanvasElement) {
    // Get device pixel ratio for crisp rendering on high-DPI displays
    const dpr = window.devicePixelRatio || 1;

    // Get display size (CSS pixels)
    const displayWidth = window.innerWidth;
    const displayHeight = window.innerHeight;

    // Set canvas internal resolution to match display size * device pixel ratio
    // This ensures crisp rendering on retina displays
    canvas.width = Math.floor(displayWidth * dpr);
    canvas.height = Math.floor(displayHeight * dpr);

    // Set canvas CSS size to match display size
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;

    return { width: canvas.width, height: canvas.height };
}

async function init() {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    if (!canvas) return;

    // Set initial canvas dimensions with proper resolution
    const { width, height } = resizeCanvas(canvas);

    // 1. Transfer control to the OffscreenCanvas
    const offscreen = canvas.transferControlToOffscreen();

    // 2. Initialize SharedArrayBuffer for high-frequency data
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const sabView = new Float32Array(sab);

    // Initialize default values
    // Center camera on the map (64x64 map, so center at 32, 32)
    // Zoom level 1.0 shows about 2 world units, so zoom of 0.1 shows 20 units (good for overview)
    sabView[SAB_OFFSETS.CAMERA_X] = 32.0; // Center of 64x64 map
    sabView[SAB_OFFSETS.CAMERA_Y] = 32.0; // Center of 64x64 map
    sabView[SAB_OFFSETS.CAMERA_ZOOM] = 0.1; // Zoom out to see more of the map
    sabView[SAB_OFFSETS.MOUSE_WORLD_X] = 0.0;
    sabView[SAB_OFFSETS.MOUSE_WORLD_Y] = 0.0;
    sabView[SAB_OFFSETS.SCREEN_WIDTH] = width;
    sabView[SAB_OFFSETS.SCREEN_HEIGHT] = height;
    sabView[SAB_OFFSETS.IS_MOUSE_DOWN] = 0.0;
    sabView[SAB_OFFSETS.CAPTURED_LAYER_ID] = -1.0; // -1 means no layer has captured input

    console.log('Victoriae [Main Thread]: SharedArrayBuffer created', {
        size: SAB_SIZE,
        viewLength: sabView.length,
        canvasSize: `${width}x${height}`
    });

    // 3. Create WorldContainer with random map data
    const worldContainer = new WorldContainer(64);
    console.log('Victoriae [Main Thread]: WorldContainer created with random 64x64 map');

    // 4. Spawn Worker
    const worker = new RenderWorker();

    // 5. Send the canvas and memory bridge to the worker
    console.log('Victoriae [Main Thread]: Sending INIT message to worker', {
        canvas: offscreen ? 'OffscreenCanvas transferred' : 'MISSING',
        sab: sab ? `SharedArrayBuffer (${SAB_SIZE} bytes)` : 'MISSING'
    });

    worker.postMessage({
        type: 'INIT',
        canvas: offscreen,
        sab: sab
    }, [offscreen]); // Canvas is a transferable object

    // 6. Setup input system (must be after SAB is initialized)
    setupInput(sab);
    console.log('Victoriae [Main Thread]: Input system initialized');

    // 7. Send map data to worker after initialization
    // The map data is generated in the WorldContainer constructor (random 64x64 grid)
    // We send it after a short delay to ensure the worker has processed the INIT message
    setTimeout(() => {
        // Get render data from WorldContainer (Translation Layer)
        const mapData = worldContainer.getRenderData();

        console.log('Victoriae [Main Thread]: Preparing to send map data to worker', {
            tileCount: mapData.length,
            bufferSize: mapData.buffer.byteLength,
            mapSize: worldContainer.getMapSize()
        });

        // Send with zero-copy transfer using transferable objects
        // The .buffer property is the underlying ArrayBuffer that can be transferred
        worker.postMessage({
            type: 'UPDATE_MAP',
            data: mapData
        }, [mapData.buffer]); // Transfer ArrayBuffer for zero-copy

        // IMPORTANT: After transfer, the mapData TypedArray is detached
        // The main thread should treat this buffer as 'gone' and create a new one for future updates
        console.log('Victoriae [Main Thread]: Map data transferred to worker (zero-copy, buffer is now detached)');
        console.log('Victoriae [Main Thread]: For future updates, call worldContainer.getRenderData() to create a new buffer');
    }, 100); // Small delay to ensure worker has processed INIT message

    // Handle window resize
    // Note: Cannot resize canvas after transferControlToOffscreen()
    // Must resize OffscreenCanvas from within the worker thread
    let resizeTimeout: number;
    window.addEventListener('resize', () => {
        // Debounce resize events
        clearTimeout(resizeTimeout);
        resizeTimeout = window.setTimeout(() => {
            // Calculate new dimensions (but don't set canvas.width/height - that's done in worker)
            const dpr = window.devicePixelRatio || 1;
            const displayWidth = window.innerWidth;
            const displayHeight = window.innerHeight;
            const newWidth = Math.floor(displayWidth * dpr);
            const newHeight = Math.floor(displayHeight * dpr);

            // Update CSS size (this is allowed even after transfer)
            canvas.style.width = `${displayWidth}px`;
            canvas.style.height = `${displayHeight}px`;

            // Update SAB with new dimensions
            sabView[SAB_OFFSETS.SCREEN_WIDTH] = newWidth;
            sabView[SAB_OFFSETS.SCREEN_HEIGHT] = newHeight;

            // Notify worker to resize the OffscreenCanvas
            worker.postMessage({
                type: 'RESIZE',
                width: newWidth,
                height: newHeight
            });
        }, 100);
    });

    console.log("Victoriae: Client Orchestrator Initialized");
    console.log(`Canvas resolution: ${width}x${height} (device pixel ratio: ${window.devicePixelRatio || 1})`);
}

init();