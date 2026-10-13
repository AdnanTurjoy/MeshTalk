import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Production renderer CSP. No inline scripts or styles, no remote origins.
 * In development the main process sends a looser header for Vite's HMR
 * (see src/main/security.ts).
 */
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: meshtalk-file:",
  "media-src 'self' blob: meshtalk-file:",
  "font-src 'self'",
  "connect-src 'self' meshtalk-file:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'meshtalk-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const tag = ctx.server
          ? ''
          : `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`;
        return html.replace('<!-- %CSP% -->', tag);
      },
    },
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads must be CommonJS.
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
    plugins: [react(), cspPlugin()],
  },
});
