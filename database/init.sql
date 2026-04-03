-- gridDog database initialisation
-- Assumes the target database (griddog) already exists and is the active connection.

CREATE TABLE IF NOT EXISTS items (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255)             NOT NULL,
    value      NUMERIC(10, 2)           NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE          DEFAULT NOW()
);

-- Seed data (idempotent — skipped on conflict)
INSERT INTO items (name, value) VALUES
    ('item-alpha',   100.50),
    ('item-beta',    200.75),
    ('item-gamma',    50.25),
    ('item-delta',   300.00),
    ('item-epsilon', 150.00)
ON CONFLICT DO NOTHING;

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS idx_items_created_at ON items (created_at);
CREATE INDEX IF NOT EXISTS idx_items_name       ON items (name);

-- ---------------------------------------------------------------------------
-- Promo codes (used by Flow 10 — e-commerce checkout simulation)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS promo_codes (
    id               SERIAL PRIMARY KEY,
    code             VARCHAR(50) UNIQUE NOT NULL,
    discount_percent INT                NOT NULL,
    is_active        BOOLEAN            NOT NULL DEFAULT true
);

-- Seed promo codes (idempotent — skipped on conflict)
INSERT INTO promo_codes (code, discount_percent, is_active) VALUES
    ('10OFF', 10, true),
    ('15OFF', 15, true),
    ('20OFF', 20, true),
    ('50OFF', 50, true)
ON CONFLICT DO NOTHING;
