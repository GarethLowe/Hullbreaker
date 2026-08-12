# Public-hosting policy

The public build is self-hosted: Vite bundles the pinned `three@0.160.0`
dependency into `dist/assets`. Do not publish the no-build import-map path; it
uses unpkg solely as a local development convenience.

Serve this Content-Security-Policy as an HTTP response header. A matching meta
policy is injected into the built page by `vite.config.js` to protect static
hosts that cannot set headers. It cannot live in the source `index.html`: the
no-build path depends on the inline import map, which `script-src 'self'`
blocks, so a source-level meta policy kills that path outright.

```
default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self';
connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none';
```

`style-src 'unsafe-inline'` is required until the current inline stylesheet is
extracted. The meta policy omits `frame-ancestors` because browsers ignore that
directive outside an HTTP header. Add a deployment-specific header with the
full policy, then verify `npm run build` and the production smoke check after
every asset-policy change.
