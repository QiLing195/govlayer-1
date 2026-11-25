FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json vite.config.ts server.ts metadata.json ./
COPY src/ ./src/
COPY client/ ./client/
COPY data/ ./data/

RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.ts"]
