/**
 * WorldContainer - Centralized store for game world metadata
 * 
 * This class holds "Rich Metadata" for the game world (terrain types, building stats, ownership data)
 * and provides a translation layer to convert this metadata into render-ready tile IDs.
 * 
 * The renderer only sees raw tile IDs (Uint32Array), keeping the logic and rendering decoupled.
 * 
 * Usage example:
 * ```typescript
 * const world = new WorldContainer(64);
 * world.placeBuilding(10, 10, BuildingType.FARM, 2, 1); // Place level 2 farm at (10, 10)
 * world.setBuildingLevel(10, 10, 3); // Upgrade to level 3
 * const renderBuffer = world.getRenderBuffer(); // Get Uint32Array for renderer
 * worker.postMessage({ type: 'UPDATE_TILEMAP', tileData: renderBuffer }, [renderBuffer.buffer]);
 * ```
 */

const MAP_SIZE = 64; // 64x64 tile map

/**
 * Terrain types for tiles
 */
export enum TerrainType {
    GRASS = 0,
    FOREST = 1,
    WATER = 2,
    MOUNTAIN = 3,
}

/**
 * Building types that can be placed on tiles
 */
export enum BuildingType {
    NONE = 0,
    FARM = 1,
    MINE = 2,
    FORTRESS = 3,
}

/**
 * Tile metadata - rich game state information
 */
export interface TileMetadata {
    /** Terrain type (grass, forest, water, mountain) */
    terrain: TerrainType;
    
    /** Building type on this tile (if any) */
    building: BuildingType;
    
    /** Building level (0 = no building, 1+ = building level) */
    buildingLevel: number;
    
    /** Owner ID (0 = neutral/unowned, 1+ = player ID) */
    ownerId: number;
    
    /** Additional metadata for future use */
    metadata?: Record<string, unknown>;
}

/**
 * WorldContainer - Manages game world metadata and provides render buffer translation
 */
export class WorldContainer {
    private mapGrid: TileMetadata[][];
    private mapSize: number;

    /**
     * Create a new WorldContainer
     * @param mapSize - Size of the map (default: 64x64)
     */
    constructor(mapSize: number = MAP_SIZE) {
        this.mapSize = mapSize;
        this.mapGrid = [];

        // Initialize map with random terrain (0-3) for testing
        // This generates a random 64x64 grid of tile IDs
        for (let y = 0; y < mapSize; y++) {
            this.mapGrid[y] = [];
            for (let x = 0; x < mapSize; x++) {
                // Generate random terrain type (0-3)
                const randomTerrain = Math.floor(Math.random() * 4) as TerrainType;
                this.mapGrid[y][x] = {
                    terrain: randomTerrain,
                    building: BuildingType.NONE,
                    buildingLevel: 0,
                    ownerId: 0,
                };
            }
        }
    }

    /**
     * Get tile metadata at a specific coordinate
     * @param x - X coordinate (0 to mapSize-1)
     * @param y - Y coordinate (0 to mapSize-1)
     * @returns TileMetadata or undefined if out of bounds
     */
    getTile(x: number, y: number): TileMetadata | undefined {
        if (x < 0 || x >= this.mapSize || y < 0 || y >= this.mapSize) {
            return undefined;
        }
        return this.mapGrid[y][x];
    }

    /**
     * Set tile metadata at a specific coordinate
     * @param x - X coordinate (0 to mapSize-1)
     * @param y - Y coordinate (0 to mapSize-1)
     * @param metadata - Tile metadata to set
     * @returns true if successful, false if out of bounds
     */
    setTile(x: number, y: number, metadata: Partial<TileMetadata>): boolean {
        if (x < 0 || x >= this.mapSize || y < 0 || y >= this.mapSize) {
            return false;
        }

        const current = this.mapGrid[y][x];
        this.mapGrid[y][x] = {
            ...current,
            ...metadata,
        };

        return true;
    }

