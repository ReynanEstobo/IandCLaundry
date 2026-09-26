import { database } from '../config/supabase.js'
import { assertEmail, assertPhilippineMobile, assertText } from '../utils/validation.js'

async function attachIssuedRewards(customers) {
  const customerIds = customers.map(customer => customer?.id).filter(Boolean)
  if (!customerIds.length) return customers
  const { data: rewards, error } = await database
    .from('loyalty_rewards')
    .select('id, customer_id, reward_type, status, discount_percent, free_load_kg, earned_at, expires_at, redeemed_at, revoked_at, revoke_reason')
    .in('customer_id', customerIds)
    .order('earned_at', { ascending: false })
  // Keep the Client directory available when opening an environment that has
  // not yet run the loyalty migration.
  if (error?.code === '42P01') return customers.map(customer => ({ ...customer, loyaltyRewards: [] }))
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  const byCustomer = new Map()
  for (const reward of rewards || []) {
    const list = byCustomer.get(reward.customer_id) || []
    list.push(reward)
    byCustomer.set(reward.customer_id, list)
  }
  return customers.map(customer => ({ ...customer, loyaltyRewards: byCustomer.get(customer.id) || [] }))
}

async function resolveBranch(identity, requestedBranch) {
  if (!identity.staffId) throw Object.assign(new Error('Your account must have a staff profile before managing clients.'), { status: 403 })
  if (identity.role === 'staff') {
    if (!identity.branchId) throw Object.assign(new Error('Your staff account must be assigned to a branch.'), { status: 403 })
    return { id: identity.branchId, name: identity.branch }
  }
  if (identity.role !== 'admin' || !requestedBranch) throw Object.assign(new Error('Administrators must select a branch.'), { status: 400 })
  const { data, error } = await database.from('branches').select('id, name').eq('name', requestedBranch).maybeSingle()
  if (error || !data) throw Object.assign(new Error('The selected branch does not exist.'), { status: 400 })
  return data
}

export async function listVisibleCustomers(identity) {
  if (identity.role === 'admin') {
    const { data, error } = await database.from('customers').select('*').is('deleted_at', null).order('created_at', { ascending: false })
    if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
    return { data: await attachIssuedRewards(data || []) }
  }
  if (identity.role !== 'staff' || !identity.branchId) {
    throw Object.assign(new Error('Your staff account must be assigned to a branch before viewing clients.'), { status: 403 })
  }
  const { data, error } = await database
    .from('customer_branches')
    .select('customers!inner(*)')
    .is('customers.deleted_at', null)
    .eq('branch_id', identity.branchId)
    .order('last_served_at', { ascending: false })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  const customers = (data || []).map(row => row.customers).filter(customer => customer && !customer.deleted_at)
  return { data: await attachIssuedRewards(customers) }
}

export async function lookupCustomer(phone, identity) {
  const validPhone = assertPhilippineMobile(phone)
  const { data, error } = await database.rpc('find_customer_by_phone', { p_phone: validPhone })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  const customer = data?.[0]
  if (!customer) return { exists: false, visible: false, customer: null, loyalty: { nextReward: null } }
  // Loyalty progression is global to the central customer identity, while the
  // directory itself remains branch-scoped. The server calculates the next
  // qualifying reward; staff cannot select, create, or override one.
  await database.rpc('expire_customer_loyalty_rewards', { p_customer_id: customer.id })
  const { data: loyaltySettings, error: settingsError } = await database.from('settings')
    .select('loyalty_enabled, loyalty_discount_milestone, loyalty_free_load_milestone, loyalty_discount_percent, loyalty_program_started_at').maybeSingle()
  if (settingsError) throw Object.assign(new Error(settingsError.message), { status: 400, details: settingsError })
  let nextReward = null
  if (loyaltySettings?.loyalty_enabled) {
    const { data: completed, error: completedError } = await database.from('orders').select('id')
      .eq('customer_id', customer.id).eq('status', 'released').eq('payment_status', 'paid')
      .gte('picked_up_at', loyaltySettings.loyalty_program_started_at)
    if (completedError) throw Object.assign(new Error(completedError.message), { status: 400, details: completedError })
    const position = ((completed?.length || 0) % loyaltySettings.loyalty_free_load_milestone) + 1
    if (position === loyaltySettings.loyalty_discount_milestone) {
      nextReward = { reward_type: 'percentage_discount', discount_percent: loyaltySettings.loyalty_discount_percent }
    } else if (position === loyaltySettings.loyalty_free_load_milestone) {
      nextReward = { reward_type: 'free_load', free_load_kg: 8 }
    }
  }
  const loyalty = { nextReward }
  if (identity.role === 'admin') return { exists: true, visible: true, customer, loyalty }
  const { data: association } = await database.from('customer_branches').select('customer_id').eq('customer_id', customer.id).eq('branch_id', identity.branchId).maybeSingle()
  // The client directory remains branch-scoped, but an exact phone match in
  // the order form may safely hydrate the name/email to prevent duplicates.
  return { exists: true, visible: Boolean(association), customer, loyalty }
}

export async function registerCustomer(body, identity) {
  const branch = await resolveBranch(identity, body?.branch)
  const name = assertText(body?.name, { label: 'Customer name', min: 2, max: 120 })
  const phone = assertPhilippineMobile(body?.phone)
  const email = assertEmail(body?.email, { label: 'Customer email', required: true })
  const notes = assertText(body?.notes, { label: 'Notes', max: 1_000, required: false })
  const { data, error } = await database.rpc('register_branch_customer', {
    p_branch_id: branch.id,
    p_staff_id: identity.staffId,
    p_name: name,
    p_phone: phone,
    p_email: email,
    p_notes: notes,
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data }
}
