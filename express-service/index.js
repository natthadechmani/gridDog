'use strict';

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'express-service' },
  transports: [new winston.transports.Console()],
});

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/** Iterative fibonacci to avoid stack overflow on larger inputs. */
function fibonacci(n) {
  if (n <= 1) return n;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const tmp = a + b;
    a = b;
    b = tmp;
  }
  return b;
}

/** Return a Promise that resolves after `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Middleware: assign a unique Request-ID to every incoming request
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const requestId = uuidv4();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// ---------------------------------------------------------------------------
// Middleware: structured request/response logging
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const startAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;
    logger.info('request completed', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: parseFloat(durationMs.toFixed(3)),
      requestId: req.requestId,
    });
  });

  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'express-service' });
});

// GET /compute
// Simulates CPU-intensive work by computing fibonacci(30).
app.get('/compute', (req, res) => {
  const start = process.hrtime.bigint();

  const result = fibonacci(30);

  const computeTime = parseFloat(
    (Number(process.hrtime.bigint() - start) / 1_000_000).toFixed(3)
  );

  logger.info('computation completed', {
    requestId: req.requestId,
    result,
    computeTime,
  });

  res.json({ result, computeTime, requestId: req.requestId });
});

// GET /compute/timeout
// Sleeps for 15 seconds, which will exceed the Go backend's 10-second timeout.
app.get('/compute/timeout', async (req, res) => {
  logger.info('timeout computation started — will sleep for 15 s', {
    requestId: req.requestId,
  });

  await sleep(15_000);

  logger.info('timeout computation completed (Go timeout should have fired already)', {
    requestId: req.requestId,
  });

  res.json({
    result: fibonacci(10),
    computeTime: 15000,
    requestId: req.requestId,
  });
});

// GET /compute/error
// Returns a successful result ~50 % of the time; otherwise returns HTTP 500.
app.get('/compute/error', (req, res) => {
  const shouldFail = Math.random() < 0.5;

  if (shouldFail) {
    logger.warn('random computation failed', {
      requestId: req.requestId,
      code: 'COMPUTE_ERROR',
    });

    return res.status(500).json({
      error: 'random computation failed',
      code: 'COMPUTE_ERROR',
    });
  }

  const start = process.hrtime.bigint();
  const result = fibonacci(25);
  const computeTime = parseFloat(
    (Number(process.hrtime.bigint() - start) / 1_000_000).toFixed(3)
  );

  logger.info('error-route computation succeeded', {
    requestId: req.requestId,
    result,
    computeTime,
  });

  res.json({ result, computeTime, requestId: req.requestId });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3001', 10);

const server = app.listen(PORT, () => {
  logger.info('express-service started', { port: PORT });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);

  server.close((err) => {
    if (err) {
      logger.error('error during shutdown', { error: err.message });
      process.exit(1);
    }
    logger.info('server closed — exiting');
    process.exit(0);
  });

  // Force exit if the server hasn't closed within 10 seconds.
  setTimeout(() => {
    logger.error('shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
