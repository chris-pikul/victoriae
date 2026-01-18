import { SAB_OFFSETS } from '../shared/constants';
import tgpu from 'typegpu';
import * as d from 'typegpu/data';

let canvas: OffscreenCanvas;
let sabView: Float32Array;
let root: any;
let device: GPUDevice;
let context: GPUCanvasContext;
let pipeline: GPURenderPipeline;
let format: GPUTextureFormat;
let cameraUniformBuffer: GPUBuffer;
let tilemapStorageBuffer: GPUBuffer;
let tilesetTexture: GPUTexture;
let tilesetTextureView: GPUTextureView;
let tilemapBindGroup: GPUBindGroup;
const MAP_SIZE = 64; // 64x64 tile map

self.onmessage = async (e: MessageEvent) => {
    const { type, canvas: receivedCanvas, sab, width, height } = e.data;

    if (type === 'INIT') {
        canvas = receivedCanvas;
        sabView = new Float32Array(sab);
        await startRendering();
    } else if (type === 'RESIZE') {
        // Resize the OffscreenCanvas (this must be done in the worker thread)
        // The screen dimensions are already updated in the SAB by the main thread
        if (width && height) {
            canvas.width = width;
            canvas.height = height;

            // Reconfigure the WebGPU context to match new canvas size
            // This ensures the context uses the correct resolution
            if (context) {
                context.configure({
                    device: device,
                    format: format,
                    alphaMode: 'opaque',
                });
            }
        }
    }
};