    /**
     * Update a building's level at a specific coordinate
     * @param x - X coordinate (0 to mapSize-1)
     * @param y - Y coordinate (0 to mapSize-1)
     * @param level - New building level (0 = remove building, 1+ = building level)
     * @returns true if successful, false if out of bounds
     */
    setBuildingLevel(x: number, y: number, level: number): boolean {
        if (level < 0) level = 0;
        
        const tile = this.getTile(x, y);
        if (!tile) return false;

        if (level === 0) {
            // Remove building
            return this.setTile(x, y, {
                building: BuildingType.NONE,
                buildingLevel: 0,
            });
        } else {
            // Set building level (assumes building type is already set)
            return this.setTile(x, y, {
                buildingLevel: level,
            });
        }
    }

    /**
     * Place a building at a specific coordinate
     * @param x - X coordinate (0 to mapSize-1)
     * @param y - Y coordinate (0 to mapSize-1)
     * @param buildingType - Type of building to place
     * @param level - Building level (default: 1)
     * @param ownerId - Owner ID (default: 0 = neutral)
     * @returns true if successful, false if out of bounds
     */
    placeBuilding(x: number, y: number, buildingType: BuildingType, level: number = 1, ownerId: number = 0): boolean {
        return this.setTile(x, y, {
            building: buildingType,
            buildingLevel: level,
            ownerId: ownerId,
        });
    }

    /**
     * Calculate render tile ID from tile metadata
     * 
     * Tile ID encoding strategy:
     * - Current tileset has 4 tiles (0-3) representing different terrain/building types
     * - If building exists: Use building type as tile ID (mapped to tileset)
     * - Otherwise: Use terrain type as tile ID
     * 
     * Future expansion: When tileset grows, we can encode:
     * - Bits 0-1: Terrain type (0-3)
     * - Bits 2-3: Building type (0-3)
     * - Bits 4-7: Building level (0-15)
     * - Bits 8-15: Owner ID (0-255)
     * 
     * @param metadata - Tile metadata
     * @returns Render tile ID (0-3 for current tileset)
     */
    private calculateTileId(metadata: TileMetadata): number {
        // If there's a building, use building type as the tile ID
        // This ensures that updating building level or type changes the rendered tile
        if (metadata.building !== BuildingType.NONE && metadata.buildingLevel > 0) {
            // Map building type to tile ID (0-3)
            // BuildingType enum: NONE=0, FARM=1, MINE=2, FORTRESS=3
            // We use building type directly, but clamp to valid range
            const buildingTileId = Math.min(3, metadata.building);
            
            // For now, we'll use a simple mapping:
            // - FARM (1) -> Tile 1 (Red)
            // - MINE (2) -> Tile 2 (Blue)
            // - FORTRESS (3) -> Tile 3 (Yellow)
            return buildingTileId;
        }

        // Otherwise, use terrain type
        // TerrainType enum: GRASS=0, FOREST=1, WATER=2, MOUNTAIN=3
        return metadata.terrain;
    }

    /**
     * Get render data - converts metadata to Uint32Array of tile IDs
     * 
     * This is the "Translation Layer" that converts rich metadata into
     * raw tile IDs that the renderer can use directly.
     * 
     * The returned buffer can be transferred to the worker via postMessage
     * using transferable objects for zero-copy performance.
     * 
     * @returns Uint32Array of tile IDs (mapSize * mapSize elements)
     */
    getRenderData(): Uint32Array {
        const buffer = new Uint32Array(this.mapSize * this.mapSize);

        for (let y = 0; y < this.mapSize; y++) {
            for (let x = 0; x < this.mapSize; x++) {
                const metadata = this.mapGrid[y][x];
                const index = y * this.mapSize + x;
                buffer[index] = this.calculateTileId(metadata);
            }
        }

        return buffer;
    }

    /**
     * Get render buffer - alias for getRenderData() for backward compatibility
     * @returns Uint32Array of tile IDs (mapSize * mapSize elements)
     */
    getRenderBuffer(): Uint32Array {
        return this.getRenderData();
    }

    /**
     * Get the map size
     * @returns Map size (width/height in tiles)
     */
    getMapSize(): number {
        return this.mapSize;
    }

    /**
     * Initialize map with random terrain for testing
     */
    initializeRandomTerrain(): void {
        for (let y = 0; y < this.mapSize; y++) {
            for (let x = 0; x < this.mapSize; x++) {
                const terrain = Math.floor(Math.random() * 4) as TerrainType;
                this.setTile(x, y, { terrain });
            }
        }
    }
}
