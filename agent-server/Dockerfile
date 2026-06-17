# ── Build stage ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# ── Runtime stage ──────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=builder /app/dist ./dist

EXPOSE 4747

ENTRYPOINT ["node", "dist/index.js"]
# Default to normal mode; override with: docker run ... agent-server --mode chaos
CMD []
