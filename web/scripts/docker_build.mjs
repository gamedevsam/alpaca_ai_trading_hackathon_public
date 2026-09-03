// @ts-check
// Build the src/web (public site) Docker image. Invoked by `pnpm deploy_web` through
// dokkuDeploy's `node --run docker_build` extension point (run with cwd = src/web), which
// passes --tag (and optionally --no-cache / --development). Build context = this directory.
// Dependency-free on purpose: this runs inside the isolated src/web project.
//
// The image targets linux/x86_64. On a non-amd64 host that means QEMU emulation, where the
// in-image `pnpm install` + `next build` take 30+ minutes. The standalone output is
// arch-independent (pure JS/WASM — next/image is disabled, so no sharp binary is ever loaded),
// so on such hosts we build NATIVELY here first — always from scratch, so a stale bundle can
// never ship (the main app learned that the hard way, commit 9e199de) — and assemble the image
// with Dockerfile.prebuilt, whose only work is three COPYs (seconds, not minutes).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    tag: { type: 'string' },
    'no-cache': { type: 'boolean', default: false },
    development: { type: 'boolean', default: false }, // accepted for compatibility, ignored
  },
  strict: false,
  allowPositionals: true,
});

/** @param {string} command @param {string[]} args */
function run(command, args) {
  console.log(`[web docker_build]: ${command} ${args.join(' ')}`);
  const res = spawnSync(command, args, { stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

// Both Dockerfiles end with `COPY .../public ./public`, so an absent public/ fails the build with a
// raw BuildKit checksum error naming no cause. public/ went untracked until 2026-07-19 and deploys
// only ever passed because the host happened to hold it as an untracked dir — one clean checkout away
// from broken. A tracked .gitkeep now keeps it present; this asserts that instead of trusting it.
if (!existsSync('public')) {
  console.error(
    '[web docker_build]: aborting — src/web/public/ is missing, but both Dockerfiles COPY it into the image.\n' +
      '  A tracked .gitkeep should keep it present; restore it with: git checkout -- src/web/public',
  );
  process.exit(1);
}

// Stamp the build so /version can prove a deploy landed (B224) — mirrors the main app's
// dist/build_timestamp.txt pattern. Written on the HOST (both build paths run this script
// natively) because the commit sha needs `.git`, which the Docker build context excludes;
// both Dockerfiles COPY version.json directly from this context, no in-image git required.
const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const builtAt = new Date().toISOString();
writeFileSync('version.json', `${JSON.stringify({ builtAt, commitSha })}\n`);
console.log(`[web docker_build]: stamped version.json — commit ${commitSha.slice(0, 7)}, built ${builtAt}`);

const prebuilt = process.arch !== 'x64';
if (prebuilt) {
  console.log(
    `[web docker_build]: non-amd64 host (${process.arch}) — building natively, then packaging with Dockerfile.prebuilt`,
  );
  run('pnpm', ['install', '--frozen-lockfile']);
  rmSync('.next', { recursive: true, force: true });
  run('pnpm', ['build']);
  if (!existsSync('.next/standalone/server.js')) {
    console.error('[web docker_build]: aborting — native build did not produce .next/standalone/server.js');
    process.exit(1);
  }
}

const tag = String(values.tag || 'dokku/stocks-docs:local');
const args = [
  'build',
  '--platform',
  'linux/x86_64',
  ...(values['no-cache'] ? ['--no-cache'] : []),
  '-f',
  prebuilt ? 'Dockerfile.prebuilt' : 'Dockerfile',
  '-t',
  tag,
  '.',
];

run('docker', args);
