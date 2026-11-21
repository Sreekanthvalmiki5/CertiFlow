import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin API in dev, exactly like nginx does in the container.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
});
