# ── AutoTrader Backend — Node 20 Alpine ──────────────────────────────────────
# TypeScript is compiled by CI (GitHub Actions). This image just installs
# production deps and runs the pre-built dist/.
FROM node:20-alpine
RUN apk add --no-cache tini
WORKDIR /app

# Install production dependencies from lock file (includes all packages)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy pre-built output (shipped by CI deploy pipeline)
COPY dist ./dist

# Non-root user
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 5050
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
