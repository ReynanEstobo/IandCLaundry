// Dry run, entirely in memory: builds the database from loadtest/out/setup-*.sql,
// adds test accounts like seed-accounts.mjs does, then runs the project's
// reset and history seed scripts, and reports what the test project will hold.
// Nothing connects to Supabase.
//
// Usage: node loadtest/build-setup-sql.mjs && node loadtest/dry-run-seed.mjs
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { OUT_DIR, ROOT } from './lib/config.mjs'
import { stubbedDatabase, verifySetupSql } from './lib/verify.mjs'

const db = await stubbedDatabase()
const parts = (await readdir(OUT_DIR)).filter(file => /^setup-\d+\.sql$/.test(file)).sort((a, b) => parseInt(a.slice(6)) - parseInt(b.slice(6)))
const setup = await verifySetupSql(parts.map(file => path.join(OUT_DIR, file)), db)
if (setup.some(result => !result.ok)) { console.error(setup); process.exit(1) }

const branches = (await db.query(`SELECT id, name FROM public.branches WHERE is_active ORDER BY name`)).rows
await db.query(`INSERT INTO public.staff(full_name, role, email, username, staff_code) VALUES ('Load Test Admin', 'admin', 'admin@loadtest.invalid', 'loadtest.admin', 'IC-ADMIN-LOADTEST')`)
for (const [index, branch] of branches.entries()) {
  await db.query(`INSERT INTO public.staff(full_name, role, branch_id, email, username, staff_code) VALUES ($1, 'staff', $2, $3, $4, $5)`,
    [`Load Test Staff ${index + 1}`, branch.id, `staff${index + 1}@loadtest.invalid`, `loadtest.staff${index + 1}`, `IC-STAFF-LOADT00${index + 1}`])
}
for (const script of ['reset-and-seed-test-data.sql', 'seed-forecast-history.sql']) {
  // Fill in the reset's confirmation here, as you would in the test project's SQL Editor.
  const sql = (await readFile(path.join(ROOT, 'scripts', script), 'utf8'))
    .replace("v_confirmation TEXT := '';", "v_confirmation TEXT := 'RESET_TEST_DATA_ONLY';")
  try { await db.exec(sql); console.log(`OK   scripts/${script}`) }
  catch (error) { console.log(`FAIL scripts/${script} — ${error.message.split('\n')[0]}`); process.exit(1) }
}
const count = async table => (await db.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n
for (const table of ['branches', 'staff', 'service_types', 'inventory_items', 'customers', 'orders', 'payments', 'order_items']) {
  console.log(`${table.padEnd(16)} ${await count(table)}`)
}
await db.close()
