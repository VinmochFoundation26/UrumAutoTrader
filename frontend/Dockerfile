# ── AutoTrader Frontend — Vite build → Nginx ─────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Build accepts VITE_ vars at build time via --build-arg
ARG VITE_API_URL=/api
ARG VITE_USER_ADDRESS
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_USER_ADDRESS=$VITE_USER_ADDRESS
RUN npm run build

# ── Production: Nginx serving static files ────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx-spa.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
