# Python with uv, which installs other Python versions into the environment when a repo pins one.
# libatomic1 is for the Node that the pyright wheel downloads.
FROM ghcr.io/astral-sh/uv:latest AS uv
FROM python:3.13-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates libatomic1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
LABEL dorbs.checker.image=python
