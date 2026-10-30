-- Close direct database access through Supabase's public API keys.
--
-- The browser never talks to Supabase directly: every read and write goes
-- through the Cloudflare Worker, which uses the service_role key. That role
-- bypasses row-level security and keeps its own grants, so the application is
-- unaffected. The anon key is used only for Supabase Auth sign-in, which does
-- not depend on anything below.
--
-- Before this migration, anyone holding the anon key (it was published in the
-- repository history) could read every customer and order through the
-- original permissive policies, read and write tables that never enabled
-- row-level security (payments, settings, branches, ...), and call operation
-- functions such as create_branch_order as any staff member. Supabase grants
-- anon and authenticated their own EXECUTE and table privileges by default, so
-- earlier `REVOKE ... FROM PUBLIC` statements alone did not remove them.
--
-- New functions in public still receive PostgreSQL's built-in EXECUTE grant to
-- PUBLIC. Keep revoking it in each migration, as recent migrations do:
--   REVOKE ALL ON FUNCTION public.f(...) FROM PUBLIC, anon, authenticated;
--
-- Safe to run more than once.

BEGIN;

-- 1. The original schema's permissive policies. PostgreSQL combines
--    permissive policies with OR, so these made the branch-isolation policies
--    ineffective and exposed customers and orders to anonymous requests.
DROP POLICY IF EXISTS "Authenticated full access" ON public.customers;
DROP POLICY IF EXISTS "Authenticated full access" ON public.staff;
DROP POLICY IF EXISTS "Authenticated full access" ON public.orders;
DROP POLICY IF EXISTS "Authenticated full access" ON public.inventory_items;
DROP POLICY IF EXISTS "Authenticated full access" ON public.inventory_usage_log;
DROP POLICY IF EXISTS "Authenticated full access" ON public.inventory_restocks;
DROP POLICY IF EXISTS "Authenticated full access" ON public.sms_log;
DROP POLICY IF EXISTS "Authenticated full access" ON public.expenses;
DROP POLICY IF EXISTS "Authenticated full access" ON public.service_types;
DROP POLICY IF EXISTS "Authenticated full access" ON public.inventory_categories;
DROP POLICY IF EXISTS "Public read orders for tracking" ON public.orders;
DROP POLICY IF EXISTS "Public read customers for tracking" ON public.customers;
DROP POLICY IF EXISTS "Public read service_types for tracking" ON public.service_types;

-- 2. Row-level security on every table, including those created without it.
--    With no policy for anon or authenticated, those roles see no rows.
DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.relname);
  END LOOP;
END $$;

-- 3. No direct table, sequence or function access for the public API roles.
--    Order tracking, public settings and the contact form are served by the
--    Worker with service_role, not by these roles.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- 4. Tables, sequences and functions created later in public are not granted
--    to the public API roles either.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

COMMIT;
