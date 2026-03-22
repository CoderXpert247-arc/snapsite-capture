FROM node:20-slim

# Install system Chromium and dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libgtk-3-0 \
    libxss1 \
    libasound2 \
    fonts-liberation \
    fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js .

# HuggingFace Spaces requires port 7860
EXPOSE 7860
ENV PORT=7860

CMD ["node", "server.js"]
