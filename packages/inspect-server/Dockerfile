# リポジトリのルートで次のようにビルドする。
#   docker build -f packages/inspect-server/Dockerfile -t sealpix-inspect-server .
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core ./packages/core
COPY packages/server-common ./packages/server-common
COPY packages/inspect-server ./packages/inspect-server
COPY templates ./templates
RUN npm ci --omit=dev --ignore-scripts --workspace @sealpix/inspect-server \
  && rm -rf packages/*/test

USER node
ENV SEALPIX_INSPECT_CONFIG=/config/config.json
EXPOSE 8711
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -q -O /dev/null http://127.0.0.1:8711/healthz || exit 1
CMD ["node", "packages/inspect-server/src/main.ts"]
