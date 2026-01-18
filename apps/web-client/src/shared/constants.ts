/**
 * SharedArrayBuffer Offsets (Float32Array)
 * Each offset represents a 4-byte index in the buffer.
 */
export const SAB_OFFSETS = {
    CAMERA_X: 0,
    CAMERA_Y: 1,
    CAMERA_ZOOM: 2,
    MOUSE_WORLD_X: 3,
    MOUSE_WORLD_Y: 4,
    SCREEN_WIDTH: 5,
    SCREEN_HEIGHT: 6,
    IS_MOUSE_DOWN: 7, // 0 for false, 1 for true
    CAPTURED_LAYER_ID: 8, // Layer index that captured input, or -1 if none
    HOVERED_TILE_X: 9, // Tile X coordinate under mouse (as float, cast to int)
    HOVERED_TILE_Y: 10, // Tile Y coordinate under mouse (as float, cast to int)
};

export const SAB_SIZE = 1024; // Bytes