import { SAB_SIZE } from '../shared/constants';
import RenderWorker from '../worker/render.worker?worker';

async function init() {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    if (!canvas) return;

    // 1. Transfer control to the OffscreenCanvas
    const offscreen = canvas.transferControlToOffscreen();

    // 2. Initialize SharedArrayBuffer for high-frequency data
    const sab = new SharedArrayBuffer(SAB_SIZE);

    // 3. Spawn Worker
    const worker = new RenderWorker();

    // 4. Send the canvas and memory bridge to the worker
    worker.postMessage({
        type: 'INIT',
        canvas: offscreen,
        sab: sab
    }, [offscreen]); // Canvas is a transferable object

    console.log("Victoriae: Client Orchestrator Initialized");
}

init();