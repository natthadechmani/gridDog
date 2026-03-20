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
    if (req.path === '/health') return;
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

// GET /error/chaos
// Returns a random status: 200 (x2 weight), 429, 500, or 503 on every call.
app.get('/error/chaos', (req, res) => {
  const outcomes = [200, 200, 429, 500, 503];
  const status = outcomes[Math.floor(Math.random() * outcomes.length)];
  const messages = { 200: 'ok', 429: 'rate limit exceeded', 500: 'internal server error', 503: 'service unavailable' };
  const msg = messages[status];

  if (status !== 200) {
    logger.error(`Chaos endpoint returning ${status} — random status selected from pool [200,429,500,503]`, { requestId: req.requestId, status, message: msg });
    return res.status(status).json({ error: msg, simulated: true });
  }
  logger.info('Chaos endpoint returning 200 — random status selected from pool [200,429,500,503]', { requestId: req.requestId, status });
  res.json({ message: msg, simulated: true });
});

// GET /error/slow-fail
// Adds 300ms–1500ms delay then fails 40% of the time with 500.
app.get('/error/slow-fail', async (req, res) => {
  const delay = 300 + Math.floor(Math.random() * 1200);
  await sleep(delay);

  if (Math.random() < 0.4) {
    logger.error(`Slow-fail endpoint returning 500 — 40% failure rate triggered after ${delay}ms artificial delay`, { requestId: req.requestId, delay_ms: delay });
    return res.status(500).json({ error: 'simulated slow failure', delay_ms: delay, simulated: true });
  }
  logger.info(`Slow-fail endpoint returning 200 — 60% success rate passed after ${delay}ms artificial delay`, { requestId: req.requestId, delay_ms: delay });
  res.json({ message: 'ok', delay_ms: delay, simulated: true });
});

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
