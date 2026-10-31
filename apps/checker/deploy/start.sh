#!/bin/sh
# Starts the checker with the GitHub App key read from its file, since a PEM does not fit an EnvironmentFile.
set -eu
key="$HOME/.config/dorbs/github-app.pkcs8.pem"
if [ -f "$key" ]; then
  GITHUB_APP_PRIVATE_KEY="$(cat "$key")"
  export GITHUB_APP_PRIVATE_KEY
fi
CHECK_TOKEN="$(cat "$HOME/.config/dorbs/check-token")"
export CHECK_TOKEN
cd "$(dirname "$0")/.."
exec node src/main.ts
