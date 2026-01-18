/**
 * UnitRegistry - Manages game entities (units) on the main thread
 * 
 * This class stores units with gameplay fields and provides a sync system
 * to send only the visual representation data to the worker thread.
 * 
 * Usage example:
 * ```typescript
 * const registry = new UnitRegistry();
 * registry.addUnit({ id: 1, hp: 100, ownerId: 1, unitType: UnitType.WARRIOR, gridPos: { x: 10, y: 10 } });
 * registry.moveUnit(1, { x: 11, y: 10 });
 * const unitData = registry.syncToWorker(); // Get Float32Array for worker
 * worker.postMessage({ type: 'UPDATE_UNITS', unitData }, [unitData.buffer]);
 * ```
 */

/**
 * Unit type enumeration
 */
export enum UnitType {
    WARRIOR = 0,
    ARCHER = 1,
    CAVALRY = 2,
    SETTLER = 3,
}

/**
 * Grid position (tile coordinates)
 */
export interface GridPosition {
    x: number;
    y: number;
}

/**
 * Unit state flags (bitmask)
 */
export enum UnitState {
    NONE = 0,
    SELECTED = 1 << 0,      // Bit 0: Unit is selected
    MOVING = 1 << 1,        // Bit 1: Unit is currently moving
    ATTACKING = 1 << 2,     // Bit 2: Unit is attacking
    DEFENDING = 1 << 3,     // Bit 3: Unit is defending
    DAMAGED = 1 << 4,       // Bit 4: Unit is damaged (low HP)
}

/**
 * Unit object with gameplay fields
 */
export interface Unit {
    /** Unique unit identifier */
    id: number;
    
    /** Hit points (0 = dead) */
    hp: number;
    
    /** Maximum hit points */
    maxHp: number;
    
    /** Owner ID (0 = neutral, 1+ = player ID) */
    ownerId: number;
    
    /** Unit type (warrior, archer, etc.) */
    unitType: UnitType;
    
    /** Grid position (tile coordinates) */
    gridPos: GridPosition;
    
    /** Unit state flags (bitmask) */
    state: UnitState;
    
    /** Additional gameplay metadata */
    metadata?: Record<string, unknown>;
}

/**
 * UnitRegistry - Manages units and syncs them to the worker
 */
export class UnitRegistry {
    private units: Map<number, Unit>;
    private dirtyUnits: Set<number>;
    private nextUnitId: number;

    constructor() {
        this.units = new Map();
        this.dirtyUnits = new Set();
        this.nextUnitId = 1;
    }

    /**
     * Add a unit to the registry
     * @param unit - Unit to add (id will be auto-assigned if not provided)
     * @returns The unit ID
     */
    addUnit(unit: Partial<Unit> & { gridPos: GridPosition; unitType: UnitType }): number {
        const id = unit.id ?? this.nextUnitId++;
        
        const fullUnit: Unit = {
            id,
            hp: unit.hp ?? 100,
            maxHp: unit.maxHp ?? unit.hp ?? 100,
            ownerId: unit.ownerId ?? 0,
            unitType: unit.unitType,
            gridPos: unit.gridPos,
            state: unit.state ?? UnitState.NONE,
            metadata: unit.metadata,
        };

        this.units.set(id, fullUnit);
        this.dirtyUnits.add(id);
        
        return id;
    }

    /**
     * Remove a unit from the registry
     * @param id - Unit ID
     * @returns true if unit was removed, false if not found
     */
    removeUnit(id: number): boolean {
        const removed = this.units.delete(id);
        if (removed) {
            this.dirtyUnits.add(id); // Mark as dirty so worker knows to remove it
        }
        return removed;
    }

    /**
     * Get a unit by ID
     * @param id - Unit ID
     * @returns Unit or undefined if not found
     */
    getUnit(id: number): Unit | undefined {
        return this.units.get(id);
    }

    /**
     * Get all units
     * @returns Array of all units
     */
    getAllUnits(): Unit[] {
        return Array.from(this.units.values());
    }

    /**
     * Move a unit to a new grid position
     * @param id - Unit ID
     * @param newPos - New grid position
     * @returns true if unit was moved, false if not found
     */
    moveUnit(id: number, newPos: GridPosition): boolean {
        const unit = this.units.get(id);
        if (!unit) return false;

        // Only mark as dirty if position actually changed
        if (unit.gridPos.x !== newPos.x || unit.gridPos.y !== newPos.y) {
            unit.gridPos = { ...newPos };
            this.dirtyUnits.add(id);
        }

        return true;
    }

