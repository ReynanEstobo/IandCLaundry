// Turns a database refusal into a message someone can act on, instead of a
// bare "Internal server error". Unknown database errors still get a generic
// message (no table or column details), and the real cause is logged.
const CONSTRAINT_MESSAGES = {
  staff_phone_format_check: 'The phone number saved on this account is not valid. It must start with 09 and have 11 digits. An administrator can correct it on the Staff page.',
  staff_contact_email_format_check: 'The recovery email saved on this account is not valid. An administrator can correct it on the Staff page.',
  customers_active_phone_unique: 'This phone number is already used by another customer. Each customer needs their own number.',
  customers_normalized_phone_unique: 'This phone number is already used by another customer. Each customer needs their own number.',
}

// Database refusals that someone can act on (a duplicate value or a known
// rule), turned into plain messages; null for anything else.
export function knownDatabaseProblem(error) {
  const constraint = /constraint "([^"]+)"/.exec(String(error?.message || ''))?.[1]
  if (constraint && CONSTRAINT_MESSAGES[constraint]) {
    return Object.assign(new Error(CONSTRAINT_MESSAGES[constraint]), { status: 409, code: 'SAVED_DETAILS_INVALID' })
  }
  if (String(error?.code || '') === '23505') {
    return Object.assign(new Error('This value is already used by another record.'), { status: 409 })
  }
  return null
}

export function databaseProblem(error, fallback) {
  const known = knownDatabaseProblem(error)
  if (known) return known
  console.error(`${fallback} (${error?.code || 'no code'}): ${error?.message || error}`)
  return Object.assign(new Error(fallback), { status: 400 })
}
