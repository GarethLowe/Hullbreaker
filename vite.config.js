import { defineConfig } from 'vite';

/**
 * `index.html` carries a CDN import map so the project can also be played by
 * serving the folder statically with no build step at all. Vite resolves the
 * same bare specifier from node_modules and bundles it, which leaves that import
 * map inert but still shipped — dead markup implying the build pulls Three.js
 * from unpkg when it does not. Strip it on build only.
 *
 * The Content-Security-Policy meta is injected here rather than authored in
 * index.html, because `script-src 'self'` blocks the inline import map the
 * no-build path depends on — a source-level meta policy killed that path
 * outright (measured: "Failed to resolve module specifier three"). Only the
 * built page, whose import map is stripped, can carry the strict policy. Keep
 * this string in step with docs/deployment-security.md.
 */
const CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; "
  + "script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; "
  + "worker-src 'self' blob:";

function productionIndexHtml() {
  return {
    name: 'production-index-html',
    apply: 'build',
    transformIndexHtml(html) {
      return html
        .replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '')
        .replace('<title>', `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n<title>`);
    },
  };
}

export default defineConfig({
  // Relative asset URLs so dist/ can be served from any sub-path.
  base: './',
  plugins: [productionIndexHtml()],
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
