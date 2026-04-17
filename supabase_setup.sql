-- Carroll Street Café POS - Supabase Setup
-- Run this entire file in your Supabase SQL Editor

-- 1. Sales table
CREATE TABLE IF NOT EXISTS sales (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  staff TEXT NOT NULL,
  items JSONB NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  note TEXT DEFAULT '',
  source TEXT DEFAULT 'pos' -- 'pos' or 'telegram'
);

-- 2. Menu items table (optional - for persistent menu edits)
CREATE TABLE IF NOT EXISTS menu_items (
  id BIGSERIAL PRIMARY KEY,
  cat TEXT NOT NULL,
  name TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  price2 NUMERIC(10,2),
  description TEXT DEFAULT '',
  hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Enable Row Level Security but allow all for now (you can tighten later)
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on sales" ON sales FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on menu_items" ON menu_items FOR ALL USING (true) WITH CHECK (true);

-- 4. Enable Realtime for live updates across all cashier phones
ALTER PUBLICATION supabase_realtime ADD TABLE sales;

-- Done! Note your Project URL and anon key from Settings > API
