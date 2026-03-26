FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# ---- Build ----
FROM base AS builder
WORKDIR /app

# Install deps (separate layer for caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
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
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Web — Next.js standalone output
COPY --from=builder /app/apps/web/.next/standalone ./web/
COPY --from=builder /app/apps/web/.next/static ./web/apps/web/.next/static
COPY --from=builder /app/apps/web/public ./web/apps/web/public

# CLI — deployed bundle with all deps resolved
COPY --from=builder /deploy/cli ./cli/

COPY start.sh ./
RUN chmod +x ./start.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["./start.sh"]
