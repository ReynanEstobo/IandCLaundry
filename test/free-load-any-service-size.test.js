import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// The reward table as created by 20260909_cross_branch_loyalty_program.sql,
// whose snapshot check accepted only 8 kg free loads.
const REWARDS_BEFORE = `
  CREATE TABLE public.loyalty_rewards (
    id serial PRIMARY KEY,
    reward_type text NOT NULL CHECK (reward_type IN ('percentage_discount', 'free_load')),
    discount_percent integer CHECK (discount_percent BETWEEN 1 AND 100),
    free_load_kg numeric(6,2),
    CONSTRAINT loyalty_reward_snapshot_check CHECK (
      (reward_type = 'percentage_discount' AND discount_percent IS NOT NULL AND free_load_kg IS NULL)
      OR (reward_type = 'free_load' AND free_load_kg = 8 AND discount_percent IS NULL)
    )
  );
  INSERT INTO public.loyalty_rewards(reward_type, free_load_kg) VALUES ('free_load', 8);`

const insert = (db, type, percent, kg) =>
  db.query('INSERT INTO public.loyalty_rewards(reward_type, discount_percent, free_load_kg) VALUES ($1, $2, $3)', [type, percent, kg])

test('a free load records the first service\'s own load size, not only 8 kg', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(REWARDS_BEFORE)
  await assert.rejects(insert(db, 'free_load', null, 4), /loyalty_reward_snapshot_check/)

  await db.exec(await readFile(new URL('../supabase_migrations/20261114_free_load_any_service_size.sql', import.meta.url), 'utf8'))

  await insert(db, 'free_load', null, 4)
  await insert(db, 'free_load', null, 8)
  await insert(db, 'percentage_discount', 50, null)
  await assert.rejects(insert(db, 'free_load', null, 0), /loyalty_reward_snapshot_check/)
  await assert.rejects(insert(db, 'free_load', null, null), /loyalty_reward_snapshot_check/)
  await assert.rejects(insert(db, 'percentage_discount', 50, 8), /loyalty_reward_snapshot_check/)
  const { rows } = await db.query('SELECT count(*)::int AS n FROM public.loyalty_rewards')
  assert.equal(rows[0].n, 4, 'the existing 8 kg reward and the three new rewards are kept')
})
