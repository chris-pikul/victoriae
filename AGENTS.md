# AGENTS.md - Victoriae Developer Guide

This document defines the architecture, coding standards, and system boundaries for the **Victoriae** project. Read this before modifying any code.

## 1. Project Philosophy

Victoriae is a "hands-off" custom game engine. We avoid monolithic game engines (Phaser/Unity). We favor:

* **Decoupled Rendering:** The main thread handles UI/DOM; the worker thread handles WebGPU.
* **Authoritative Backend:** The Go server owns the game logic; the frontend is a "dumb terminal" for visualization.
* **Zero-Latency Input:** High-frequency data (camera/mouse) moves via `SharedArrayBuffer` (SAB).

---

## 2. Technical Stack

* **Frontend:** TypeScript, Vite 7, TypeGPU.
* **Backend:** Go (Standard Library + Connect-Go for Protobuf).
* **Rendering:** WebGPU via `OffscreenCanvas` inside a Web Worker.
* **IPC:** `SharedArrayBuffer` for Main  Worker; `Protobuf` for Client  Server.

---

## 3. Architecture & Threading Model

### A. Main Thread (`apps/web-client/src/main/`)

* **Role:** DOM management, UI (SolidJS/Svelte), and low-frequency input.
* **Constraint:** Never perform heavy calculations or rendering here.
* **Input Handling:** Update the `SharedArrayBuffer` for camera transforms. Send gameplay commands (e.g., "Move Unit") via WebSocket to Go.

### B. Render Worker (`apps/web-client/src/worker/`)

* **Role:** Exclusive owner of the `GPUDevice` and `OffscreenCanvas`.
* **Loop:** A standard `requestAnimationFrame` loop.
* **Constraint:** Must remain "stateless" regarding gameplay. It renders what is in the GPU buffers. It reads the `SharedArrayBuffer` every frame to calculate the projection matrix.

### C. Shared Memory (`apps/web-client/src/shared/`)

* **SAB_OFFSETS:** Must be used by both threads to access the `Float32Array` view of the SAB.
* **No Mutexes:** Only the Main Thread **writes** to camera/input offsets; only the Worker **reads** them.

---

## 4. Rendering Standards (TypeGPU)

* **Tilemaps:** Use a single-pass fragment shader. Pass a `storage_buffer` of tile IDs and a `texture_2d` atlas.
* **Units/Entities:** Use **GPU Instancing**. Do not create individual objects for every unit.
* **Shaders:** Write shaders in TypeScript using `@use_gpu` via `unplugin-typegpu`.

---

## 5. Coding Patterns & Constraints

### Cross-Origin Isolation

The project requires `SharedArrayBuffer`. The Vite server is configured with:

* `Cross-Origin-Opener-Policy: same-origin`
* `Cross-Origin-Embedder-Policy: require-corp`
If you add new assets or external scripts, they must support CORS.

### Go-TypeScript Bridge

* All networking must use the generated Protobuf types in `apps/web-client/src/shared/proto`.
* Do not write manual JSON parsers for game state.

---

## 6. Common Tasks & Commands

Agents should use the following tasks via `task` (go-task):

* `task dev`: Starts both the Go backend and Vite frontend.
* `task proto:gen`: Rebuilds Protobuf definitions (run this after changing `.proto` files).

---

## 7. Memory Layout (SAB)

Reference `apps/web-client/src/shared/constants.ts` for current offsets.

* `[0]` : Camera X (World Units)
* `[1]` : Camera Y (World Units)
* `[2]` : Camera Zoom (0.1 to 5.0)
* `[3]` : Mouse X (Screen Pixels)
* `[4]` : Mouse Y (Screen Pixels)

---

## 8. Development Instructions for Agents

When assigned a feature:

1. **Check the SAB:** If the feature requires new high-frequency input, add an offset to `constants.ts`.
2. **Define the Schema:** If it’s a new renderable (e.g., fog of war), define the TypeGPU buffer layout first.
3. **Implement the Pass:** Add the render pass to the loop in `render.worker.ts`.
4. **UI Overlay:** If it needs a menu or button, add it to the DOM overlay in the main thread, not the canvas.
