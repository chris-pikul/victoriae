import type { VictoriaeLayer, TgpuContext, TgpuRenderPass, Viewport } from './types';
import { SAB_OFFSETS } from '../shared/constants';

/**
 * Manages an array of render layers and forwards update/render calls to active layers.
 * Supports layered composition where multiple layers render simultaneously.
 */
export class ViewManager {
    private layers: VictoriaeLayer[] = [];
    private gpuContext: TgpuContext | null = null;
    private nextLayerId: number = 0;

    /**
     * Initialize the ViewManager with GPU context.
     * Must be called before adding any layers.
     */
    init(context: TgpuContext): void {
        this.gpuContext = context;
    }

    /**
     * Add a layer to the manager.
     * The layer is added to the end of the render order.
     * Layers are rendered in the order they were added (0 to N).
     * Assigns a unique layer ID to the layer.
     */
    add(layer: VictoriaeLayer): void {
        if (!this.gpuContext) {
            throw new Error('ViewManager not initialized. Call init() first.');
        }

        // Assign unique layer ID
        layer.layerId = this.nextLayerId++;
        this.layers.push(layer);
        layer.init(this.gpuContext);
    }

    /**
     * Remove a layer from the manager.
     * Calls cleanup() on the layer if defined.
     */
    remove(layer: VictoriaeLayer): void {
        const index = this.layers.indexOf(layer);
        if (index !== -1) {
            this.layers.splice(index, 1);
            if (layer.cleanup) {
                layer.cleanup();
            }
        }
    }

    /**
     * Get all layers in render order.
     */
    getLayers(): readonly VictoriaeLayer[] {
        return this.layers;
    }

    /**
     * Get all visible layers in render order.
     */
    getVisibleLayers(): VictoriaeLayer[] {
        return this.layers.filter(layer => layer.visible);
    }

    /**
     * Check if a point is within a viewport.
     * @param x - X coordinate in screen pixels
     * @param y - Y coordinate in screen pixels
     * @param viewport - Viewport to check, or null for full screen
     * @returns true if point is within viewport
     */
    private isPointInViewport(x: number, y: number, viewport: Viewport | null): boolean {
        if (!viewport) {
            return true; // Full screen viewport contains all points
        }
        return x >= viewport.x && 
               x < viewport.x + viewport.width &&
               y >= viewport.y && 
               y < viewport.y + viewport.height;
    }

    /**
     * Intercept input events and determine which layer should handle them.
     * Checks layers from top to bottom (highest index first).
     * Stores the captured layer ID in the SAB.
     * 
     * @param sabView - Float32Array view of the SharedArrayBuffer
     */
    interceptInput(sabView: Float32Array): void {
        const isMouseDown = sabView[SAB_OFFSETS.IS_MOUSE_DOWN] > 0.5;
        const mouseX = sabView[SAB_OFFSETS.MOUSE_WORLD_X]; // Screen X coordinate
        const mouseY = sabView[SAB_OFFSETS.MOUSE_WORLD_Y]; // Screen Y coordinate

        // If mouse is not down, clear captured layer
        if (!isMouseDown) {
            sabView[SAB_OFFSETS.CAPTURED_LAYER_ID] = -1;
            return;
        }

        // Check layers from top to bottom (highest index first)
        // This matches the render order - last layer rendered is on top
        const visibleLayers = this.getVisibleLayers();
        let capturedLayerId = -1;

        for (let i = visibleLayers.length - 1; i >= 0; i--) {
            const layer = visibleLayers[i];
            
            // Check if mouse is within this layer's viewport
            if (this.isPointInViewport(mouseX, mouseY, layer.viewport)) {
                capturedLayerId = layer.layerId;
                break; // Topmost layer that contains the point captures the input
            }
        }

        // Store captured layer ID in SAB
        sabView[SAB_OFFSETS.CAPTURED_LAYER_ID] = capturedLayerId;
    }

    /**
     * Check if input is captured by a specific layer.
     * @param sabView - Float32Array view of the SharedArrayBuffer
     * @param layerId - Layer ID to check
     * @returns true if the specified layer has captured input
     */
    isInputCapturedBy(sabView: Float32Array, layerId: number): boolean {
        return sabView[SAB_OFFSETS.CAPTURED_LAYER_ID] === layerId;
    }

    /**
     * Check if input is captured by any layer (not the world map).
     * @param sabView - Float32Array view of the SharedArrayBuffer
     * @returns true if any layer has captured input
     */
    isInputCaptured(sabView: Float32Array): boolean {
        return sabView[SAB_OFFSETS.CAPTURED_LAYER_ID] >= 0;
    }

    /**
     * Update all visible layers.
     * Called every frame before rendering.
     */
    update(sabView: Float32Array, deltaTime: number): void {
        // Intercept input first to determine which layer owns mouse events
        this.interceptInput(sabView);

        // Update all visible layers
        const visibleLayers = this.getVisibleLayers();
        for (const layer of visibleLayers) {
            layer.update(sabView, deltaTime);
        }
    }

    /**
     * Render all visible layers in order.
     * Uses a single command encoder for the frame.
     * Each layer can create its own render pass or draw into an existing one.
     * 
     * @param commandEncoder - The command encoder for this frame
     * @param textureView - The texture view to render to
     * @param screenWidth - Current screen width in pixels
     * @param screenHeight - Current screen height in pixels
     */
    render(commandEncoder: GPUCommandEncoder, textureView: GPUTextureView, screenWidth: number, screenHeight: number): void {
        const visibleLayers = this.getVisibleLayers();
        let currentPass: GPURenderPassEncoder | null = null;

        for (let i = 0; i < visibleLayers.length; i++) {
            const layer = visibleLayers[i];
            
            // First layer always needs a new pass (for clearing)
            // Subsequent layers can decide if they need a new pass or use existing
            const needsNewPass = i === 0 || currentPass === null;
            
            const pass: TgpuRenderPass | null = currentPass 
                ? { encoder: currentPass, commandEncoder }
                : null;

            const newPass = layer.render(pass, needsNewPass, textureView, commandEncoder, screenWidth, screenHeight);
            
            // If layer created a new pass, use it for subsequent layers
            if (newPass) {
                currentPass = newPass;
            }
        }

        // End the final render pass if one is still open
        if (currentPass) {
            currentPass.end();
        }
    }
}
