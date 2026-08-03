FROM node:22.14.0-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm \
  npm ci

COPY . .

FROM node:22.14.0-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev

COPY --from=builder /app/src ./src

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "src/app.js"]