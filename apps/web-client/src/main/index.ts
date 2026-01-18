import { SAB_SIZE, SAB_OFFSETS } from '../shared/constants';
import RenderWorker from '../worker/render.worker?worker';
import { setupInput } from './input';
import { WorldContainer } from './logic/WorldContainer';
import { UnitRegistry, UnitType, UnitState } from './logic/UnitRegistry';

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
    sabView[SAB_OFFSETS.HOVERED_TILE_X] = -1.0; // -1 means no tile hovered
    sabView[SAB_OFFSETS.HOVERED_TILE_Y] = -1.0; // -1 means no tile hovered

    console.log('Victoriae [Main Thread]: SharedArrayBuffer created', {
        size: SAB_SIZE,
        viewLength: sabView.length,
        canvasSize: `${width}x${height}`
    });

    // 3. Create WorldContainer with random map data
    const worldContainer = new WorldContainer(64);
    console.log('Victoriae [Main Thread]: WorldContainer created with random 64x64 map');

    // 3.5. Create UnitRegistry for managing units
    const unitRegistry = new UnitRegistry();
    console.log('Victoriae [Main Thread]: UnitRegistry created');

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

    // 6.5. Setup debug input for unit creation (press 'U' to create unit at mouse position)
    setupDebugInput(sab, unitRegistry, worker);
    console.log('Victoriae [Main Thread]: Debug input initialized (press U to create unit at mouse)');

    // 6.6. Setup click handler for unit selection
    setupUnitSelection(sab, unitRegistry, worker);
    console.log('Victoriae [Main Thread]: Unit selection system initialized');

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

        // 8. Send initial unit data to worker (test unit)
        // Add a test unit to demonstrate the system
        setTimeout(() => {
            // Add a test unit at tile (10, 10)
            const unitId = unitRegistry.addUnit({
                unitType: UnitType.WARRIOR,
                gridPos: { x: 10, y: 10 },
                hp: 100,
                ownerId: 1
            });
            console.log('Victoriae [Main Thread]: Added test unit', { unitId, pos: { x: 10, y: 10 } });

            // Sync units to worker
            const unitData = unitRegistry.syncUnits(); // Get Float32Array [x, y, typeId, state] per unit
            const unitCount = unitRegistry.getUnitCount();

            console.log('Victoriae [Main Thread]: Preparing to send unit data to worker', {
                unitCount,
                dataSize: unitData.length,
                bufferSize: unitData.buffer.byteLength
            });

            // Send with zero-copy transfer using transferable objects
            worker.postMessage({
                type: 'UPDATE_UNITS',
                unitData: unitData,
                unitCount: unitCount
            }, [unitData.buffer]); // Transfer ArrayBuffer for zero-copy

            console.log('Victoriae [Main Thread]: Unit data transferred to worker (zero-copy, buffer is now detached)');
        }, 200); // Small delay after map data is sent
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

/**
 * Setup debug input for unit creation
 * Press 'U' key to create a test unit at the mouse's world position
 */
