import { database } from '../config/supabase.js'
import { assertEmail, assertPhilippineMobile, assertText } from '../utils/validation.js'

function requireBranch(identity) {
  if (!identity.staffId) throw Object.assign(new Error('Your account must have a staff profile before it can process operations.'), { status: 403 })
  if (identity.role !== 'admin' && (!identity.branchId || !identity.branch)) throw Object.assign(new Error('Your staff account must be assigned to a branch.'), { status: 403 })
}

async function resolveBranch(identity, requestedBranch) {
  requireBranch(identity)
  if (identity.role !== 'admin') return { id: identity.branchId, name: identity.branch }
  if (!requestedBranch) throw Object.assign(new Error('Administrators must select a branch.'), { status: 400 })
  const { data, error } = await database.from('branches').select('id, name').eq('name', requestedBranch).maybeSingle()
  if (error || !data) throw Object.assign(new Error('The selected branch does not exist.'), { status: 400 })
  return data
}

export async function createOrder(body, identity) {
  const { customer = {}, order = {}, addons = {}, branch, loyaltyRewardId = null } = body || {}
  const selectedBranch = await resolveBranch(identity, branch)
  const weight = Number(order.weight_kg)
  const total = Number(order.total_price)
  const amountPaid = Number(order.amount_paid || 0)
  if (!Number.isFinite(weight) || weight <= 0) throw Object.assign(new Error('A valid order weight is required.'), { status: 400 })
  if (!Number.isFinite(total) || total < 0) throw Object.assign(new Error('A valid order total is required.'), { status: 400 })
  if (!['number', 'string'].includes(typeof order.amount_paid) || !String(order.amount_paid).trim() || !Number.isFinite(amountPaid) || amountPaid < 0) {
    throw Object.assign(new Error('A valid non-negative payment amount is required.'), { status: 400 })
  }
  if (amountPaid < total * 0.5) throw Object.assign(new Error(`Minimum 50% payment required: ₱${(total * 0.5).toLocaleString()}`), { status: 400 })
  // The order screen always supplies customer details. Legacy callers are
  // preserved here; the database RPC still rejects incomplete customers.
  const validatedCustomer = { ...customer }
  if (Object.hasOwn(customer, 'name')) validatedCustomer.name = assertText(customer.name, { label: 'Customer name', min: 2, max: 120 })
  if (Object.hasOwn(customer, 'phone')) validatedCustomer.phone = assertPhilippineMobile(customer.phone)
  if (Object.hasOwn(customer, 'email')) validatedCustomer.email = assertEmail(customer.email, { label: 'Customer email' })
  if (Object.hasOwn(customer, 'notes')) validatedCustomer.notes = assertText(customer.notes, { label: 'Customer notes', max: 1_000, required: false })
  const loads = Math.max(1, Math.ceil(weight / Number(body.bundleKg || 8)))
  const payload = {
    service_type_id: order.service_type_id || null,
    weight_kg: weight,
    total_price: total,
    notes: order.notes || '',
    payment_method: order.payment_method || 'cash',
    payment_status: amountPaid >= total ? 'paid' : 'partial',
    amount_paid: amountPaid,
  }
  const { data, error } = await database.rpc('create_branch_order', {
    p_branch_id: selectedBranch.id,
    p_staff_id: identity.staffId,
    p_customer: validatedCustomer,
    p_order: payload,
    p_addons: addons,
    p_loads: loads,
    p_loyalty_reward_id: loyaltyRewardId || null,
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data }
}

export async function restockInventory(body, identity) {
  const { itemId, quantity, costTotal, supplier } = body || {}
  const added = Number(quantity)
  if (!itemId || !Number.isFinite(added) || added <= 0) throw Object.assign(new Error('A valid inventory item and restock quantity are required.'), { status: 400 })
  requireBranch(identity)
  const { data: item, error: itemError } = await database.from('inventory_items').select('id, name, current_stock, unit, branch, branch_id').eq('id', itemId).maybeSingle()
  if (itemError || !item) throw Object.assign(new Error('Inventory item not found.'), { status: 404 })
  if (identity.role !== 'admin' && item.branch_id !== identity.branchId) throw Object.assign(new Error('You can only restock inventory assigned to your branch.'), { status: 403 })
  const { data, error } = await database.rpc('restock_branch_inventory', {
    p_item_id: item.id,
    p_quantity: added,
    p_cost_total: Number(costTotal) || 0,
    p_supplier: supplier || '',
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data }
}

export async function cancelOrder(body, identity) {
  const orderId = body?.orderId
  const reason = String(body?.reason || '').trim()
  if (!orderId || !reason) throw Object.assign(new Error('A cancellation reason is required.'), { status: 400 })
  requireBranch(identity)
  const { data: order, error: orderError } = await database.from('orders').select('id, branch, branch_id, status').eq('id', orderId).maybeSingle()
  if (orderError || !order) throw Object.assign(new Error('Order not found.'), { status: 404 })
  if (identity.role !== 'admin' && order.branch_id !== identity.branchId) throw Object.assign(new Error('You can only cancel orders assigned to your branch.'), { status: 403 })
  const { data, error } = await database.rpc('cancel_branch_order', {
    p_order_id: order.id, p_staff_id: identity.staffId, p_reason: reason,
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data }
}

export async function transitionOrder(body, identity) {
  const orderId = body?.orderId
  const nextStatus = String(body?.status || '').trim()
  const correctionReason = String(body?.correctionReason || '').trim()
  if (!orderId || !['received', 'on_process', 'ready', 'released'].includes(nextStatus)) {
    throw Object.assign(new Error('A valid order stage is required.'), { status: 400 })
  }
  requireBranch(identity)
  const { data: order, error: orderError } = await database
    .from('orders')
    .select('id, branch_id, status')
    .eq('id', orderId)
    .maybeSingle()
  if (orderError || !order) throw Object.assign(new Error('Order not found.'), { status: 404 })
  if (identity.role !== 'admin' && order.branch_id !== identity.branchId) {
    throw Object.assign(new Error('You can only update orders assigned to your branch.'), { status: 403 })
  }
  const { data, error } = await database.rpc('transition_branch_order', {
    p_order_id: orderId,
    p_staff_id: identity.staffId,
    p_new_status: nextStatus,
    p_correction_reason: correctionReason || null,
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data }
}

export async function settleAndReleaseOrder(body, identity) {
  const orderId = String(body?.orderId || '').trim()
  if (!orderId) throw Object.assign(new Error('An order is required.'), { status: 400 })
  requireBranch(identity)
  const { data: order, error: orderError } = await database.from('orders')
    .select('id, branch_id, status, total_price, amount_paid, payment_status, payment_method')
    .eq('id', orderId).maybeSingle()
  if (orderError || !order) throw Object.assign(new Error('Order not found.'), { status: 404 })
  if (identity.role !== 'admin' && order.branch_id !== identity.branchId) {
    throw Object.assign(new Error('You can only collect payment for orders assigned to your branch.'), { status: 403 })
  }
  if (order.status !== 'ready') throw Object.assign(new Error('Only ready-for-pickup orders can be released.'), { status: 400 })
  const total = Number(order.total_price)
  const paid = Number(order.amount_paid || 0)
  if (!Number.isFinite(total) || total < 0 || !Number.isFinite(paid) || paid < 0) {
    throw Object.assign(new Error('This order has invalid payment data.'), { status: 400 })
  }
  const { data, error } = await database.rpc('settle_and_release_order', {
    p_order_id: order.id, p_staff_id: identity.staffId,
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data }
}
