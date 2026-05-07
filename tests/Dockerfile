FROM golang:alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download || true
COPY bridge_test_proxy.go .
RUN go build -o bridge-proxy bridge_test_proxy.go

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/bridge-proxy .
EXPOSE 9090
CMD ["./bridge-proxy"]
