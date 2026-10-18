# リポジトリのルートで次のようにビルドする。
#   docker build -f packages/decrypt-server/Dockerfile -t sealpix-decrypt-server .
# 外部のパッケージは使わないので、npm ci はワークスペースのリンクを作るだけになる。
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core ./packages/core
COPY packages/server-common ./packages/server-common
COPY packages/decrypt-server ./packages/decrypt-server
RUN npm ci --omit=dev --ignore-scripts --workspace @sealpix/decrypt-server \
  && rm -rf packages/*/test

USER node
ENV SEALPIX_DECRYPT_CONFIG=/config/config.json
EXPOSE 8710
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -q -O /dev/null http://127.0.0.1:8710/healthz || exit 1
CMD ["node", "packages/decrypt-server/src/main.ts"]
