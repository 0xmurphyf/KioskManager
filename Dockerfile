# syntax=docker/dockerfile:1

FROM node:22-bookworm AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
COPY --from=build /app/memory_archive ./memory_archive

RUN mkdir -p /app/server/data/uploads
VOLUME ["/app/server/data"]

EXPOSE 3000

CMD ["node", "--experimental-sqlite", "server/index.mjs"]