function setupDebugInput(
    sab: SharedArrayBuffer,
    unitRegistry: UnitRegistry,
    worker: Worker
): void {
    const view = new Float32Array(sab);
    const MAP_SIZE = 64;

    // Helper function to convert screen coordinates to world coordinates
    function screenToWorld(screenX: number, screenY: number, camX: number, camY: number, zoom: number, screenWidth: number, screenHeight: number): [number, number] {
        // Convert screen pixel to NDC (-1 to 1)
        const ndcRawX = (screenX / screenWidth) * 2.0 - 1.0;
        const ndcRawY = (screenY / screenHeight) * 2.0 - 1.0;
        // Flip Y axis
        const ndcX = ndcRawX;
        const ndcY = -ndcRawY;

        // Calculate world position
        const aspectRatio = screenWidth / screenHeight;
        const worldSizeY = 2.0 / zoom;
        const worldSizeX = worldSizeY * aspectRatio;

        const worldX = ndcX * (worldSizeX * 0.5) + camX;
        const worldY = ndcY * (worldSizeY * 0.5) + camY;

        return [worldX, worldY];
    }

    // Listen for 'U' key press to create unit at mouse position
    window.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() === 'u') {
            e.preventDefault();

            // Get current camera state
            const camX = view[SAB_OFFSETS.CAMERA_X];
            const camY = view[SAB_OFFSETS.CAMERA_Y];
            const zoom = view[SAB_OFFSETS.CAMERA_ZOOM];
            const screenWidth = view[SAB_OFFSETS.SCREEN_WIDTH];
            const screenHeight = view[SAB_OFFSETS.SCREEN_HEIGHT];

            // Get mouse position (in screen pixels, but need to account for devicePixelRatio)
            // The mouse position stored in SAB is already in canvas pixels (devicePixelRatio applied)
            const mouseScreenX = view[SAB_OFFSETS.MOUSE_WORLD_X];
            const mouseScreenY = view[SAB_OFFSETS.MOUSE_WORLD_Y];

            // Convert screen coordinates to world coordinates
            const [worldX, worldY] = screenToWorld(
                mouseScreenX,
                mouseScreenY,
                camX,
                camY,
                zoom,
                screenWidth,
                screenHeight
            );

            // Convert world coordinates to tile coordinates (floor to get tile)
            const tileX = Math.floor(worldX);
            const tileY = Math.floor(worldY);

            // Clamp to map bounds
            const clampedX = Math.max(0, Math.min(MAP_SIZE - 1, tileX));
            const clampedY = Math.max(0, Math.min(MAP_SIZE - 1, tileY));

            // Create a test unit at this tile position
            // Cycle through unit types for variety
            const unitCount = unitRegistry.getUnitCount();
            const unitType = (unitCount % 4) as UnitType; // Cycle through 4 unit types

            const unitId = unitRegistry.addUnit({
                unitType: unitType,
                gridPos: { x: clampedX, y: clampedY },
                hp: 100,
                ownerId: 1
            });

            console.log('Victoriae [Debug]: Created unit at mouse position', {
                unitId,
                tilePos: { x: clampedX, y: clampedY },
                worldPos: { x: worldX, y: worldY },
                mouseScreen: { x: mouseScreenX, y: mouseScreenY },
                unitType: UnitType[unitType]
            });

            // Sync units to worker
            const unitData = unitRegistry.syncUnits();
            const newUnitCount = unitRegistry.getUnitCount();

            // Send with zero-copy transfer
            worker.postMessage({
                type: 'UPDATE_UNITS',
                unitData: unitData,
                unitCount: newUnitCount
            }, [unitData.buffer]);

            console.log('Victoriae [Debug]: Unit data synced to worker', {
                unitCount: newUnitCount
            });
        }
    });
}

/**
 * Setup unit selection system
 * Click on a tile to select units at that tile position
 */
