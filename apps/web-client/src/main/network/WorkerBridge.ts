/**
 * WorkerBridge - Typed message bus for Main Thread <-> Worker communication
 * 
 * This class provides a typed interface for sending messages to the render worker,
 * ensuring zero-copy transfers using transferable objects.
 * 
 * Usage example:
 * ```typescript
 * const bridge = new WorkerBridge(worker);
 * bridge.updateMap(tileBuffer); // Zero-copy transfer
 * bridge.updateUnits(unitBuffer); // Zero-copy transfer
 * ```
 */

/**
 * Standard message types for worker communication
 */
export enum WorkerMessageType {
    /** Initialize the worker with canvas and SAB */
    INIT = 'INIT',
    
    /** Resize the canvas */
    RESIZE = 'RESIZE',
    
    /** Update the tilemap data */
    UPDATE_MAP = 'UPDATE_MAP',
    
    /** Update unit data */
    UPDATE_UNITS = 'UPDATE_UNITS',
    
    /** Set view state (layer visibility, etc.) */
    SET_VIEW_STATE = 'SET_VIEW_STATE',
}

/**
 * Base message interface
 */
interface BaseWorkerMessage {
    type: WorkerMessageType;
}

/**
 * INIT message - Initialize worker with canvas and SAB
 */
export interface InitMessage extends BaseWorkerMessage {
    type: WorkerMessageType.INIT;
    canvas: OffscreenCanvas;
    sab: SharedArrayBuffer;
}

/**
 * RESIZE message - Resize the canvas
 */
export interface ResizeMessage extends BaseWorkerMessage {
    type: WorkerMessageType.RESIZE;
    width: number;
    height: number;
}

/**
 * UPDATE_MAP message - Update tilemap data
 */
export interface UpdateMapMessage extends BaseWorkerMessage {
    type: WorkerMessageType.UPDATE_MAP;
    tileData: Uint32Array;
    mapSize: number;
}

/**
 * UPDATE_UNITS message - Update unit data
 */
export interface UpdateUnitsMessage extends BaseWorkerMessage {
    type: WorkerMessageType.UPDATE_UNITS;
    unitData: Float32Array;
    unitCount: number;
}

/**
 * View state configuration
 */
export interface ViewState {
    /** Layer visibility flags */
    layerVisibility?: Record<string, boolean>;
    
    /** Additional view state data */
    [key: string]: unknown;
}

/**
 * SET_VIEW_STATE message - Update view state
 */
export interface SetViewStateMessage extends BaseWorkerMessage {
    type: WorkerMessageType.SET_VIEW_STATE;
    state: ViewState;
}

/**
 * Union type of all worker messages
 */
export type WorkerMessage = 
    | InitMessage 
    | ResizeMessage 
    | UpdateMapMessage 
    | UpdateUnitsMessage 
    | SetViewStateMessage;

/**
 * WorkerBridge - Typed interface for worker communication
 */
export class WorkerBridge {
    private worker: Worker;

    /**
     * Create a new WorkerBridge
     * @param worker - The render worker instance
     */
    constructor(worker: Worker) {
        this.worker = worker;
    }

    /**
     * Send a message to the worker with transferable objects
     * @param message - Message to send
     * @param transferables - Array of transferable objects (ArrayBuffers, etc.)
     */
    private sendMessage(message: WorkerMessage, transferables: Transferable[] = []): void {
        this.worker.postMessage(message, transferables);
    }

    /**
     * Initialize the worker with canvas and SAB
     * @param canvas - OffscreenCanvas to transfer
     * @param sab - SharedArrayBuffer for high-frequency data
     */
    init(canvas: OffscreenCanvas, sab: SharedArrayBuffer): void {
        this.sendMessage(
            {
                type: WorkerMessageType.INIT,
                canvas,
                sab,
            },
            [canvas] // Canvas is transferable
        );
    }

    /**
     * Resize the canvas
     * @param width - New width in pixels
     * @param height - New height in pixels
     */
    resize(width: number, height: number): void {
        this.sendMessage({
            type: WorkerMessageType.RESIZE,
            width,
            height,
        });
    }

    /**
     * Update the tilemap data (zero-copy transfer)
     * @param tileData - Uint32Array of tile IDs
     * @param mapSize - Size of the map (width/height in tiles)
     */
    updateMap(tileData: Uint32Array, mapSize: number): void {
        // Transfer the underlying ArrayBuffer for zero-copy
        this.sendMessage(
            {
                type: WorkerMessageType.UPDATE_MAP,
                tileData,
                mapSize,
            },
            [tileData.buffer] // Transfer ArrayBuffer for zero-copy
        );
    }

    /**
     * Update unit data (zero-copy transfer)
     * @param unitData - Float32Array of unit data [id, x, y, typeId, stateBits] per unit
     * @param unitCount - Number of units
     */
    updateUnits(unitData: Float32Array, unitCount: number): void {
        // Transfer the underlying ArrayBuffer for zero-copy
        this.sendMessage(
            {
                type: WorkerMessageType.UPDATE_UNITS,
                unitData,
                unitCount,
            },
            [unitData.buffer] // Transfer ArrayBuffer for zero-copy
        );
    }

    /**
     * Set view state (layer visibility, etc.)
     * @param state - View state configuration
     */
    setViewState(state: ViewState): void {
        this.sendMessage({
            type: WorkerMessageType.SET_VIEW_STATE,
            state,
        });
    }

    /**
     * Get the underlying worker instance
     * @returns The worker instance
     */
    getWorker(): Worker {
        return this.worker;
    }
}
