# リポジトリのルートで次のようにビルドする（通常は examples/compose.yaml から使う）。
#   docker build -f examples/backend/Dockerfile -t sealpix-example-backend .
FROM node:24-alpine

WORKDIR /app
COPY examples/backend ./examples/backend

USER node
EXPOSE 8080
CMD ["node", "examples/backend/src/main.ts"]