function setupUnitSelection(
    sab: SharedArrayBuffer,
    unitRegistry: UnitRegistry,
    worker: Worker
): void {
    const view = new Float32Array(sab);

    // Listen for mouse click events
    window.addEventListener('mousedown', (e) => {
        // Only handle left mouse button clicks
        if (e.button !== 0) return;

        // Check if input was captured by a layer (e.g., minimap)
        const capturedLayerId = view[SAB_OFFSETS.CAPTURED_LAYER_ID];
        if (capturedLayerId >= 0) {
            // Input was captured by a layer, don't process unit selection
            return;
        }

        // Small delay to ensure worker has calculated hovered tile
        setTimeout(() => {
            // Read hovered tile coordinates from SAB (calculated by worker)
            const tileX = Math.floor(view[SAB_OFFSETS.HOVERED_TILE_X]);
            const tileY = Math.floor(view[SAB_OFFSETS.HOVERED_TILE_Y]);

            // Check if tile coordinates are valid
            if (tileX < 0 || tileY < 0) {
                return; // Invalid tile coordinates
            }

            console.log('Victoriae [Selection]: Click detected at tile', { x: tileX, y: tileY });

            // Check if there are any selected units
            const selectedUnits = unitRegistry.getSelectedUnits();

            if (selectedUnits.length > 0) {
                // Unit is selected - check if clicking on a different tile
                const selectedUnit = selectedUnits[0];
                const currentTile = selectedUnit.gridPos;

                // Check if clicking on the same tile (just reselect)
                if (currentTile.x === tileX && currentTile.y === tileY) {
                    // Check if there's a unit at this tile to select
                    const unitsAtTile = unitRegistry.getUnitsAt({ x: tileX, y: tileY });
                    if (unitsAtTile.length > 0 && unitsAtTile[0].id !== selectedUnit.id) {
                        // Different unit at same tile - select it instead
                        unitRegistry.clearSelection();
                        unitRegistry.setUnitState(unitsAtTile[0].id, UnitState.SELECTED, true);

                        const unitData = unitRegistry.syncUnits();
                        const unitCount = unitRegistry.getUnitCount();
                        worker.postMessage({
                            type: 'UPDATE_UNITS',
                            unitData: unitData,
                            unitCount: unitCount
                        }, [unitData.buffer]);
                    }
                    return; // Same tile, no movement needed
                }

                // Unit is selected and clicking on a different tile - move the unit
                console.log('Victoriae [Movement]: Moving selected unit', {
                    unitId: selectedUnit.id,
                    from: { x: currentTile.x, y: currentTile.y },
                    to: { x: tileX, y: tileY }
                });

                // Calculate simple direct path (for now, just move directly)
                // TODO: Implement A* pathfinding later
                const targetPos = { x: tileX, y: tileY };

                // Move the unit
                unitRegistry.moveUnit(selectedUnit.id, targetPos);

                // Sync units to worker
                const unitData = unitRegistry.syncUnits();
                const unitCount = unitRegistry.getUnitCount();

                worker.postMessage({
                    type: 'UPDATE_UNITS',
                    unitData: unitData,
                    unitCount: unitCount
                }, [unitData.buffer]);

                console.log('Victoriae [Movement]: Unit moved and synced to worker');
                return;
            }

            // No unit selected - try to select a unit at this tile
            const unitsAtTile = unitRegistry.getUnitsAt({ x: tileX, y: tileY });

            if (unitsAtTile.length > 0) {
                // Select the first unit at this position
                const selectedUnit = unitsAtTile[0];

                // Clear previous selections
                unitRegistry.clearSelection();

                // Set this unit as selected
                unitRegistry.setUnitState(selectedUnit.id, UnitState.SELECTED, true);

                console.log('Victoriae [Selection]: Selected unit', {
                    unitId: selectedUnit.id,
                    unitType: UnitType[selectedUnit.unitType],
                    position: { x: tileX, y: tileY },
                    hp: selectedUnit.hp
                });

                // Sync units to worker to update visual state
                const unitData = unitRegistry.syncUnits();
                const unitCount = unitRegistry.getUnitCount();

                worker.postMessage({
                    type: 'UPDATE_UNITS',
                    unitData: unitData,
                    unitCount: unitCount
                }, [unitData.buffer]);
            } else {
                console.log('Victoriae [Selection]: No units at tile', { x: tileX, y: tileY });
                // Clear selection if clicking on empty tile
                unitRegistry.clearSelection();

                // Sync to clear visual selection
                const unitData = unitRegistry.syncUnits();
                const unitCount = unitRegistry.getUnitCount();

                worker.postMessage({
                    type: 'UPDATE_UNITS',
                    unitData: unitData,
                    unitCount: unitCount
                }, [unitData.buffer]);
            }
        }, 10); // Small delay to ensure worker has updated hovered tile
    });
}

init();