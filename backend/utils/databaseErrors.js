// Turns a database refusal into a message someone can act on, instead of a
// bare "Internal server error". Unknown database errors still get a generic
// message (no table or column details), and the real cause is logged.
const CONSTRAINT_MESSAGES = {
  staff_phone_format_check: 'The phone number saved on this account is not valid. It must start with 09 and have 11 digits. An administrator can correct it on the Staff page.',
  staff_contact_email_format_check: 'The recovery email saved on this account is not valid. An administrator can correct it on the Staff page.',
}

export function databaseProblem(error, fallback) {
  const constraint = /constraint "([^"]+)"/.exec(String(error?.message || ''))?.[1]
  if (constraint && CONSTRAINT_MESSAGES[constraint]) {
    return Object.assign(new Error(CONSTRAINT_MESSAGES[constraint]), { status: 409, code: 'SAVED_DETAILS_INVALID' })
  }
  if (String(error?.code || '') === '23505') {
    return Object.assign(new Error('This value is already used by another record.'), { status: 409 })
  }
  console.error(`${fallback} (${error?.code || 'no code'}): ${error?.message || error}`)
  return Object.assign(new Error(fallback), { status: 400 })
}
