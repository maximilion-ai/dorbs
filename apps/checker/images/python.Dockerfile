# Python with uv, which installs other Python versions into the environment when a repo pins one,
# and Node with npm, which the pyright wheel runs instead of downloading a Node of its own.
FROM ghcr.io/astral-sh/uv:latest AS uv
FROM node:24-slim AS node
FROM python:3.13-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
# The environment's venv is the active one, so type checkers resolve imports from it.
ENV VIRTUAL_ENV=/env/repo/.venv PATH=/env/repo/.venv/bin:$PATH
LABEL dorbs.checker.image=python
