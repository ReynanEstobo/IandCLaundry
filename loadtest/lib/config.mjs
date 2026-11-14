// Shared settings and the production guard for every load-test script.
// Nothing here may ever point at the live I&C Laundry database or website.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LOADTEST_DIR = path.join(ROOT, 'loadtest')
export const OUT_DIR = path.join(LOADTEST_DIR, 'out')
export const TEST_ENV_FILE = path.join(LOADTEST_DIR, '.env.loadtest')
export const ACCOUNTS_FILE = path.join(LOADTEST_DIR, '.accounts.json')

// Stop with the plain message instead of a stack trace when a check fails.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, error => {
    console.error(`\nStopped: ${error?.message || error}`)
    process.exit(1)
  })
}

// The live website. Requests to it are always refused.
const PRODUCTION_HOSTS = ['ic-laundry.23-14327.workers.dev']

export function parseEnvFile(file) {
  if (!existsSync(file)) return {}
  const values = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return values
}

const hostOf = value => { try { return new URL(value).host.toLowerCase() } catch { return '' } }

// Stops the script unless the test settings clearly point away from production.
export function assertSafeTarget({ supabaseUrl, target } = {}) {
  const production = parseEnvFile(path.join(ROOT, '.env'))
  const productionDb = hostOf(production.SUPABASE_URL)
  if (supabaseUrl !== undefined) {
    if (!hostOf(supabaseUrl)) throw new Error('SUPABASE_URL in loadtest/.env.loadtest is missing or invalid.')
    if (productionDb && hostOf(supabaseUrl) === productionDb) {
      throw new Error('Refusing to run: loadtest/.env.loadtest points at the LIVE Supabase project. Use a separate test project.')
    }
  }
  if (target !== undefined) {
    const host = hostOf(target)
    if (!host) throw new Error(`Invalid target URL: ${target}`)
    if (PRODUCTION_HOSTS.includes(host) || host.startsWith('ic-laundry.')) {
      throw new Error(`Refusing to run: ${host} is the live website. Load-test the local test server instead.`)
    }
  }
}

export function loadTestEnv() {
  if (!existsSync(TEST_ENV_FILE)) {
    throw new Error('loadtest/.env.loadtest not found. Copy loadtest/env.loadtest.example to loadtest/.env.loadtest and fill in the TEST project values.')
  }
  const env = parseEnvFile(TEST_ENV_FILE)
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!env[key]) throw new Error(`${key} is empty in loadtest/.env.loadtest.`)
  }
  assertSafeTarget({ supabaseUrl: env.SUPABASE_URL })
  return env
}
