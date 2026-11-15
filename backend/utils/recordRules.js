// Business rules shared by the save routes: whole numbers for countable
// stock, one active record per name, one active customer per phone, and at
// least one active administrator.

const refused = (message, status = 409) => Object.assign(new Error(message), { status })

// Pieces, packs, bottles and sachets are counted, so a delivery or stock
// count of 2.5 pcs is a typing mistake. Weights and volumes may have decimals.
export const COUNTABLE_UNITS = new Set(['pcs', 'packs', 'bottles', 'sachets'])

export function isCountableUnit(unit) {
  return COUNTABLE_UNITS.has(String(unit || '').trim().toLowerCase())
}

export function assertWholeForUnit(unit, value, label) {
  const amount = Number(value)
  if (isCountableUnit(unit) && Number.isFinite(amount) && !Number.isInteger(amount)) {
    throw refused(`${label} must be a whole number for items counted in ${String(unit).trim()}.`, 400)
  }
}

// An exact, case-insensitive match for ilike (its wildcards are escaped).
export function exactPattern(text) {
  return String(text || '').trim().replace(/[\\%_]/g, character => `\\${character}`)
}

async function firstOther(query, exceptId) {
  const { data, error } = await query.limit(5)
  if (error) throw Object.assign(new Error('Unable to check for an existing record with the same details.'), { status: 500, details: error })
  return (data || []).find(row => row.id !== exceptId) || null
}

export async function assertUniqueInventoryName(database, { name, branchId, branchName, exceptId = null }) {
  if (!String(name || '').trim() || !branchId) return
  const twin = await firstOther(database.from('inventory_items').select('id, name')
    .is('deleted_at', null).eq('branch_id', branchId).ilike('name', exactPattern(name)), exceptId)
  if (twin) throw refused(`${branchName || 'This branch'} already has an item named "${twin.name}". Restock or edit that item instead of adding another.`)
}

export async function assertUniqueServiceName(database, { name, exceptId = null }) {
  if (!String(name || '').trim()) return
  const twin = await firstOther(database.from('service_types').select('id, name')
    .is('deleted_at', null).ilike('name', exactPattern(name)), exceptId)
  if (twin) throw refused(`A service named "${twin.name}" already exists. Edit that service to change its price or details.`)
}

export async function assertCustomerPhoneAvailable(database, { phone, exceptId = null }) {
  if (!phone) return
  const holder = await firstOther(database.from('customers').select('id, name')
    .is('deleted_at', null).eq('phone', phone), exceptId)
  if (holder) throw refused(`This phone number is already used by ${holder.name}. Each customer needs their own number.`)
}

// The shop must always keep one active administrator, or nobody could manage
// accounts, settings or the Audit Log.
export async function assertAdministratorRemains(database, { leavingIds }) {
  const leaving = new Set(leavingIds.filter(Boolean))
  const { data, error } = await database.from('staff').select('id').ilike('role', 'admin').is('deleted_at', null)
  if (error) throw Object.assign(new Error('Unable to check the remaining administrator accounts.'), { status: 500, details: error })
  if (!(data || []).some(admin => !leaving.has(admin.id))) {
    throw refused('At least one active administrator account must remain. Add or promote another administrator first.')
  }
}
