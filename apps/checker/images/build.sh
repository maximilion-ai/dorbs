#!/bin/sh
# Builds the checker's images in the local Docker daemon: dorbs-checker/<ecosystem>:1.
set -eu
cd "$(dirname "$0")"
for ecosystem in node python rust go; do
  docker build --quiet -t "dorbs-checker/$ecosystem:1" -f "$ecosystem.Dockerfile" . 
done
