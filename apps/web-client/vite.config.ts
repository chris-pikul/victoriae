import { defineConfig } from 'vite';
import typegpuPlugin from 'unplugin-typegpu/vite';

export default defineConfig({
    plugins: [typegpuPlugin({})],

    worker: {
        format: 'es', // Ensures ESM support in Web Workers
    },
    server: {
        // Required for SharedArrayBuffer headers
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
});