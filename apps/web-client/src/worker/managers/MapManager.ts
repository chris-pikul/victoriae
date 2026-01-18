/**
 * MapManager - Manages tilemap data in the worker thread
 * 
 * This class is a passive listener that receives map data from the main thread
 * and manages the TypeGPU Storage Buffer used by the tilemap shader.
 * 
 * The worker no longer generates its own map data - it only receives and renders
 * what the main thread sends.
 */

/**
 * MapManager - Manages tilemap storage buffer
 */
export class MapManager {
    private device: GPUDevice | null = null;
    private tilemapStorageBuffer: GPUBuffer | null = null;
    private currentMapSize: number = 0;
    private currentTileData: Uint32Array | null = null;

    /**
     * Initialize the MapManager with a GPU device
     * @param device - GPU device from TypeGPU
     */
    init(device: GPUDevice): void {
        this.device = device;
        console.log('Victoriae [Worker Thread]: MapManager initialized');
    }

    /**
     * Update the tilemap data from main thread
     * @param tileData - Uint32Array of tile IDs from main thread
     * @param mapSize - Size of the map (width/height in tiles)
     */
    updateMapData(tileData: Uint32Array, mapSize: number): void {
        if (!this.device) {
            console.error('Victoriae [Worker Thread]: MapManager not initialized');
            return;
        }

        const tileCount = mapSize * mapSize;

        // Validate data size
        if (tileData.length !== tileCount) {
            console.error('Victoriae [Worker Thread]: Map data size mismatch', {
                received: tileData.length,
                expected: tileCount,
                mapSize
            });
            return;
        }

        // Store the current data
        this.currentTileData = tileData;
        this.currentMapSize = mapSize;

        // Check if we need to recreate the buffer (size changed or doesn't exist)
        const bufferSize = tileData.byteLength;
        const needsNewBuffer = !this.tilemapStorageBuffer || 
                              this.currentMapSize !== mapSize;

        if (needsNewBuffer) {
            // Destroy old buffer if it exists
            if (this.tilemapStorageBuffer) {
                this.tilemapStorageBuffer.destroy();
            }

            // Create new storage buffer
            this.tilemapStorageBuffer = this.device.createBuffer({
                label: 'tilemap-storage-buffer',
                size: bufferSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });

            console.log('Victoriae [Worker Thread]: MapManager created new storage buffer', {
                mapSize,
                tileCount,
                bufferSize
            });
        }

        // Update buffer with new data
        this.device.queue.writeBuffer(this.tilemapStorageBuffer, 0, tileData);

        console.log('Victoriae [Worker Thread]: MapManager updated tilemap data', {
            mapSize,
            tileCount,
            bufferSize
        });
    }

    /**
     * Get the tilemap storage buffer
     * @returns GPUBuffer or null if not initialized
     */
    getStorageBuffer(): GPUBuffer | null {
        return this.tilemapStorageBuffer;
    }

    /**
     * Get the current map size
     * @returns Map size (width/height in tiles)
     */
    getMapSize(): number {
        return this.currentMapSize;
    }

    /**
     * Get the current tile data (for debugging)
     * @returns Uint32Array or null if no data
     */
    getTileData(): Uint32Array | null {
        return this.currentTileData;
    }

    /**
     * Check if map data is available
     * @returns true if map data has been received
     */
    hasMapData(): boolean {
        return this.tilemapStorageBuffer !== null && this.currentTileData !== null;
    }
}
