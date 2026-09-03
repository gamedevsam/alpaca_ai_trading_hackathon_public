import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // TypeScript 7 (native/tsgo) removed the classic Compiler API that Next's build-time
  // type-check step dynamically requires. Type errors still surface via the `types:check`
  // script (`tsc --noEmit`), which uses the fully-functional TS7 CLI. Mirrors src/client.
  typescript: {
    ignoreBuildErrors: true,
  },
  // Emit a self-contained server bundle (.next/standalone) so the Docker runtime
  // stage can run `node server.js` without the full node_modules tree. See src/web/Dockerfile.
  output: 'standalone',
  // No next/image usage anywhere on this site (the OG route uses ImageResponse — WASM,
  // arch-independent). Disabling the optimizer keeps sharp's platform-specific .node binary
  // out of the runtime path, which is what lets an ARM64 host pre-build the standalone
  // bundle for the x86_64 image (scripts/docker_build.mjs + Dockerfile.prebuilt).
  images: {
    unoptimized: true,
  },
  // Pin the file-tracing root to THIS project so standalone output is flat
  // (`.next/standalone/server.js`). Without this, Next auto-detects the parent monorepo
  // as the root and nests the server under `.next/standalone/src/web/`, which differs
  // between local and Docker builds. import.meta.dirname === this project dir.
  outputFileTracingRoot: import.meta.dirname,
};

export default withMDX(config);
