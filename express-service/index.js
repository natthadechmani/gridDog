'use strict';

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const { MongoClient } = require('mongodb');

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
// MongoDB — shop_items collection
// ---------------------------------------------------------------------------
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/griddog';

const SEED_ITEMS = [
  { id: 'tshirt',   name: 'Datadog T-Shirt',  price: 29.99, icon: '👕' },
  { id: 'hoodie',   name: 'Datadog Hoodie',    price: 59.99, icon: '🧥' },
  { id: 'sticker',  name: 'Sticker Pack',      price:  9.99, icon: '🐶' },
  { id: 'plush',    name: 'Dog Plush Toy',      price: 19.99, icon: '🧸' },
  { id: 'mug',      name: 'Datadog Mug',        price: 14.99, icon: '☕' },
  { id: 'notebook', name: 'Datadog Notebook',   price: 12.99, icon: '📓' },
];

let mongoDb = null;

async function connectMongo() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    mongoDb = client.db();
    logger.info(`GET /shop/items — mongodb connected`, { uri: MONGODB_URI });

    // Seed shop_items if the collection is empty
    const col = mongoDb.collection('shop_items');
    const count = await col.countDocuments();
    if (count === 0) {
      await col.insertMany(SEED_ITEMS);
      logger.info(`mongodb shop_items collection seeded with ${SEED_ITEMS.length} items`, {
        item_count: SEED_ITEMS.length,
        items: SEED_ITEMS.map((i) => i.id),
      });
    } else {
      logger.info(`mongodb shop_items collection already has ${count} item(s) — skipping seed`, {
        item_count: count,
      });
    }
  } catch (err) {
    logger.error(`mongodb connection failed — GET /shop/items will return 503`, {
      uri: MONGODB_URI,
      error: err.message,
    });
  }
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
// Route label map — used by the audit middleware to replace the generic
// "request completed" message with something route-specific.
// ---------------------------------------------------------------------------
const routeLabel = {
  'GET /shop/items':      'GET /shop/items — fetch all shop items from mongodb',
  'GET /error/chaos':     'GET /error/chaos — random status (200/429/500/503)',
  'GET /error/slow-fail': 'GET /error/slow-fail — artificial delay + 40% failure rate',
  'GET /compute':         'GET /compute — fibonacci(30) computation',
  'GET /compute/timeout': 'GET /compute/timeout — intentional 15s delay',
  'GET /compute/error':   'GET /compute/error — 50% random failure',
};

// ---------------------------------------------------------------------------
// Middleware: structured request/response audit log
// Handlers can enrich this log by setting req.logFields = { ... }
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const startAt = process.hrtime.bigint();

  res.on('finish', () => {
    if (req.path === '/health') return;
    const durationMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;
    const key = `${req.method} ${req.path}`;
    const msg = routeLabel[key] || key;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](msg, {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: parseFloat(durationMs.toFixed(3)),
      requestId: req.requestId,
      ...(req.logFields || {}),
    });
  });

  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /shop/items
// Fetches the full shop catalogue from MongoDB.
// Returns 503 if MongoDB is not connected.
app.get('/shop/items', async (req, res) => {
  if (!mongoDb) {
    logger.error('GET /shop/items — 503 mongodb not connected', { requestId: req.requestId });
    return res.status(503).json({ error: 'database unavailable', detail: 'mongodb not connected' });
  }
  try {
    const items = await mongoDb.collection('shop_items').find({}, { projection: { _id: 0 } }).toArray();
    req.logFields = { item_count: items.length, source: 'mongodb' };
    logger.info(`GET /shop/items — fetched ${items.length} item(s) from mongodb`, {
      requestId: req.requestId,
      item_count: items.length,
      items: items.map((i) => i.id),
    });
    res.json(items);
  } catch (err) {
    req.logFields = { error: err.message };
    logger.error(`GET /shop/items — 500 mongodb query failed: ${err.message}`, {
      requestId: req.requestId,
      error: err.message,
    });
    res.status(500).json({ error: 'query failed', detail: err.message });
  }
});

// GET /error/chaos
// Returns a random status: 200 (x2 weight), 429, 500, or 503 on every call.
app.get('/error/chaos', (req, res) => {
  const outcomes = [200, 200, 429, 500, 503];
  const status = outcomes[Math.floor(Math.random() * outcomes.length)];
  const messages = { 200: 'ok', 429: 'rate limit exceeded', 500: 'internal server error', 503: 'service unavailable' };
  const msg = messages[status];

  req.logFields = { status, chaos_message: msg, outcome: status === 200 ? 'success' : 'error' };

  if (status !== 200) {
    logger.error(`GET /error/chaos — ${status} ${msg}`, { requestId: req.requestId, status, message: msg, outcome: 'error' });
    return res.status(status).json({ error: msg, simulated: true });
  }
  logger.info('GET /error/chaos — 200 ok', { requestId: req.requestId, status, outcome: 'success' });
  res.json({ message: msg, simulated: true });
});

// GET /error/slow-fail
// Adds 300ms–1500ms delay then fails 40% of the time with 500.
app.get('/error/slow-fail', async (req, res) => {
  const delay = 300 + Math.floor(Math.random() * 1200);
  await sleep(delay);

  if (Math.random() < 0.4) {
    req.logFields = { delay_ms: delay, outcome: 'error' };
    logger.error(`GET /error/slow-fail — 500 after ${delay}ms (40% failure rate triggered)`, { requestId: req.requestId, delay_ms: delay, outcome: 'error' });
    return res.status(500).json({ error: 'simulated slow failure', delay_ms: delay, simulated: true });
  }
  req.logFields = { delay_ms: delay, outcome: 'success' };
  logger.info(`GET /error/slow-fail — 200 ok after ${delay}ms (60% pass)`, { requestId: req.requestId, delay_ms: delay, outcome: 'success' });
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

  req.logFields = { result, computeTime };
  logger.info(`GET /compute — fibonacci(30)=${result} in ${computeTime}ms`, {
    requestId: req.requestId,
    result,
    computeTime,
  });

  res.json({ result, computeTime, requestId: req.requestId });
});

// GET /compute/timeout
// Sleeps for 15 seconds, which will exceed the Go backend's 10-second timeout.
app.get('/compute/timeout', async (req, res) => {
  logger.info('GET /compute/timeout — sleeping 15s (intentional timeout simulation)', {
    requestId: req.requestId,
  });

  await sleep(15_000);

  const result = fibonacci(10);
  req.logFields = { result, intentional_delay_ms: 15000 };
  logger.info(`GET /compute/timeout — woke after 15s, fibonacci(10)=${result} (Go timeout should have already fired)`, {
    requestId: req.requestId,
    result,
    intentional_delay_ms: 15000,
  });

  res.json({
    result,
    computeTime: 15000,
    requestId: req.requestId,
  });
});

// GET /compute/error
// Returns a successful result ~50% of the time; otherwise returns HTTP 500.
app.get('/compute/error', (req, res) => {
  const shouldFail = Math.random() < 0.5;

  if (shouldFail) {
    req.logFields = { code: 'COMPUTE_ERROR', outcome: 'error' };
    logger.error('GET /compute/error — 500 random failure (50% roll failed)', {
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

  req.logFields = { result, computeTime, outcome: 'success' };
  logger.info(`GET /compute/error — fibonacci(25)=${result} in ${computeTime}ms (50% roll passed)`, {
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
  connectMongo();
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
