FROM golang:1.21-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o sentinel-guard .

FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/sentinel-guard .

# Ensure certs and wal directories exist
RUN mkdir -p /var/sentinel/certs /var/sentinel/wal
# Dummy cert generation for testing (in prod this is injected via Secret)
RUN apk add --no-cache openssl && \
    openssl req -x509 -newkey rsa:4096 -keyout /var/sentinel/certs/ca.key -out /var/sentinel/certs/ca.crt -days 365 -nodes -subj "/CN=Sentinel CA" && \
    openssl req -newkey rsa:4096 -keyout /var/sentinel/certs/server.key -out server.csr -nodes -subj "/CN=sentinel-sidecar" && \
    openssl x509 -req -in server.csr -CA /var/sentinel/certs/ca.crt -CAkey /var/sentinel/certs/ca.key -CAcreateserial -out /var/sentinel/certs/server.crt -days 365 && \
    openssl req -newkey rsa:4096 -keyout /var/sentinel/certs/client.key -out client.csr -nodes -subj "/CN=sentinel-client" && \
    openssl x509 -req -in client.csr -CA /var/sentinel/certs/ca.crt -CAkey /var/sentinel/certs/ca.key -CAcreateserial -out /var/sentinel/certs/client.crt -days 365

CMD ["./sentinel-guard"]
