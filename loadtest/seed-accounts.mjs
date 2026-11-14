// Creates the load-test sign-in accounts in the TEST Supabase project:
// one administrator plus STAFF_PER_BRANCH staff members for every branch.
// Passwords are generated here and saved only to loadtest/.accounts.json,
// which git ignores. Run after the setup SQL and before the seed scripts.
//
// Usage: node loadtest/seed-accounts.mjs [staffPerBranch]
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { ACCOUNTS_FILE, loadTestEnv } from './lib/config.mjs'

const env = loadTestEnv()
const staffPerBranch = Math.max(1, Math.min(10, Number(process.argv[2]) || 3))
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
const password = () => `Lt-${randomBytes(12).toString('base64url')}9a`
const existing = existsSync(ACCOUNTS_FILE) ? JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')) : []

async function createAccount({ role, fullName, username, staffCode, branch }) {
  const known = existing.find(account => account.username === username)
  if (known) return known
  const secret = password()
  const email = `${username}@loadtest.iclaundry.invalid`
  const { data: auth, error: authError } = await db.auth.admin.createUser({
    email, password: secret, email_confirm: true,
    user_metadata: { full_name: fullName, staff_code: staffCode, username, role },
  })
  if (authError) throw new Error(`Could not create ${username}: ${authError.message}`)
  const { error } = await db.from('staff').insert({
    auth_id: auth.user.id, full_name: fullName, email, username, staff_code: staffCode, role,
    contact_email: role === 'admin' ? email : null,
    branch: branch?.name || null, branch_id: branch?.id || null, must_change_password: false,
  })
  if (error) {
    await db.auth.admin.deleteUser(auth.user.id)
    throw new Error(`Could not create the staff profile for ${username}: ${error.message}`)
  }
  return { role, username, staffCode, password: secret, branch: branch?.name || null }
}

const { data: branches, error } = await db.from('branches').select('id, name').eq('is_active', true).order('name')
if (error) throw new Error(`Could not read branches: ${error.message}. Run the setup SQL first.`)
if (!branches?.length) throw new Error('No active branches found. Run the setup SQL first.')

const accounts = [await createAccount({ role: 'admin', fullName: 'Load Test Admin', username: 'loadtest.admin', staffCode: 'IC-ADMIN-LOADTEST' })]
for (const [b, branch] of branches.entries()) {
  for (let s = 1; s <= staffPerBranch; s += 1) {
    accounts.push(await createAccount({
      role: 'staff', fullName: `Load Test Staff ${b + 1}-${s}`, username: `loadtest.staff${b + 1}.${s}`,
      staffCode: `IC-STAFF-LT${b + 1}${String(s).padStart(2, '0')}`, branch,
    }))
  }
}
writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2))
console.log(`Saved ${accounts.length} test accounts (1 admin, ${accounts.length - 1} staff across ${branches.length} branches) to loadtest/.accounts.json`)
