/**
 * EntityManager - Manages unit/entity data in the worker thread
 * 
 * This class is a passive listener that receives unit data from the main thread
 * and manages the TypeGPU Storage Buffer used for GPU instancing.
 * 
 * The worker no longer generates its own unit data - it only receives and renders
 * what the main thread sends.
 */

/**
 * EntityManager - Manages unit storage buffer for GPU instancing
 */
interface UnitInterpolationState {
    startX: number;
    startY: number;
    targetX: number;
    targetY: number;
    startTime: number;
}

export class EntityManager {
    private device: GPUDevice | null = null;
    private unitStorageBuffer: GPUBuffer | null = null;
    private currentUnitCount: number = 0;
    private currentUnitData: Float32Array | null = null;
    private bufferVersion: number = 0; // Increments when buffer is recreated
    
    // Interpolation state for smooth movement
    private interpolationStates: Map<number, UnitInterpolationState> = new Map();
    private interpolatedData: Float32Array | null = null;
    private readonly MOVE_DURATION = 0.3; // 300ms to move one tile

    /**
     * Initialize the EntityManager with a GPU device
     * @param device - GPU device from TypeGPU
     */
    init(device: GPUDevice): void {
        this.device = device;
        console.log('Victoriae [Worker Thread]: EntityManager initialized');
    }

    /**
     * Update the unit data from main thread
     * @param unitData - Float32Array of unit data from main thread
     * @param unitCount - Number of units
     */
    updateUnitData(unitData: Float32Array, unitCount: number): void {
        if (!this.device) {
            console.error('Victoriae [Worker Thread]: EntityManager not initialized');
            return;
        }

        // Validate data size
        // Format: [x, y, typeId, state] per unit = 4 floats per unit
        const expectedSize = unitCount * 4;
        if (unitData.length !== expectedSize) {
            console.error('Victoriae [Worker Thread]: Unit data size mismatch', {
                received: unitData.length,
                expected: expectedSize,
                unitCount
            });
            return;
        }

        // Check if we need to recreate the buffer (size changed or doesn't exist)
        // IMPORTANT: Check BEFORE updating currentUnitCount
        const bufferSize = unitData.byteLength;
        const needsNewBuffer = !this.unitStorageBuffer || 
                              this.currentUnitCount !== unitCount;

        // Detect position changes for interpolation
        if (this.currentUnitData && this.currentUnitCount === unitCount) {
            // Get current visual positions (interpolated if available, otherwise target)
            const currentVisualData = this.interpolatedData || this.currentUnitData;
            
            // Compare positions to detect movement
            for (let i = 0; i < unitCount; i++) {
                const offset = i * 4;
                // Use current visual position as start (interpolated if moving, otherwise target)
                const oldX = currentVisualData[offset + 0];
                const oldY = currentVisualData[offset + 1];
                const newX = unitData[offset + 0];
                const newY = unitData[offset + 1];
                
                // If position changed, start interpolation from current visual position
                if (oldX !== newX || oldY !== newY) {
                    this.interpolationStates.set(i, {
                        startX: oldX,
                        startY: oldY,
                        targetX: newX,
                        targetY: newY,
                        startTime: performance.now() / 1000.0 // Convert to seconds
                    });
                } else {
                    // Position didn't change, remove any active interpolation for this unit
                    this.interpolationStates.delete(i);
                }
            }
        }

        // Store the current data (after checking if we need a new buffer)
        this.currentUnitData = unitData;
        this.currentUnitCount = unitCount;

        if (needsNewBuffer) {
            // Don't destroy old buffer immediately - it might still be in use by the GPU
            // The old buffer will be garbage collected when no longer referenced
            // Instead, just create a new buffer and increment the version
            // This signals to layers that they need to recreate their bind groups

            // Create new storage buffer
            this.unitStorageBuffer = this.device.createBuffer({
                label: 'unit-storage-buffer',
                size: bufferSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });

            // Increment version to signal buffer change
            this.bufferVersion++;

            console.log('Victoriae [Worker Thread]: EntityManager created new storage buffer', {
                unitCount,
                bufferSize,
                bufferVersion: this.bufferVersion
            });
        }

        // If there are active interpolations, don't write immediately
        // The update() method will handle writing interpolated data every frame
        // If no interpolations, write immediately
        if (this.interpolationStates.size === 0) {
            this.device.queue.writeBuffer(this.unitStorageBuffer, 0, unitData);
        } else {
            // Start interpolation from current positions
            this.updateInterpolation();
            if (this.interpolatedData) {
                this.device.queue.writeBuffer(this.unitStorageBuffer, 0, this.interpolatedData);
            }
        }

        console.log('Victoriae [Worker Thread]: EntityManager updated unit data', {
            unitCount,
            bufferSize,
            activeInterpolations: this.interpolationStates.size
        });
    }

    /**
     * Update interpolation for smooth unit movement
     * Called every frame to interpolate positions
     */
    updateInterpolation(): void {
        if (!this.currentUnitData || this.interpolationStates.size === 0) {
            this.interpolatedData = null;
            return;
        }

        const currentTime = performance.now() / 1000.0; // Current time in seconds
        const interpolated = new Float32Array(this.currentUnitData);

        // Interpolate each unit that's moving
        for (const [unitIndex, state] of this.interpolationStates.entries()) {
            const elapsed = currentTime - state.startTime;
            const progress = Math.min(1.0, elapsed / this.MOVE_DURATION);

            // Linear interpolation (lerp)
            const x = state.startX + (state.targetX - state.startX) * progress;
            const y = state.startY + (state.targetY - state.startY) * progress;

            const offset = unitIndex * 4;
            interpolated[offset + 0] = x;
            interpolated[offset + 1] = y;
            // typeId and state remain unchanged
            interpolated[offset + 2] = this.currentUnitData[offset + 2];
            interpolated[offset + 3] = this.currentUnitData[offset + 3];

            // Remove completed interpolations
            if (progress >= 1.0) {
                this.interpolationStates.delete(unitIndex);
            }
        }

        this.interpolatedData = interpolated;
    }

    /**
     * Update interpolation and write to buffer
     * Should be called every frame for smooth movement
     */
    update(deltaTime: number): void {
        if (!this.device || !this.unitStorageBuffer || !this.currentUnitData) {
            return;
        }

        // Update interpolation
        this.updateInterpolation();

        // Write interpolated or original data to buffer
        const dataToWrite = this.interpolatedData || this.currentUnitData;
        this.device.queue.writeBuffer(this.unitStorageBuffer, 0, dataToWrite);
    }

    /**
     * Get the unit storage buffer
     * @returns GPUBuffer or null if not initialized
     */
    getStorageBuffer(): GPUBuffer | null {
        return this.unitStorageBuffer;
    }

    /**
     * Get the current unit count
     * @returns Number of units
     */
    getUnitCount(): number {
        return this.currentUnitCount;
    }

    /**
     * Get the current unit data (for debugging)
     * @returns Float32Array or null if no data
     */
    getUnitData(): Float32Array | null {
        return this.currentUnitData;
    }

    /**
     * Check if unit data is available
     * @returns true if unit data has been received
     */
    hasUnitData(): boolean {
        return this.unitStorageBuffer !== null && this.currentUnitData !== null;
    }

    /**
     * Get the current buffer version
     * Layers can use this to detect when the buffer has changed and recreate bind groups
     * @returns Current buffer version (increments when buffer is recreated)
     */
    getBufferVersion(): number {
        return this.bufferVersion;
    }
}
