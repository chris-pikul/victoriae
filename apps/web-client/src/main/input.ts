import { SAB_OFFSETS } from '../shared/constants';

export function setupInput(sab: SharedArrayBuffer) {
    const view = new Float32Array(sab);

    window.addEventListener('mousemove', (e) => {
        // We store raw screen coords; the worker will convert to world coords
        view[SAB_OFFSETS.MOUSE_WORLD_X] = e.clientX;
        view[SAB_OFFSETS.MOUSE_WORLD_Y] = e.clientY;
    });

    window.addEventListener('wheel', (e) => {
        // Simple zoom increment/decrement
        const zoomDelta = e.deltaY * -0.001;
        view[SAB_OFFSETS.CAMERA_ZOOM] = Math.max(0.1, Math.min(5, view[SAB_OFFSETS.CAMERA_ZOOM] + zoomDelta));
    }, { passive: true });
}