async function startRendering() {
    // Initialize TypeGPU root context - this creates the GPU device
    root = await tgpu.init();
    device = root.device;

    // Get WebGPU context from OffscreenCanvas and configure it with TypeGPU's device
    context = canvas.getContext('webgpu') as GPUCanvasContext;
    if (!context) {
        throw new Error('Failed to get WebGPU context from OffscreenCanvas');
    }

    format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device: device,
        format: format,
        alphaMode: 'opaque',
    });

    console.log('Victoriae: TypeGPU Root Initialized');

    // Define CameraUniform struct using TypeGPU data types
    // Extended to include screen dimensions for proper coordinate calculation
    const CameraUniform = d.struct({
        pos: d.vec2f,
        zoom: d.f32,
        screenSize: d.vec2f, // Screen width and height in pixels
    });

    // Create bind group layout for tilemap (camera uniform + storage buffer + texture)
    const tilemapBindGroupLayout = device.createBindGroupLayout({
        label: 'tilemap-bind-group-layout',
        entries: [
            {
                binding: 0, // Camera uniform
                visibility: GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'uniform',
                },
            },
            {
                binding: 1, // Tilemap storage buffer
                visibility: GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'read-only-storage',
                },
            },
            {
                binding: 2, // Tileset texture
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'float',
                },
            },
            {
                binding: 3, // Tileset sampler
                visibility: GPUShaderStage.FRAGMENT,
                sampler: {
                    type: 'filtering',
                },
            },
        ],
    });

    // Create uniform buffer for camera
    // Layout: vec2f pos (8 bytes) + f32 zoom (4 bytes) + vec2f screenSize (8 bytes) = 20 bytes, padded to 32
    const uniformBufferSize = 32; // Aligned to 16 bytes
    cameraUniformBuffer = device.createBuffer({
        label: 'camera-uniform-buffer',
        size: uniformBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create 64x64 tilemap storage buffer with random tile IDs (0-3)
    const tileCount = MAP_SIZE * MAP_SIZE;
    const tileData = new Uint32Array(tileCount);
    const tileCounts = [0, 0, 0, 0];
    for (let i = 0; i < tileCount; i++) {
        const tileId = Math.floor(Math.random() * 4); // Random tile ID 0-3
        tileData[i] = tileId;
        tileCounts[tileId]++;
    }

    // Debug: Verify tile distribution
    console.log('Tile distribution:', tileCounts);
    console.log('Sample tiles (first 10):', Array.from(tileData.slice(0, 10)));

    tilemapStorageBuffer = device.createBuffer({
        label: 'tilemap-storage-buffer',
        size: tileData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(tilemapStorageBuffer, 0, tileData);

    // Create placeholder tileset texture (4x4 grid of colored tiles)
    // Each tile is 32x32 pixels, so texture is 128x128
    const TILE_SIZE = 32;
    const TILESET_COLS = 4;
    const TILESET_ROWS = 1; // Single row of 4 tiles
    const tilesetWidth = TILE_SIZE * TILESET_COLS;
    const tilesetHeight = TILE_SIZE * TILESET_ROWS;
    const tilesetData = new Uint8Array(tilesetWidth * tilesetHeight * 4); // RGBA

    // Generate simple colored tiles
    const tileColors = [
        [100, 250, 100, 255],  // Tile 0: Green
        [250, 100, 100, 255],  // Tile 1: Red
        [100, 100, 250, 255],  // Tile 2: Blue
        [250, 250, 100, 255],  // Tile 3: Yellow
    ];

    for (let tileId = 0; tileId < TILESET_COLS; tileId++) {
        const tileX = tileId * TILE_SIZE;
        const color = tileColors[tileId];

        for (let y = 0; y < TILE_SIZE; y++) {
            for (let x = 0; x < TILE_SIZE; x++) {
                const px = tileX + x;
                const py = y;
                const idx = (py * tilesetWidth + px) * 4;

                // Add some variation for visual interest
                const variation = Math.sin(x * 0.5) * Math.sin(y * 0.5) * 20;
                tilesetData[idx] = Math.max(0, Math.min(255, color[0] + variation));     // R
                tilesetData[idx + 1] = Math.max(0, Math.min(255, color[1] + variation)); // G
                tilesetData[idx + 2] = Math.max(0, Math.min(255, color[2] + variation)); // B
                tilesetData[idx + 3] = 255; // A
            }
        }
    }

    tilesetTexture = device.createTexture({
        label: 'tileset-texture',
        size: [tilesetWidth, tilesetHeight],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    device.queue.writeTexture(
        { texture: tilesetTexture },
        tilesetData,
        { bytesPerRow: tilesetWidth * 4, rowsPerImage: tilesetHeight },
        { width: tilesetWidth, height: tilesetHeight }
    );

    tilesetTextureView = tilesetTexture.createView();

    // Create sampler for tileset texture
    const tilesetSampler = device.createSampler({
        label: 'tileset-sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    // Create bind group for tilemap
    tilemapBindGroup = device.createBindGroup({
        label: 'tilemap-bind-group',
        layout: tilemapBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: cameraUniformBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: tilemapStorageBuffer,
                },
            },
            {
                binding: 2,
                resource: tilesetTextureView,
            },
            {
                binding: 3,
                resource: tilesetSampler,
            },
        ],
    });

    // Create shader module for fullscreen tilemap
    const shaderModule = device.createShaderModule({
        label: 'tilemap-shader',
        code: `
            struct CameraUniform {
                pos: vec2<f32>,
                zoom: f32,
                screenSize: vec2<f32>,
            };
            
            @group(0) @binding(0) var<uniform> camera: CameraUniform;
            @group(0) @binding(1) var<storage, read> tilemap: array<u32>;
            @group(0) @binding(2) var tileset: texture_2d<f32>;
            @group(0) @binding(3) var tilesetSampler: sampler;
            
            const MAP_SIZE: u32 = 64u;
            const TILESET_COLS: u32 = 4u;
            
            // Fullscreen quad vertex shader
            // Uses a single large triangle that covers the entire screen
            @vertex
            fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
                // Create a triangle that covers the entire screen in clip space
                // Vertices: (-1, -1), (3, -1), (-1, 3)
                // This single triangle covers the entire NDC space from -1 to 1
                var pos = vec2<f32>(-1.0, -1.0);
                if (vertexIndex == 1u) {
                    pos = vec2<f32>(3.0, -1.0);
                } else if (vertexIndex == 2u) {
                    pos = vec2<f32>(-1.0, 3.0);
                }
                return vec4<f32>(pos, 0.0, 1.0);
            }
            
            @fragment
            fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
                // fragCoord.xy is in screen pixel coordinates
                // Convert to normalized device coordinates (-1 to 1)
                let screenPos = fragCoord.xy;
                let screenSize = camera.screenSize;
                
                // Ensure screen size is valid (avoid division by zero)
                if (screenSize.x <= 0.0 || screenSize.y <= 0.0) {
                    return vec4<f32>(0.1, 0.1, 0.1, 1.0);
                }
                
                // Ensure zoom is valid (avoid division by zero)
                let zoom = max(camera.zoom, 0.001); // Minimum zoom to prevent division issues
                
                // Convert screen pixel coordinates to NDC (-1 to 1)
                // NDC: x = (screenX / screenWidth) * 2 - 1, y = (screenY / screenHeight) * 2 - 1
                let ndcRaw = (screenPos / screenSize) * 2.0 - 1.0;
                // Flip Y axis (screen Y increases downward, but we want world Y to increase upward)
                let ndc = vec2<f32>(ndcRaw.x, -ndcRaw.y);
                
                // Calculate world position from NDC and camera
                // World size visible depends on zoom and aspect ratio
                // For a square viewport, world size = 2.0 / zoom
                // Account for aspect ratio to maintain square tiles
                let aspectRatio = screenSize.x / screenSize.y;
                let worldSizeY = 2.0 / zoom; // Base world size in Y direction
                let worldSizeX = worldSizeY * aspectRatio; // Scale X by aspect ratio to maintain square tiles
                let worldPos = vec2<f32>(
                    ndc.x * (worldSizeX * 0.5) + camera.pos.x,
                    ndc.y * (worldSizeY * 0.5) + camera.pos.y
                );
                
                // Calculate which tile we're in (using floor to get tile coordinates)
                let tileCoord = vec2<i32>(floor(worldPos));
                
                // Clamp tile coordinates to valid range to ensure uniform control flow
                let clampedX = clamp(tileCoord.x, 0, i32(MAP_SIZE) - 1);
                let clampedY = clamp(tileCoord.y, 0, i32(MAP_SIZE) - 1);
                
                // Check if we're out of bounds (for coloring)
                let isOutOfBounds = tileCoord.x < 0 || tileCoord.x >= i32(MAP_SIZE) || 
                                    tileCoord.y < 0 || tileCoord.y >= i32(MAP_SIZE);
                
                // Get tile ID from storage buffer (using clamped coordinates)
                let tileIndex = u32(clampedY) * MAP_SIZE + u32(clampedX);
                let tileId = tilemap[tileIndex];
                
                // Calculate UV within the tile (0 to 1)
                let tileUV = fract(worldPos);
                
                // Calculate UV in the tileset texture
                // Tile ID determines which column in the tileset (0-3)
                // Each tile in the texture is 1/4 of the width
                let tilesetU = (f32(tileId) + tileUV.x) / f32(TILESET_COLS);
                let tilesetV = tileUV.y; // Single row, so V is just the tile UV
                
                // Sample the tileset texture (must be in uniform control flow)
                let color = textureSample(tileset, tilesetSampler, vec2<f32>(tilesetU, tilesetV));
                
                // Apply out-of-bounds darkening after sampling
                if (isOutOfBounds) {
                    return color * 0.3; // Darken out-of-bounds areas
                }
                
                return color;
            }
        `,
    });

    // Create pipeline layout with tilemap bind group
    const pipelineLayout = device.createPipelineLayout({
        label: 'tilemap-pipeline-layout',
        bindGroupLayouts: [tilemapBindGroupLayout],
    });

    // Create render pipeline for fullscreen tilemap
    pipeline = device.createRenderPipeline({
        label: 'tilemap-pipeline',
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [{
                format: format,
            }],
        },
        primitive: {
            topology: 'triangle-list',
        },
    });

    // Start render loop
    const frame = () => {
        // Read camera values from SharedArrayBuffer
        const camX = sabView[SAB_OFFSETS.CAMERA_X] || 0.0;
        const camY = sabView[SAB_OFFSETS.CAMERA_Y] || 0.0;
        const camZoom = sabView[SAB_OFFSETS.CAMERA_ZOOM] || 1.0; // Default to 1.0 if 0 or undefined
        // Update screen dimensions from canvas (they might change on resize)
        const screenWidth = canvas.width || 800;
        const screenHeight = canvas.height || 600;

        // Update SAB with current screen dimensions
        sabView[SAB_OFFSETS.SCREEN_WIDTH] = screenWidth;
        sabView[SAB_OFFSETS.SCREEN_HEIGHT] = screenHeight;

        // Update camera uniform buffer
        // Layout: vec2f pos (8 bytes), f32 zoom (4 bytes), vec2f screenSize (8 bytes) = 20 bytes, padded to 32
        const uniformData = new Float32Array(8); // 8 floats = 32 bytes
        uniformData[0] = camX;          // pos.x
        uniformData[1] = camY;          // pos.y
        uniformData[2] = camZoom;       // zoom
        uniformData[3] = 0.0;            // padding
        uniformData[4] = screenWidth;    // screenSize.x
        uniformData[5] = screenHeight;   // screenSize.y
        uniformData[6] = 0.0;            // padding
        uniformData[7] = 0.0;            // padding

        device.queue.writeBuffer(cameraUniformBuffer, 0, uniformData.buffer);

        // Get current texture view
        const textureView = context.getCurrentTexture().createView();

        // Create command encoder
        const commandEncoder = device.createCommandEncoder();

        // Begin render pass with dark grey clear color (#1a1a1a)
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.102, g: 0.102, b: 0.102, a: 1.0 }, // #1a1a1a
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        // Draw fullscreen tilemap
        renderPass.setPipeline(pipeline);
        renderPass.setBindGroup(0, tilemapBindGroup);
        renderPass.draw(3, 1, 0, 0); // Fullscreen quad (triangle strip equivalent)
        renderPass.end();

        // Submit commands
        device.queue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
}