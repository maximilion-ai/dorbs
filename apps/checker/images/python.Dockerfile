# Python with uv, which installs other Python versions into the environment when a repo pins one.
FROM ghcr.io/astral-sh/uv:latest AS uv
FROM python:3.13-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
LABEL dorbs.checker.image=python
