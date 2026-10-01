FROM node:22-slim

WORKDIR /app
# The image only runs in production (Railway builds it from this file).
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "server.js"]
