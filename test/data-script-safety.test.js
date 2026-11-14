import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const script = name => readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8')

test('data scripts are saved with an empty confirmation, so a pasted script never runs by itself', async () => {
  const reset = await script('reset-and-seed-test-data.sql')
  const startClean = await script('start-clean-live-data.sql')
  assert.match(reset, /v_confirmation TEXT := '';/)
  assert.doesNotMatch(reset, /v_confirmation TEXT := 'RESET_TEST_DATA_ONLY'/)
  assert.match(startClean, /v_confirmation TEXT := '';/)
  assert.doesNotMatch(startClean, /v_confirmation TEXT := 'START_CLEAN'/)
  // The reset's checks run inside its transaction, before anything is deleted.
  assert.ok(reset.indexOf('BEGIN;') < reset.indexOf("to_regnamespace('ic_laundry_test_only')"))
  assert.ok(reset.indexOf("to_regnamespace('ic_laundry_test_only')") < reset.indexOf('TRUNCATE TABLE'))
})

test('the reset-with-history script waits for its confirmation and creates nothing that looks like demo data', async t => {
  const history = await script('reset-with-sample-history.sql')
  assert.match(history, /v_confirmation TEXT := '';/)
  assert.ok(history.indexOf("v_confirmation <> 'RESET_WITH_SAMPLE_HISTORY'") < history.indexOf('TRUNCATE TABLE'), 'checked before anything is deleted')
  // Every name, description and reason it writes (its string literals), apart from the confirmation word.
  const body = history.split('\n').map(line => line.replace(/--.*$/, '')).join('\n')
  const literals = [...body.matchAll(/'((?:[^']|'')*)'/g)].map(match => match[1]).filter(text => !text.includes('RESET_WITH_SAMPLE_HISTORY'))
  const flagged = literals.filter(text => /demo|test|sample|seed|example|fake|dummy|forecast/i.test(text))
  assert.deepEqual(flagged, [])
  // Customers get no email address, so the system never emails them.
  assert.match(history, /'email', ''/)

  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE TABLE public.orders (id int); INSERT INTO public.orders VALUES (1);')
  await assert.rejects(db.exec(history), /replace the empty confirmation text with RESET_WITH_SAMPLE_HISTORY/)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.orders')).rows[0].n, 1)
})

test('the demo-data scripts stop on any database not marked as a test copy, even when confirmed', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE TABLE public.service_types (id uuid); CREATE TABLE public.orders (id uuid);')
  const confirmedReset = (await script('reset-and-seed-test-data.sql'))
    .replace("v_confirmation TEXT := '';", "v_confirmation TEXT := 'RESET_TEST_DATA_ONLY';")

  await assert.rejects(db.exec(confirmedReset), /not marked as a test copy/)
  await db.exec('ROLLBACK')
  await assert.rejects(db.exec(await script('seed-forecast-history.sql')), /not marked as a test copy/)
  await db.exec('ROLLBACK')

  // In a marked test copy the reset still waits for its confirmation.
  await db.exec('CREATE SCHEMA ic_laundry_test_only')
  await assert.rejects(db.exec(await script('reset-and-seed-test-data.sql')), /replace the confirmation text/)
  await db.exec('ROLLBACK')
})

test('the live start-clean script changes nothing until its confirmation is filled in', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE TABLE public.orders (id int); INSERT INTO public.orders VALUES (1);')
  await assert.rejects(db.exec(await script('start-clean-live-data.sql')), /replace the empty confirmation text with START_CLEAN/)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.orders')).rows[0].n, 1)
})
