# Victoriae: System Architecture & Development Document

This document serves as the primary technical specification for **Victoriae**, a 2D top-down, turn-based strategy RPG inspired by the *Warlords* series. It is designed to guide both the lead developer and AI coding agents in building a minimalist, high-performance, and "hands-off" game engine from scratch.

---

## 1. Executive Summary

**Victoriae** is a web-based strategy game featuring persistent world maps, tactical turn-based combat, and multiplayer functionality. The core philosophy is **mechanical transparency** and **developer control**.

* **Key Features:** Randomly generated persistent worlds, tile-based movement, unit management, and a "View-Only" frontend driven by an authoritative Go backend.

---

## 2. Core Technical Stack (2026 Standard)

| Layer | Technology | Role |
| --- | --- | --- |
| **Build Tool** | **Vite 7** | Fast bundling, HMR for Workers, and WGSL support. |
| **Language** | **TypeScript / Go** | Frontend logic and high-performance backend. |
| **Renderer** | **TypeGPU** | Type-safe WebGPU abstraction (no scene-graph bloat). |
| **Threading** | **Web Workers** | Off-loading rendering and heavy math from UI thread. |
| **Memory** | **SharedArrayBuffer** | Zero-copy state sharing between Main and Worker. |
| **Communication** | **Protobuf + Connect** | Strict, typed schema for Go  TS sync. |

---

## 3. Project Layout

A monorepo structure managed by `pnpm` and `Taskfile`.

```text
/victoriae
├── /apps
│   ├── /client           # Vite + TS + TypeGPU
│   │   ├── /src
│   │   │   ├── /main     # DOM, UI (SolidJS), Input, Networking
│   │   │   ├── /worker   # The Rendering Engine (WebWorker)
│   │   │   └── /shared   # SAB offsets, Constants, Proto-types
│   └── /server           # Go Backend (The "Brain")
│       ├── /cmd          # Entry points
│       ├── /internal     # World gen, Pathfinding, Combat logic
│       └── /proto        # Generated Protobuf code
├── /proto                # Source .proto files
├── Taskfile.yml          # Cross-language build/dev tasks
└── pnpm-workspace.yaml

```

---

## 4. System Architecture: The "Dumb Terminal" Model

### A. The Main Thread (UI & Input)

* **Responsibility:** DOM-based UI (HUD, Menus), Input listeners, and WebSocket management.
* **Input Flow:** Captures mouse/keyboard events. High-frequency data (Camera movement, mouse-over tile) is written directly to a **SharedArrayBuffer (SAB)**. Low-frequency data (Unit move commands) is sent to the Go backend.

### B. The Render Worker (The Engine)

* **Responsibility:** Drawing the world via `OffscreenCanvas`.
* **The Loop:** Runs a `requestAnimationFrame`. Each frame, it:
1. Reads Camera  from the **SAB**.
2. Updates TypeGPU uniforms.
3. Renders the Tilemap and Units using **Instanced Drawing**.



### C. The Go Backend (The Authority)

* **Responsibility:** Holds the "Truth." Handles turn resolution, fog of war, and world persistence.
* **Communication:** Pushes state deltas (e.g., "Unit A moved to 10,12") to the client via WebSockets using **Protobuf**.

---

## 5. Rendering Engine Specifications

### The Fragment-Shader Tilemap

To handle the "Warlords" scale map, the renderer uses a single fullscreen quad and a custom fragment shader.

* **Input 1:** A `texture_2d` (Tileset atlas).
* **Input 2:** A `storage_buffer` (The Map Grid). Each index is a `u32` containing the tile ID and state bits (e.g., fog of war).
* **Logic:** The shader calculates the specific tile to sample based on the pixel's world-space coordinate (derived from the Camera SAB).

### Camera System

Implemented as a **Transformation Matrix** in the worker.

* **Zoom-to-Cursor:** Calculated in the worker by comparing the current world-space mouse position (from SAB) before and after the scale change.

---

## 6. Integration Protocol for Coding Agents

When tasking an agent to build a specific system, use the following context:

1. **State Isolation:** "Ensure all rendering logic lives in `/worker` and communicates with the UI via `SharedArrayBuffer` using the offsets defined in `/shared/constants.ts`."
2. **Type Safety:** "Use **TypeGPU** schemas to define all GPU buffers. No raw WebGPU `createBuffer` calls unless necessary for low-level optimization."
3. **UI/UX:** "Do not use Canvas for text or menus. Implement all HUD elements in the Main thread using the provided UI framework, overlaying the canvas."
