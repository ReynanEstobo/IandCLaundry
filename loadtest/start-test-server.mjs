// Starts the normal backend (backend/server.js) against the TEST Supabase
// project only. Values from loadtest/.env.loadtest take precedence over the
// project's main .env, and every provider key there is blank, so this server
// cannot reach live data or send email/SMS.
//
// Usage: node loadtest/start-test-server.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import { ROOT, TEST_ENV_FILE, loadTestEnv } from './lib/config.mjs'

const env = loadTestEnv()
const port = env.PORT || '3101'
console.log(`Starting the test backend on http://127.0.0.1:${port} using ${new URL(env.SUPABASE_URL).host}`)
const child = spawn(process.execPath, [`--env-file=${TEST_ENV_FILE}`, path.join(ROOT, 'backend', 'server.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ...env },
})
child.on('exit', code => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
