# ── AutoTrader Backend — Node 20 Alpine ──────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app

# Copy only built output + production deps
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Non-root user
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 5050
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
