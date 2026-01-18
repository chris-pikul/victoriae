To build **Victoriae** effectively, you should follow a "Buffer-First" approach. Because you are using a custom renderer and a detached worker, the data structures (SAB and GPU Buffers) must exist before the logic can be written.

Here is the step-by-step roadmap, divided into modular chunks for your agents.

---

## Phase 1: The Rendering Foundation (Worker Thread)

The goal is to get "pixels on the screen" using the custom TypeGPU pipeline.

### Chunk 1: TypeGPU Initialization & Triangle

* **Task:** Initialize the WebGPU context within `render.worker.ts`. Create a basic "Hello World" render pass that clears the screen to a specific color and draws a single triangle using TypeGPU's `@use_gpu` syntax.
* **Success Metric:** A colored triangle appears on the canvas when running `task dev`.

### Chunk 2: The Camera Uniform Buffer

* **Task:** Create a TypeGPU Uniform Buffer that stores the camera matrix (View-Projection). Update this buffer every frame by reading the  values from the `SharedArrayBuffer`.
* **Success Metric:** The triangle moves or scales when you manually change values in the SAB from the browser console.

### Chunk 3: Fragment Shader Tilemap (The World)

* **Task:** Implement the tilemap shader. Pass a dummy  `u32` array as a Storage Buffer and a placeholder tileset texture. The fragment shader must calculate which tile to draw based on the UV coordinates and the camera uniform.
* **Success Metric:** A grid of tiles appears that scrolls and zooms when the user interacts with the screen.

---

## Phase 2: Entity System & Interactivity

Now that the map exists, we need to place units and interact with them.

### Chunk 4: GPU Instancing for Units

* **Task:** Create an "Entity Pipeline." Instead of individual sprites, use a Storage Buffer containing an array of structs (Position, TypeID, State). Use **GPU Instancing** to draw multiple unit quads in a single draw call.
* **Success Metric:** 100+ "units" (placeholders) rendered on the map with zero performance drop.

### Chunk 5: Tile Selection & World-to-Screen Math

* **Task:** Implement the math to convert screen-space mouse coordinates (from SAB) into world-space tile coordinates. Highlight the tile the mouse is currently hovering over by passing the "HoveredTileID" to the fragment shader.
* **Success Metric:** A "cursor" box follows the mouse, snapping to the grid.

---

## Phase 3: The Authoritative Brain (Go Backend)

Shifting focus to the server to handle the "Truth" of the game.

### Chunk 6: Protobuf State Sync

* **Task:** Implement the Go-side WebSocket handler. Use the generated Protobuf code to send a "InitialWorldState" to the client upon connection.
* **Success Metric:** The TS Main Thread logs a valid Protobuf message received from the Go backend.

### Chunk 7: Turn Management & Move Validation

* **Task:** In Go, implement a basic "Turn Queue" and an "Action Handler." When the client sends a "MoveUnit" command, Go checks if the move is valid (e.g., within movement range) before broadcasting the updated position to all clients.
* **Success Metric:** Units only move when the server confirms the move is legal.

---

## Phase 4: Warlords-Specific Features

Adding the "flavor" that makes it a strategy RPG.

### Chunk 8: Fog of War System

* **Task:** Add a second layer to the Tilemap shader: a "Visibility Buffer." This is a bitmask updated by the Go server. Tiles in "Unexplored" areas are black; tiles in "Explored but Hidden" are dimmed.
* **Success Metric:** Moving a unit reveals the map in real-time.

### Chunk 9: The UI Overlay (Main Thread)

* **Task:** Build the "Unit Inspector" and "City Menu" in the DOM overlay (using SolidJS/Svelte). This UI must react to "Selection" events sent from the Worker.
* **Success Metric:** Clicking a unit on the canvas opens an HTML menu showing its stats.

---

### Agent Strategy: The "Task Loop"

For each chunk above, provide the agent with:

1. **The Specific Chunk Description.**
2. **PROJECT.md** and **AGENTS.md** for context.
3. **Current File Access:** Specifically `shared/constants.ts` so they don't hallucinate memory offsets.
