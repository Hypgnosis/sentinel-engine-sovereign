FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download || true
COPY . .
RUN go build -o sidecar .

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/sidecar .
# Need to create volume mount points
RUN mkdir -p /var/run/sentinel /var/sentinel/wal
CMD ["./sidecar"]
