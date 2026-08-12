import { defineConfig } from 'vite';

/**
 * `index.html` carries a CDN import map so the project can also be played by
 * serving the folder statically with no build step at all. Vite resolves the
 * same bare specifier from node_modules and bundles it, which leaves that import
 * map inert but still shipped — dead markup implying the build pulls Three.js
 * from unpkg when it does not. Strip it on build only.
 */
function stripCdnImportMap() {
  return {
    name: 'strip-cdn-import-map',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '');
    },
  };
}

export default defineConfig({
  // Relative asset URLs so dist/ can be served from any sub-path.
  base: './',
  plugins: [stripCdnImportMap()],
  server: { host: '127.0.0.1', port: 5174 },
  preview: { host: '127.0.0.1', port: 4174 },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Three is ~470 kB and never changes between builds; splitting it out
        // keeps the app chunk small and cacheable. There is no physics engine
        // to split — the 6DOF integrator is ours and lives in the app chunk.
        manualChunks(id) {
          const p = id.split('\\').join('/');
          if (p.includes('node_modules/three/')) {
            return 'three';
          }
          return undefined;
        },
      },
    },
  },
});
