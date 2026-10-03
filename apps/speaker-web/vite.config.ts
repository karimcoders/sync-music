import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:8080';

export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/, so the base is configurable.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // the browser is never on the same host as the backend in the sandbox /
    // behind a reverse proxy, so always use relative URLs + this proxy.
    allowedHosts: true,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
