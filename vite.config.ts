import { defineConfig } from 'vite';

export default defineConfig({
  // Electron loads the production build from disk over file://, where an absolute
  // `/assets/...` URL resolves to the filesystem root and the window stays white.
  // Relative asset URLs work from both file:// and the dev server.
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Electron 44 ships a modern Chromium; module preload and top-level await are fine.
    target: 'chrome128',
  },
});
