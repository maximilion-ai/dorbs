# Build from the repo root: docker build -f apps/typecheck/Dockerfile .
FROM node:26-slim

ARG PNPM_VERSION=12.15.0
ARG TSRS_VERSION=0.20.0-ts7.1.0-beta
ARG OXLINT_VERSION=1.89.0
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "pnpm@${PNPM_VERSION}"

# Native binaries on PATH, so a check spawns no Node launcher.
RUN case "${TARGETARCH}" in \
      amd64) tsrs_arch=x64; oxlint_arch=x86_64 ;; \
      arm64) tsrs_arch=arm64; oxlint_arch=aarch64 ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && npm install --prefix /opt/tsrs "@tsrs/linux-${tsrs_arch}-gnu@${TSRS_VERSION}" \
  && ln -s "/opt/tsrs/node_modules/@tsrs/linux-${tsrs_arch}-gnu/tsrs" /usr/local/bin/tsrs \
  && curl -fsSL "https://github.com/oxc-project/oxc/releases/download/oxlint_v${OXLINT_VERSION}/oxlint-${oxlint_arch}-unknown-linux-gnu.tar.gz" \
    | tar -xz -C /usr/local/bin \
  && mv "/usr/local/bin/oxlint-${oxlint_arch}-unknown-linux-gnu" /usr/local/bin/oxlint \
  && tsrs --version && oxlint --version

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/oxlint-plugin/package.json packages/oxlint-plugin/
COPY apps/typecheck/package.json apps/typecheck/
RUN pnpm install --frozen-lockfile --prod --filter @dorbs/typecheck...

COPY packages/protocol/src packages/protocol/src
COPY apps/typecheck/src apps/typecheck/src

ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8080
WORKDIR /app/apps/typecheck
CMD ["node", "src/main.ts"]
