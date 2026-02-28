# Dockerfile for the mors relay service.
#
# Multi-stage build: compile TypeScript in a build stage, then copy
# only the compiled output + production dependencies into a slim runtime image.
#
# The relay entrypoint does NOT require SQLCipher (that's a local-only dependency),
# so we use a standard Node.js base image without native build tools in the
# final stage.

# ── Build stage ──────────────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for tsc)
# Skip prepare script during Docker build to avoid circular build issues
RUN npm ci --ignore-scripts

# Copy source files
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/

# Build TypeScript
RUN npx tsc -p tsconfig.build.json

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only, skip lifecycle scripts
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Relay listens on PORT (default 3100, configurable via env)
ENV PORT=3100
EXPOSE 3100

# Run the relay entrypoint
CMD ["node", "dist/relay/index.js"]
