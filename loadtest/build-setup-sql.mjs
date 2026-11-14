// Builds the SQL that recreates the I&C Laundry database in a NEW, EMPTY test
// Supabase project: supabase_schema.sql, the tables the live database had
// before the repository's migrations, then every migration in a working order.
//
// Usage:
//   node loadtest/build-setup-sql.mjs            writes loadtest/out/setup-1.sql, setup-2.sql, ...
//   node loadtest/build-setup-sql.mjs --verify   also applies them to an in-memory database
//
// Paste each part into the test project's SQL Editor and run them in order.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { OUT_DIR, ROOT } from './lib/config.mjs'

// Tables the live database already had before the repository's migrations,
// as those migrations describe them ("Existing database uses branch_name/status").
const LEGACY_BASELINE = `-- Pre-migration tables of the original database.
CREATE TABLE IF NOT EXISTS public.branches (branch_name text NOT NULL, status text DEFAULT 'active',
  address text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS public.payments (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), order_id uuid,
  amount numeric(10,2) NOT NULL DEFAULT 0, payment_method text, payment_status text,
  payment_date timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS public.ai_forecasts (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), forecast_type text,
  payload jsonb, generated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
`

// Marks the new database as a TEST copy. The demo-data scripts in scripts/
// refuse to run wherever this marker is missing, so they cannot run on live.
// It stops if the database already has I&C Laundry tables but no marker,
// which means this setup was pasted into the live project by mistake.
const TEST_PROJECT_MARKER = `-- Test-copy marker.
DO $$
BEGIN
  IF to_regclass('public.orders') IS NOT NULL AND to_regnamespace('ic_laundry_test_only') IS NULL THEN
    RAISE EXCEPTION 'Setup stopped: this database already has I&C Laundry data. Run this setup only in a new, empty test project.';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS ic_laundry_test_only;
`

// Every later part checks for the marker first, so no part runs on live.
const REQUIRE_TEST_PROJECT_MARKER = `
DO $$
BEGIN
  IF to_regnamespace('ic_laundry_test_only') IS NULL THEN
    RAISE EXCEPTION 'Setup stopped: run setup-1.sql first, and only in a new, empty test project.';
  END IF;
END $$;
`

// Same-date migrations that must run before the others of their date,
// because they create what the others use. Everything else runs by name.
const FIRST_OF_THEIR_DATE = [
  '20260906_multi_branch_reporting.sql',
  '20260906_customer_branch_isolation.sql',
  '20260906_fix_staff_order_isolation.sql',
  '20260907_audit_log_and_recycle_bin.sql',
  '20260908_three_stage_order_eta.sql',
]
const MAX_PART_BYTES = 150_000

async function setupSqlFiles() {
  const migrations = (await readdir(path.join(ROOT, 'supabase_migrations'))).filter(file => file.endsWith('.sql'))
  const rank = file => (FIRST_OF_THEIR_DATE.includes(file) ? String(FIRST_OF_THEIR_DATE.indexOf(file)).padStart(2, '0') : '99')
  migrations.sort((a, b) => a.slice(0, 8).localeCompare(b.slice(0, 8)) || rank(a).localeCompare(rank(b)) || a.localeCompare(b))
  return [
    { name: 'test project marker', sql: TEST_PROJECT_MARKER },
    { name: 'supabase_schema.sql', sql: await readFile(path.join(ROOT, 'supabase_schema.sql'), 'utf8') },
    { name: 'legacy baseline', sql: LEGACY_BASELINE },
    ...await Promise.all(migrations.map(async file => ({ name: file, sql: await readFile(path.join(ROOT, 'supabase_migrations', file), 'utf8') }))),
  ]
}

async function main() {
  const files = await setupSqlFiles()
  const parts = [[]]
  let size = 0
  for (const file of files) {
    const block = `\n-- ==================== ${file.name} ====================\n${file.sql}\n`
    if (size + block.length > MAX_PART_BYTES && parts.at(-1).length) { parts.push([]); size = 0 }
    parts.at(-1).push({ ...file, block })
    size += block.length
  }
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })
  for (const [index, part] of parts.entries()) {
    const header = `-- I&C Laundry LOAD-TEST database setup, part ${index + 1} of ${parts.length}.\n` +
      '-- Run ONLY in a new, empty TEST Supabase project, in order, one part at a time.\n' +
      `-- Contains: ${part.map(file => file.name).join(', ')}\n`
    const guard = index === 0 ? '' : REQUIRE_TEST_PROJECT_MARKER
    await writeFile(path.join(OUT_DIR, `setup-${index + 1}.sql`), header + guard + part.map(file => file.block).join(''))
  }
  console.log(`Wrote ${parts.length} part(s) to loadtest/out/ covering ${files.length} files.`)

  if (process.argv.includes('--verify')) {
    const { verifySetupSql } = await import('./lib/verify.mjs')
    const results = await verifySetupSql(parts.map((_, index) => path.join(OUT_DIR, `setup-${index + 1}.sql`)))
    for (const result of results) console.log(`${result.ok ? 'OK  ' : 'FAIL'} ${path.basename(result.file)}${result.error ? ` — ${result.error}` : ''}`)
    if (results.some(result => !result.ok)) process.exit(1)
  }
}

main().catch(error => { console.error(error.message); process.exit(1) })
