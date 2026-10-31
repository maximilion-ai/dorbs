#!/bin/sh
# Starts the checker with its secrets read from files, since a PEM does not fit an EnvironmentFile.
set -eu
key="$HOME/.config/dorbs/github-app.pkcs8.pem"
if [ -f "$key" ]; then
  GITHUB_APP_PRIVATE_KEY="$(cat "$key")"
  export GITHUB_APP_PRIVATE_KEY
fi
CHECK_TOKEN="$(cat "${CHECK_TOKEN_FILE:-$HOME/.config/dorbs/check-token}")"
export CHECK_TOKEN
exec "${DORBS_CHECK:-$HOME/dorbs-checker/bin/dorbs-check}" serve
