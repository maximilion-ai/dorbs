# Go without cgo. The module cache and build cache live in the environment.
FROM golang:1-alpine
RUN apk add --no-cache git
ENV CGO_ENABLED=0
LABEL dorbs.checker.image=go
