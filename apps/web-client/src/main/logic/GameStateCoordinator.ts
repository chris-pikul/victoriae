/**
 * GameStateCoordinator - Coordinates game state updates with the render worker
 * 
 * This class integrates WorldContainer, UnitRegistry, and WorkerBridge to ensure
 * that any game logic change triggers a coordinated update to the worker.
 * 
 * Usage example:
 * ```typescript
 * const coordinator = new GameStateCoordinator(worker, worldContainer, unitRegistry);
 * coordinator.syncAll(); // Sync both map and units
 * coordinator.syncMap(); // Sync only map
 * coordinator.syncUnits(); // Sync only units
 * ```
 */

import { WorkerBridge } from '../network/WorkerBridge';
import type { WorldContainer } from './WorldContainer';
import type { UnitRegistry } from './UnitRegistry';

/**
 * GameStateCoordinator - Coordinates game state synchronization
 */
export class GameStateCoordinator {
    private bridge: WorkerBridge;
    private world: WorldContainer;
    private units: UnitRegistry;
    private syncPending: boolean = false;
    private syncScheduled: number | null = null;

    /**
     * Create a new GameStateCoordinator
     * @param worker - The render worker instance
     * @param world - WorldContainer instance
     * @param units - UnitRegistry instance
     */
    constructor(worker: Worker, world: WorldContainer, units: UnitRegistry) {
        this.bridge = new WorkerBridge(worker);
        this.world = world;
        this.units = units;
    }

    /**
     * Sync the map to the worker (zero-copy transfer)
     * This is called automatically when the map changes, or can be called manually.
     */
    syncMap(): void {
        const renderBuffer = this.world.getRenderBuffer();
        const mapSize = this.world.getMapSize();
        
        // Use zero-copy transfer
        this.bridge.updateMap(renderBuffer, mapSize);
    }

    /**
     * Sync units to the worker (zero-copy transfer)
     * @param onlyDirty - If true, only sync dirty units; if false, sync all units
     */
    syncUnits(onlyDirty: boolean = false): void {
        const unitData = this.units.syncToWorker(onlyDirty);
        const unitCount = this.units.getUnitCount();
        
        // Use zero-copy transfer
        this.bridge.updateUnits(unitData, unitCount);
        
        // Clear dirty flags after successful sync
        if (onlyDirty) {
            this.units.clearDirty();
        }
    }

    /**
     * Sync both map and units to the worker
     * @param onlyDirtyUnits - If true, only sync dirty units; if false, sync all units
     */
    syncAll(onlyDirtyUnits: boolean = false): void {
        this.syncMap();
        this.syncUnits(onlyDirtyUnits);
    }

    /**
     * Schedule a sync for the next frame (debounced)
     * This is useful when multiple changes happen in quick succession.
     */
    scheduleSync(onlyDirtyUnits: boolean = false): void {
        this.syncPending = true;
        
        // Cancel any existing scheduled sync
        if (this.syncScheduled !== null) {
            cancelAnimationFrame(this.syncScheduled);
        }
        
        // Schedule sync for next frame
        this.syncScheduled = requestAnimationFrame(() => {
            if (this.syncPending) {
                this.syncAll(onlyDirtyUnits);
                this.syncPending = false;
            }
            this.syncScheduled = null;
        });
    }

    /**
     * Get the WorkerBridge instance
     * @returns The WorkerBridge instance
     */
    getBridge(): WorkerBridge {
        return this.bridge;
    }

    /**
     * Get the WorldContainer instance
     * @returns The WorldContainer instance
     */
    getWorld(): WorldContainer {
        return this.world;
    }

    /**
     * Get the UnitRegistry instance
     * @returns The UnitRegistry instance
     */
    getUnits(): UnitRegistry {
        return this.units;
    }
}
