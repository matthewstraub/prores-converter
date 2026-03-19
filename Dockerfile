# ---- Stage 1: Build ----
FROM node:22-slim AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

WORKDIR /app

# Copy package files first for better caching
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the frontend (Vite) and bundle the server (esbuild)
RUN pnpm build

# ---- Stage 2: Production ----
FROM node:22-slim

# Install FFmpeg (includes ffprobe)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/
RUN pnpm install --frozen-lockfile --prod

# Copy built output from builder
COPY --from=builder /app/dist ./dist

# Create temp directory for video processing
RUN mkdir -p /tmp/prores-converter

# Expose the port (Render uses PORT env var)
EXPOSE 3000

# Start the production server
CMD ["node", "dist/index.js"]
