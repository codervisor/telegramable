FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# ---- Build ----
FROM base AS builder
WORKDIR /app

# Install deps (separate layer for caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.json ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/tsconfig/package.json ./packages/tsconfig/package.json
COPY packages/tsconfig/base.json ./packages/tsconfig/base.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN pnpm install --frozen-lockfile

# Build all packages
COPY packages/ ./packages/
COPY apps/ ./apps/
RUN pnpm --filter @telegramable/core build && \
    pnpm --filter @telegramable/cli build && \
    pnpm --filter @telegramable/web build

# Create self-contained CLI bundle (resolves workspace symlinks)
RUN pnpm deploy --filter @telegramable/cli --prod /deploy/cli

# ---- Run ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Create non-root user (required: Claude CLI refuses --dangerously-skip-permissions as root)
RUN groupadd -r claude && useradd -r -g claude -m -d /home/claude claude

# Install Claude Code CLI as non-root user
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates gosu && \
    su claude -c 'curl -fsSL https://claude.ai/install.sh | bash' && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
ENV PATH="/home/claude/.local/bin:/home/claude/.claude/local/bin:${PATH}"

# Web — Next.js standalone output
COPY --from=builder /app/apps/web/.next/standalone ./web/
COPY --from=builder /app/apps/web/.next/static ./web/apps/web/.next/static
COPY --from=builder /app/apps/web/public ./web/apps/web/public

# CLI — deployed bundle with all deps resolved
COPY --from=builder /deploy/cli ./cli/

COPY start.sh ./
RUN chmod +x ./start.sh

# Persistent data directory — mount a Railway Volume (or Docker volume) at /data.
# Without a volume, all data (SQLite DBs, agent sessions, workspace files) is lost on redeploy.
# See README.md "Railway" section for setup instructions.
RUN mkdir -p /data && chown claude:claude /data

# Ensure the non-root user owns the app directory
RUN chown -R claude:claude /app

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# NOTE: We intentionally do NOT set `USER claude` here.
# start.sh runs as root to fix /data volume permissions (Railway volumes mount
# as root, overriding the Dockerfile's chown), then drops to the `claude` user
# via `exec gosu claude` before starting the application processes.
CMD ["./start.sh"]
