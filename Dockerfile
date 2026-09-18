FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.js server.js loudness.js cache.js ./

ENV NODE_ENV=production
ENV PORT=3100
ENV MAX_DOWNLOAD_BYTES=67108864
ENV REQUEST_TIMEOUT_MS=30000
ENV REDIS_URL=redis://redis:6379

USER node
EXPOSE 3100
CMD ["node", "index.js"]
