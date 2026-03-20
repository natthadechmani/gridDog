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
