FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/data/logs

EXPOSE 3000

# Core config
ENV PORT=3000
ENV ADMIN_PASSWORD=admin123
ENV OLLAMA_BASE_URL=https://ollama.com/api
ENV HEALTH_CHECK_INTERVAL=60
ENV CACHE_EMBEDDINGS=true
ENV CACHE_CHAT=false
ENV LOG_LEVEL=info
ENV LOG_TO_FILE=true

# Rate limiting defaults
ENV RATE_LIMIT_GLOBAL_ENABLED=true
ENV RATE_LIMIT_IP_ENABLED=true
ENV RATE_LIMIT_TOKEN_ENABLED=true

# Persistent data volume
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/app.js"]
