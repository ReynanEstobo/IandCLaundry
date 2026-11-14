-- A free-load loyalty reward covers one load of the order's first service at
-- that service's own load size and price. create_branch_order already records
-- the service's load size and deducts its load price, but this check required
-- exactly 8 kg, so a qualifying order whose first service used another load
-- size (for example a 4 kg comforter load) was rejected. Existing 8 kg rewards
-- remain valid.
BEGIN;

ALTER TABLE public.loyalty_rewards DROP CONSTRAINT IF EXISTS loyalty_reward_snapshot_check;
ALTER TABLE public.loyalty_rewards ADD CONSTRAINT loyalty_reward_snapshot_check CHECK (
  (reward_type = 'percentage_discount' AND discount_percent IS NOT NULL AND free_load_kg IS NULL)
  OR (reward_type = 'free_load' AND free_load_kg IS NOT NULL AND free_load_kg > 0 AND discount_percent IS NULL)
);

COMMIT;
