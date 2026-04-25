# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM golang:1.25-alpine AS builder

# Install git and ca-certificates (needed for go mod download over HTTPS)
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /app

# Download dependencies first (layer cache)
COPY go.mod go.sum ./
RUN go mod download

# Copy source and build a statically linked binary
COPY . .

# Install Orchestrion
RUN go install github.com/DataDog/orchestrion@latest

# Build with Orchestrion instrumentation
RUN GOARCH=amd64 orchestrion go build \
    -o /app/server .

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM alpine:3.19

# ca-certificates for outbound TLS, tzdata for correct time zones
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S appgroup && \
    adduser  -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /app/server .

# Run as non-root user
USER appuser

EXPOSE 8080

ENTRYPOINT ["/app/server"]
