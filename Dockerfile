FROM node:20-bookworm-slim

WORKDIR /app

ENV npm_config_build_from_source=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev \
    && npm rebuild sqlite3 --build-from-source

COPY . .

EXPOSE 3001

CMD ["npm", "start"]
