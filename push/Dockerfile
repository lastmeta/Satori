# The daily push server (push/server.mjs, docs/design/push.md): Node's own modules only, no npm install.
#   docker build -f push/Dockerfile -t satori-push push/
#   docker run -d --name satori-push --network central-lite_default -v /root/satori-push/data:/data \
#     -e RPC_URL=… -e TOKEN=0x… -e ENGINE=0x… satori-push
# node 22.23.3 (LTS), alpine, built 2026-09-23; the digest is the tag's index.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY push.mjs server.mjs ./
USER node
ENV DATA=/data PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
