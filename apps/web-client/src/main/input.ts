import { SAB_OFFSETS } from '../shared/constants';

export function setupInput(sab: SharedArrayBuffer) {
    const view = new Float32Array(sab);

    // Track pressed keys for smooth movement
    const keysPressed = new Set<string>();

    // Pan speed in world units per second (will be scaled by deltaTime)
    const PAN_SPEED = 5.0; // Slower, more controlled panning

    // Zoom limits based on visible tiles
    const MAP_SIZE = 64; // Match the map size from render worker
    const MIN_VISIBLE_TILES = 4; // Minimum tiles visible (maximum zoom in)
    const MAX_VISIBLE_TILES = MAP_SIZE; // Maximum tiles visible (minimum zoom out - see entire map)

    // Helper function to convert screen coordinates to world coordinates
    // Matches the shader's coordinate transformation exactly
    function screenToWorld(screenX: number, screenY: number, camX: number, camY: number, zoom: number, screenWidth: number, screenHeight: number): [number, number] {
        // Convert screen pixel to NDC (-1 to 1) - matches shader exactly
        const ndcRawX = (screenX / screenWidth) * 2.0 - 1.0;
        const ndcRawY = (screenY / screenHeight) * 2.0 - 1.0;
        // Flip Y axis (matches shader: ndc.y = -ndcRaw.y)
        const ndcX = ndcRawX;
        const ndcY = -ndcRawY;

        // Calculate world position - matches shader exactly
        const aspectRatio = screenWidth / screenHeight;
        const worldSizeY = 2.0 / zoom;
        const worldSizeX = worldSizeY * aspectRatio;

        const worldX = ndcX * (worldSizeX * 0.5) + camX;
        const worldY = ndcY * (worldSizeY * 0.5) + camY;

        return [worldX, worldY];
    }

    // Helper function to calculate zoom limits based on visible tiles
    function calculateZoomLimits(screenWidth: number, screenHeight: number, mapSize: number, minTiles: number, maxTiles: number): [number, number] {
        const aspectRatio = screenWidth / screenHeight;

        // Calculate zoom based on visible tiles
        // worldSizeY = 2.0 / zoom, so zoom = 2.0 / worldSizeY
        // worldSizeX = worldSizeY * aspectRatio

        // Maximum zoom (most zoomed in): show at least minTiles
        // We want worldSizeY >= minTiles (so we see at least minTiles vertically)
        // Since worldSizeX = worldSizeY * aspectRatio, if aspectRatio > 1, we'll see more horizontally
        // To ensure we see at least minTiles in both directions, use minTiles for the smaller dimension
        // If aspectRatio > 1 (wider), Y is smaller, so worldSizeY = minTiles
        // If aspectRatio < 1 (taller), X is smaller, so worldSizeX = minTiles, meaning worldSizeY = minTiles / aspectRatio
        const maxZoomWorldSizeY = aspectRatio >= 1 ? minTiles : minTiles / aspectRatio;
        const maxZoom = 2.0 / maxZoomWorldSizeY;

        // Minimum zoom (most zoomed out): show at most maxTiles
        // We want worldSizeY <= maxTiles (so we see at most maxTiles vertically)
        // Since worldSizeX = worldSizeY * aspectRatio, if aspectRatio > 1, we'll see more horizontally
        // To ensure we see at most maxTiles in both directions, use maxTiles for the larger dimension
        // If aspectRatio > 1 (wider), X is larger, so worldSizeX = maxTiles, meaning worldSizeY = maxTiles / aspectRatio
        // If aspectRatio < 1 (taller), Y is larger, so worldSizeY = maxTiles
        const minZoomWorldSizeY = aspectRatio >= 1 ? maxTiles / aspectRatio : maxTiles;
        const minZoom = 2.0 / minZoomWorldSizeY;

        return [minZoom, maxZoom];
    }

    // Helper function to clamp camera position to keep viewport within map bounds
    function clampCameraToBounds(camX: number, camY: number, zoom: number, screenWidth: number, screenHeight: number, mapSize: number): [number, number] {
        // Calculate viewport size in world space
        const aspectRatio = screenWidth / screenHeight;
        const worldSizeY = 2.0 / zoom;
        const worldSizeX = worldSizeY * aspectRatio;

        // Calculate half-sizes for clamping
        const halfWorldSizeX = worldSizeX * 0.5;
        const halfWorldSizeY = worldSizeY * 0.5;

        // Clamp camera position so viewport stays within map bounds [0, mapSize]
        // Left edge: camX - halfWorldSizeX >= 0  => camX >= halfWorldSizeX
        // Right edge: camX + halfWorldSizeX <= mapSize => camX <= mapSize - halfWorldSizeX
        // Bottom edge: camY - halfWorldSizeY >= 0 => camY >= halfWorldSizeY
        // Top edge: camY + halfWorldSizeY <= mapSize => camY <= mapSize - halfWorldSizeY

        // Handle case where viewport is larger than map (shouldn't happen with proper zoom limits, but safety check)
        const clampedX = halfWorldSizeX >= mapSize
            ? mapSize * 0.5 // Center if viewport is larger than map
            : Math.max(halfWorldSizeX, Math.min(mapSize - halfWorldSizeX, camX));
        const clampedY = halfWorldSizeY >= mapSize
            ? mapSize * 0.5 // Center if viewport is larger than map
            : Math.max(halfWorldSizeY, Math.min(mapSize - halfWorldSizeY, camY));

        return [clampedX, clampedY];
    }

    // Track mouse position (screen coordinates)
    window.addEventListener('mousemove', (e) => {
        view[SAB_OFFSETS.MOUSE_WORLD_X] = e.clientX;
        view[SAB_OFFSETS.MOUSE_WORLD_Y] = e.clientY;
    });

    // Zoom at mouse position (zoom-to-cursor)
    window.addEventListener('wheel', (e) => {
        e.preventDefault();

        const currentZoom = view[SAB_OFFSETS.CAMERA_ZOOM];
        const currentCamX = view[SAB_OFFSETS.CAMERA_X];
        const currentCamY = view[SAB_OFFSETS.CAMERA_Y];
        const screenWidth = view[SAB_OFFSETS.SCREEN_WIDTH];
        const screenHeight = view[SAB_OFFSETS.SCREEN_HEIGHT];
        const mouseScreenX = view[SAB_OFFSETS.MOUSE_WORLD_X];
        const mouseScreenY = view[SAB_OFFSETS.MOUSE_WORLD_Y];

        // Calculate world position under mouse before zoom
        const [worldX, worldY] = screenToWorld(
            mouseScreenX, mouseScreenY,
            currentCamX, currentCamY, currentZoom,
            screenWidth, screenHeight
        );

        // Calculate zoom limits based on visible tiles
        const [minZoom, maxZoom] = calculateZoomLimits(screenWidth, screenHeight, MAP_SIZE, MIN_VISIBLE_TILES, MAX_VISIBLE_TILES);

        // Calculate new zoom (clamped to limits)
        const zoomDelta = e.deltaY * -0.001;
        let newZoom = Math.max(minZoom, Math.min(maxZoom, currentZoom + zoomDelta));

        // Calculate new camera position to keep the same world point under the mouse
        // Use the same NDC calculation as the shader
        const ndcRawX = (mouseScreenX / screenWidth) * 2.0 - 1.0;
        const ndcRawY = (mouseScreenY / screenHeight) * 2.0 - 1.0;
        const ndcX = ndcRawX;
        const ndcY = -ndcRawY; // Flip Y to match shader

        const aspectRatio = screenWidth / screenHeight;
        const newWorldSizeY = 2.0 / newZoom;
        const newWorldSizeX = newWorldSizeY * aspectRatio;

        // Calculate new camera position so the same world point stays under the mouse
        // worldPos = ndc * (worldSize * 0.5) + camera.pos
        // Therefore: camera.pos = worldPos - ndc * (worldSize * 0.5)
        let newCamX = worldX - ndcX * (newWorldSizeX * 0.5);
        let newCamY = worldY - ndcY * (newWorldSizeY * 0.5);

        // Clamp camera to map bounds after zoom
        [newCamX, newCamY] = clampCameraToBounds(newCamX, newCamY, newZoom, screenWidth, screenHeight, MAP_SIZE);

        // Update SAB
        view[SAB_OFFSETS.CAMERA_X] = newCamX;
        view[SAB_OFFSETS.CAMERA_Y] = newCamY;
        view[SAB_OFFSETS.CAMERA_ZOOM] = newZoom;
    }, { passive: false });

    // Keyboard arrow keys for panning
    window.addEventListener('keydown', (e) => {
        // Only handle arrow keys
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            keysPressed.add(e.key);
        }
    });

    window.addEventListener('keyup', (e) => {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            keysPressed.delete(e.key);
        }
    });

    // Pan camera using arrow keys (called every frame)
    // This uses requestAnimationFrame to provide smooth movement
    let lastPanTime = performance.now();
    const panLoop = () => {
        const now = performance.now();
        const deltaTime = (now - lastPanTime) / 1000; // Convert to seconds
        lastPanTime = now;

        // Calculate pan delta based on pressed keys
        let panX = 0;
        let panY = 0;

        if (keysPressed.has('ArrowLeft')) panX -= 1;
        if (keysPressed.has('ArrowRight')) panX += 1;
        if (keysPressed.has('ArrowUp')) panY += 1;
        if (keysPressed.has('ArrowDown')) panY -= 1;

        // Apply pan if any keys are pressed
        if (panX !== 0 || panY !== 0) {
            // Get current camera state
            const currentCamX = view[SAB_OFFSETS.CAMERA_X];
            const currentCamY = view[SAB_OFFSETS.CAMERA_Y];
            const zoom = view[SAB_OFFSETS.CAMERA_ZOOM];
            const screenWidth = view[SAB_OFFSETS.SCREEN_WIDTH];
            const screenHeight = view[SAB_OFFSETS.SCREEN_HEIGHT];

            // Calculate pan delta in world units per second
            // Scale by deltaTime for frame-rate independent movement
            // Scale by zoom level so panning feels consistent at different zoom levels
            const zoomMultiplier = 1.0 / zoom; // Pan faster when zoomed out
            const panDeltaX = panX * PAN_SPEED * deltaTime * zoomMultiplier;
            const panDeltaY = panY * PAN_SPEED * deltaTime * zoomMultiplier;

            // Calculate new camera position
            let newCamX = currentCamX + panDeltaX;
            let newCamY = currentCamY + panDeltaY;

            // Clamp camera to map bounds
            [newCamX, newCamY] = clampCameraToBounds(newCamX, newCamY, zoom, screenWidth, screenHeight, MAP_SIZE);

            // Update SAB
            view[SAB_OFFSETS.CAMERA_X] = newCamX;
            view[SAB_OFFSETS.CAMERA_Y] = newCamY;
        }

        requestAnimationFrame(panLoop);
    };

    // Start the pan loop
    panLoop();

    // Track mouse down state
    window.addEventListener('mousedown', (e) => {
        if (e.button === 0) { // Left mouse button
            view[SAB_OFFSETS.IS_MOUSE_DOWN] = 1.0;
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (e.button === 0) { // Left mouse button
            view[SAB_OFFSETS.IS_MOUSE_DOWN] = 0.0;
        }
    });
}