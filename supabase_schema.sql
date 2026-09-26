-- ============================================
-- I&C LAUNDRY - Supabase Database Schema
-- Run this in Supabase SQL Editor
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- STAFF
-- ============================================
CREATE TABLE staff (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  auth_id UUID,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  position TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CUSTOMERS
-- ============================================
CREATE TABLE customers (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  address TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- SERVICE TYPES
-- ============================================
CREATE TABLE service_types (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name TEXT NOT NULL,
  price_per_kg NUMERIC(10,2) NOT NULL DEFAULT 0,
  estimated_minutes INTEGER NOT NULL DEFAULT 60,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default services
INSERT INTO service_types (name, price_per_kg, estimated_minutes, description) VALUES
  ('Regular Wash', 40.00, 120, 'Standard wash and dry'),
  ('Rush Wash', 70.00, 60, 'Priority processing - ready in 1 hour'),
  ('Dry Clean', 100.00, 1440, 'Professional dry cleaning - 24hrs'),
  ('Wash & Fold', 50.00, 180, 'Wash, dry, and neatly folded'),
  ('Beddings & Comforter', 120.00, 240, 'Large items wash and dry');

-- ============================================
-- ORDERS
-- ============================================
CREATE TABLE orders (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  service_type_id UUID REFERENCES service_types(id),
  weight_kg NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','washing','drying','folding','ready','released','cancelled')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid')),
  payment_method TEXT CHECK (payment_method IN ('cash','gcash','bank_transfer','card')),
  notes TEXT,
  estimated_completion TIMESTAMPTZ,
  actual_completion TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  stage_started_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INVENTORY CATEGORIES
-- ============================================
CREATE TABLE inventory_categories (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO inventory_categories (name) VALUES
  ('Detergent'),
  ('Fabric Softener'),
  ('Bleach'),
  ('Powder Soap'),
  ('Plastic Bags'),
  ('Hangers'),
  ('Stain Remover');

-- ============================================
-- INVENTORY ITEMS
-- ============================================
CREATE TABLE inventory_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  category_id UUID REFERENCES inventory_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  current_stock NUMERIC(10,2) NOT NULL DEFAULT 0,
  minimum_stock NUMERIC(10,2) NOT NULL DEFAULT 0,
  cost_per_unit NUMERIC(10,2) NOT NULL DEFAULT 0,
  usage_per_load NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INVENTORY USAGE LOG (for predictions)
-- ============================================
CREATE TABLE inventory_usage_log (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  item_id UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity_used NUMERIC(10,4) NOT NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  logged_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INVENTORY RESTOCK LOG
-- ============================================
CREATE TABLE inventory_restocks (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  item_id UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity_added NUMERIC(10,2) NOT NULL,
  cost_total NUMERIC(10,2),
  supplier TEXT,
  restocked_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- SMS LOG
-- ============================================
CREATE TABLE sms_log (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  provider_response JSONB,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- EXPENSES (for analytics)
-- ============================================
CREATE TABLE expenses (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  category TEXT NOT NULL,
  description TEXT,
  amount NUMERIC(10,2) NOT NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ROW-LEVEL SECURITY
-- ============================================
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_restocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_categories ENABLE ROW LEVEL SECURITY;

-- Policies: allow authenticated users full access
CREATE POLICY "Authenticated full access" ON customers FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated full access" ON staff FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated full access" ON orders FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated full access" ON inventory_items FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated full access" ON inventory_usage_log FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated full access" ON inventory_restocks FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated full access" ON sms_log FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated full access" ON expenses FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated full access" ON service_types FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated full access" ON inventory_categories FOR ALL USING (auth.role() = 'authenticated');

-- Public read-only access for order tracking (anonymous users on landing page)
CREATE POLICY "Public read orders for tracking" ON orders FOR SELECT USING (true);
CREATE POLICY "Public read customers for tracking" ON customers FOR SELECT USING (true);
CREATE POLICY "Public read service_types for tracking" ON service_types FOR SELECT USING (true);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Auto-generate order number
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER AS $$
BEGIN
  NEW.order_number := 'IC-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_generate_order_number
  BEFORE INSERT ON orders
  FOR EACH ROW
  WHEN (NEW.order_number IS NULL)
  EXECUTE FUNCTION generate_order_number();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_staff_updated_at BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_inventory_items_updated_at BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- MULTI-SERVICE ORDER EXTENSION (2026-09-19)
-- The production schema is evolved by the timestamped migrations. This
-- reference records the current additions without removing legacy order fields.
-- ============================================
ALTER TABLE service_types
  ADD COLUMN IF NOT EXISTS pricing_type TEXT NOT NULL DEFAULT 'per_kg' CHECK (pricing_type IN ('bundle','per_kg','per_piece','fixed')),
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS processing_type TEXT NOT NULL DEFAULT 'full_service' CHECK (processing_type IN ('full_service','air_dry_only'));

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  service_type_id UUID REFERENCES service_types(id) ON DELETE RESTRICT,
  service_name_snapshot TEXT NOT NULL,
  pricing_type_snapshot TEXT NOT NULL,
  processing_type_snapshot TEXT NOT NULL,
  weight_kg NUMERIC(10,2), quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price_snapshot NUMERIC(12,2) NOT NULL, subtotal NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','on_process','completed','cancelled')),
  notes TEXT, processing_started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_inventory_requirements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  service_type_id UUID NOT NULL REFERENCES service_types(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  usage_basis TEXT NOT NULL CHECK (usage_basis IN ('per_kg','per_piece','per_order')),
  quantity_per_unit NUMERIC(12,4) NOT NULL CHECK (quantity_per_unit > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(branch_id, service_type_id, inventory_item_id)
);

ALTER TABLE inventory_usage_log
  ADD COLUMN IF NOT EXISTS order_item_id UUID REFERENCES order_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS service_inventory_requirement_id UUID REFERENCES service_inventory_requirements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deduction_key TEXT,
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'Automatic service consumption';
