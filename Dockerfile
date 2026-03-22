# ──────────────────────────────────────────────
# Claw — headless worker image
# Runs the pure-Node packages (gateway + agent + memory + cron + browser)
# WITHOUT Electron.  Suitable for server / CI / Docker deployment.
#
# For the full desktop app use the native Electron build instead.
# ──────────────────────────────────────────────

# ── Stage 1: build ───────────────────────────
FROM node:20-slim AS builder

# Puppeteer needs these libs at install time to download Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    gnupg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy manifests first (cache-friendly)
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./

COPY packages/memory/package.json        packages/memory/
COPY packages/skill-runner/package.json  packages/skill-runner/
COPY packages/browser/package.json       packages/browser/
COPY packages/agent/package.json         packages/agent/
COPY packages/gateway/package.json       packages/gateway/
COPY packages/cron/package.json          packages/cron/

# Install all workspace deps (including devDeps for tsc)
# Skip electron — not needed for worker
RUN npm install --ignore-scripts \
  && npx puppeteer browsers install chrome

# Copy source
COPY packages/ packages/
COPY skills/   skills/

# Build all packages
RUN npm run build:packages

# ── Stage 2: runtime ─────────────────────────
FROM node:20-slim AS runtime

# Chromium runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium instead of bundled
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy built output
COPY --from=builder /build/packages/memory/dist        packages/memory/dist
COPY --from=builder /build/packages/skill-runner/dist  packages/skill-runner/dist
COPY --from=builder /build/packages/browser/dist       packages/browser/dist
COPY --from=builder /build/packages/agent/dist         packages/agent/dist
COPY --from=builder /build/packages/gateway/dist       packages/gateway/dist
COPY --from=builder /build/packages/cron/dist          packages/cron/dist

# Package manifests (for workspace resolution)
COPY --from=builder /build/packages/memory/package.json        packages/memory/
COPY --from=builder /build/packages/skill-runner/package.json  packages/skill-runner/
COPY --from=builder /build/packages/browser/package.json       packages/browser/
COPY --from=builder /build/packages/agent/package.json         packages/agent/
COPY --from=builder /build/packages/gateway/package.json       packages/gateway/
COPY --from=builder /build/packages/cron/package.json          packages/cron/

COPY --from=builder /build/package.json   .
COPY --from=builder /build/node_modules   node_modules/
COPY --from=builder /build/skills/        skills/

# Config is mounted at runtime (contains secrets)
# COPY claw.config.toml .   ← do NOT bake secrets into image

# Claw DB persisted via volume
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV CLAW_DB_PATH=/app/data/claw.db
ENV CLAW_LOG_DIR=/app/data/logs

EXPOSE 3000

# TODO (step 6+): replace with actual gateway entrypoint
CMD ["node", "packages/gateway/dist/index.js"]
