# Public web presence (src/web) — self-contained Next.js + Fumadocs image.
# Built + deployed independently of the main app via `pnpm deploy_web` (build context = src/web).
# Multi-stage: deps -> build (next build, standalone output) -> runner (node server.js).
ARG NODE_VERSION=24.14.0

FROM node:${NODE_VERSION}-alpine AS base
# libc6-compat: musl shim some native deps (sharp/esbuild) expect.
RUN apk add --no-cache libc6-compat
# corepack is no longer pnpm's recommended install path — see root Dockerfile for the rationale.
RUN npm install --global pnpm@11.8.0
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

#
# Install dependencies (build scripts for esbuild/sharp are allow-listed in pnpm-workspace.yaml)
#
FROM base AS deps
# patches/ carries the TS7 presence-stub patch referenced by pnpm-workspace.yaml's
# patchedDependencies; pnpm install fails without it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

#
# Build (fumadocs-mdx generates .source, next build emits .next/standalone)
#
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

#
# Runtime — only the standalone server + static assets, run as non-root.
#
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
# Written by scripts/docker_build.mjs on the host before this build ran — /version reads it.
COPY --chown=nextjs:nodejs version.json ./version.json
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
