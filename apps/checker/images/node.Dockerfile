# Node with corepack's pnpm and yarn shims, and bun, for the node ecosystem's environments.
FROM oven/bun:1-slim AS bun
FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx
LABEL dorbs.checker.image=node
