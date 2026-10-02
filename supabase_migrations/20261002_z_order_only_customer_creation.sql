-- Customer identities are created only by the secure order-placement workflow.
-- Existing customers remain editable and visible; this removes only the
-- standalone registration RPC previously used by the Customers page.

BEGIN;

DROP FUNCTION IF EXISTS public.register_branch_customer(UUID, UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.register_branch_customer(UUID, UUID, TEXT, TEXT, TEXT, TEXT);

COMMIT;
