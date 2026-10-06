// Vite config for the locus-runtime package.
//
// The package itself is plain ESM and needs NO build to be consumed
// (exports map straight to src/). The build exists for the BROWSER host
// page: tests/runtime-host.html is a real build input, so the browser
// gates run the PACKAGED module graph (entry + worker assets), not
// loose dev-server sources.
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    rollupOptions: {
      input: {
        runtimeHost: 'tests/runtime-host.html',
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
