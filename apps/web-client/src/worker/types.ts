import type { TgpuRoot } from 'typegpu';

/**
 * Context object passed to layers during initialization.
 * Contains all the necessary GPU resources for rendering.
 */
export interface TgpuContext {
    root: TgpuRoot;
    device: GPUDevice;
    canvas: OffscreenCanvas;
    context: GPUCanvasContext;
    format: GPUTextureFormat;
}

/**
 * Render pass wrapper for layers.
 * Provides access to the current render pass encoder and command encoder.
 */
export interface TgpuRenderPass {
    encoder: GPURenderPassEncoder;
    commandEncoder: GPUCommandEncoder;
}

/**
 * Viewport definition for layer scissoring.
 * Coordinates are in pixels relative to the canvas.
 */
export interface Viewport {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Interface for render layers (Base Map, Overlays, UI, etc.)
 * Each layer manages its own rendering state and logic.
 */
export interface VictoriaeLayer {
    /**
     * Unique identifier for this layer.
     * Used for input capture tracking.
     */
    layerId: number;

    /**
     * Initialize the layer with GPU context.
     * Called once when the layer is added to the manager.
     */
    init(context: TgpuContext): void;

    /**
     * Update layer state based on SharedArrayBuffer and delta time.
     * Called every frame before rendering.
     * 
     * @param sabView - Float32Array view of the SharedArrayBuffer
     * @param deltaTime - Time since last frame in seconds
     */
    update(sabView: Float32Array, deltaTime: number): void;

    /**
     * Render the layer to a render pass.
     * Called every frame after update.
     * 
     * @param pass - Render pass wrapper containing the encoder and command encoder (null if needsNewPass is true)
     * @param needsNewPass - Whether this layer needs to create a new render pass (for clearing)
     * @param textureView - The texture view to render to (for new passes)
     * @param commandEncoder - The command encoder for this frame (required when needsNewPass is true)
     * @param screenWidth - Current screen width in pixels
     * @param screenHeight - Current screen height in pixels
     * @returns The render pass encoder (either new or existing)
     */
    render(
        pass: TgpuRenderPass | null,
        needsNewPass: boolean,
        textureView: GPUTextureView,
        commandEncoder: GPUCommandEncoder,
        screenWidth: number,
        screenHeight: number
    ): GPURenderPassEncoder | null;

    /**
     * Whether this layer is currently visible.
     * Hidden layers are skipped during update and render.
     */
    visible: boolean;

    /**
     * Viewport for this layer (optional).
     * If set, rendering will be scissored to this area.
     * Coordinates are in pixels relative to the canvas.
     * If null, the layer renders to the full screen.
     */
    viewport: Viewport | null;

    /**
     * Cleanup resources when layer is removed.
     * Optional - called when layer is removed from manager.
     */
    cleanup?(): void;
}