    /**
     * Update unit HP
     * @param id - Unit ID
     * @param hp - New HP value
     * @returns true if unit was updated, false if not found
     */
    setUnitHp(id: number, hp: number): boolean {
        const unit = this.units.get(id);
        if (!unit) return false;

        const oldHp = unit.hp;
        unit.hp = Math.max(0, Math.min(unit.maxHp, hp));

        // Mark as dirty if HP changed
        if (oldHp !== unit.hp) {
            this.dirtyUnits.add(id);
            
            // Update state flags based on HP
            if (unit.hp < unit.maxHp * 0.5) {
                unit.state |= UnitState.DAMAGED;
            } else {
                unit.state &= ~UnitState.DAMAGED;
            }
        }

        return true;
    }

    /**
     * Update unit state flags
     * @param id - Unit ID
     * @param state - State flags to set/clear
     * @param set - If true, set flags; if false, clear flags
     * @returns true if unit was updated, false if not found
     */
    setUnitState(id: number, state: UnitState, set: boolean = true): boolean {
        const unit = this.units.get(id);
        if (!unit) return false;

        const oldState = unit.state;
        if (set) {
            unit.state |= state;
        } else {
            unit.state &= ~state;
        }

        // Mark as dirty if state changed
        if (oldState !== unit.state) {
            this.dirtyUnits.add(id);
        }

        return true;
    }

    /**
     * Mark a unit as dirty (force sync on next syncToWorker call)
     * @param id - Unit ID
     */
    markDirty(id: number): void {
        this.dirtyUnits.add(id);
    }

    /**
     * Clear dirty flags (after successful sync)
     */
    clearDirty(): void {
        this.dirtyUnits.clear();
    }

    /**
     * Get all dirty unit IDs
     * @returns Set of dirty unit IDs
     */
    getDirtyUnits(): Set<number> {
        return new Set(this.dirtyUnits);
    }

    /**
     * Sync units to worker - creates a Float32Array with only the data the GPU needs
     * 
     * Format: [id, x, y, typeId, stateBits] per unit
     * - id: Unit ID (f32)
     * - x: Grid X position (f32)
     * - y: Grid Y position (f32)
     * - typeId: Unit type ID (f32, cast from UnitType enum)
     * - stateBits: State flags bitmask (f32, cast from UnitState enum)
     * 
     * The array can be transferred to the worker via postMessage using transferable objects.
     * 
     * @param onlyDirty - If true, only sync dirty units; if false, sync all units
     * @returns Float32Array containing unit data (5 floats per unit)
     */
    syncToWorker(onlyDirty: boolean = false): Float32Array {
        const unitsToSync = onlyDirty
            ? Array.from(this.dirtyUnits).map(id => this.units.get(id)).filter((u): u is Unit => u !== undefined)
            : Array.from(this.units.values());

        // Each unit takes 5 floats: [id, x, y, typeId, stateBits]
        const buffer = new Float32Array(unitsToSync.length * 5);

        for (let i = 0; i < unitsToSync.length; i++) {
            const unit = unitsToSync[i];
            const offset = i * 5;

            buffer[offset + 0] = unit.id;                    // id
            buffer[offset + 1] = unit.gridPos.x;             // x
            buffer[offset + 2] = unit.gridPos.y;             // y
            buffer[offset + 3] = unit.unitType;               // typeId
            buffer[offset + 4] = unit.state;                 // stateBits
        }

        return buffer;
    }

    /**
     * Get the number of units in the registry
     * @returns Number of units
     */
    getUnitCount(): number {
        return this.units.size;
    }

    /**
     * Check if a unit exists
     * @param id - Unit ID
     * @returns true if unit exists
     */
    hasUnit(id: number): boolean {
        return this.units.has(id);
    }

    /**
     * Get units at a specific grid position
     * @param pos - Grid position
     * @returns Array of units at that position
     */
    getUnitsAt(pos: GridPosition): Unit[] {
        return Array.from(this.units.values()).filter(
            unit => unit.gridPos.x === pos.x && unit.gridPos.y === pos.y
        );
    }

    /**
     * Get units owned by a specific player
     * @param ownerId - Owner ID
     * @returns Array of units owned by that player
     */
    getUnitsByOwner(ownerId: number): Unit[] {
        return Array.from(this.units.values()).filter(unit => unit.ownerId === ownerId);
    }
}
