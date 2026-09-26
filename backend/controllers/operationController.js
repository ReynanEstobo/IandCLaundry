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
  const serviceItems = Array.isArray(order.items) ? order.items : (Array.isArray(body?.items) ? body.items : [])
  const weight = Number(order.weight_kg)
  const previewTotal = Number(order.total_price)
  const amountPaid = Number(order.amount_paid || 0)
  if (!serviceItems.length && (!Number.isFinite(weight) || weight <= 0)) {
    throw Object.assign(new Error('Add at least one service item or a valid order weight.'), { status: 400 })
  }
  for (const item of serviceItems) {
    if (!item?.service_type_id) throw Object.assign(new Error('Choose a service for every service item.'), { status: 400 })
    if (item.weight_kg !== undefined && item.weight_kg !== '' && (!Number.isFinite(Number(item.weight_kg)) || Number(item.weight_kg) <= 0)) {
      throw Object.assign(new Error('Service weights must be greater than zero.'), { status: 400 })
    }
    if (item.quantity !== undefined && item.quantity !== '' && (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0)) {
      throw Object.assign(new Error('Service quantities must be greater than zero.'), { status: 400 })
    }
  }
  if (!['number', 'string'].includes(typeof order.amount_paid) || !String(order.amount_paid).trim() || !Number.isFinite(amountPaid) || amountPaid < 0) {
    throw Object.assign(new Error('A valid non-negative payment amount is required.'), { status: 400 })
  }
  // Fast feedback for legacy/browser callers; the SQL RPC independently
  // recalculates the real total and repeats this rule transactionally.
  if (Number.isFinite(previewTotal) && previewTotal > 0 && amountPaid < previewTotal * 0.5) {
    throw Object.assign(new Error(`Minimum 50% payment required: ₱${(previewTotal * 0.5).toLocaleString()}`), { status: 400 })
  }
  // The order screen always supplies customer details. Legacy callers are
  // preserved here; the database RPC still rejects incomplete customers.
  const validatedCustomer = { ...customer }
  if (Object.hasOwn(customer, 'name')) validatedCustomer.name = assertText(customer.name, { label: 'Customer name', min: 2, max: 120 })
  if (Object.hasOwn(customer, 'phone')) validatedCustomer.phone = assertPhilippineMobile(customer.phone)
  if (Object.hasOwn(customer, 'email')) validatedCustomer.email = assertEmail(customer.email, { label: 'Customer email' })
  if (Object.hasOwn(customer, 'notes')) validatedCustomer.notes = assertText(customer.notes, { label: 'Customer notes', max: 1_000, required: false })
  const payload = {
    // The database resolves price snapshots. Client totals are previews only.
    items: serviceItems,
    service_type_id: order.service_type_id || serviceItems[0]?.service_type_id || null,
    weight_kg: Number.isFinite(weight) ? weight : null,
    notes: order.notes || '',
    payment_method: order.payment_method || 'cash',
    payment_status: Number.isFinite(previewTotal) && amountPaid >= previewTotal ? 'paid' : 'partial',
    amount_paid: amountPaid,
  }
  const { data, error } = await database.rpc('create_branch_order', {
    p_branch_id: selectedBranch.id,
    p_staff_id: identity.staffId,
    p_customer: validatedCustomer,
    p_order: payload,
    p_addons: addons,
    // Retained for legacy RPC callers; multi-service SQL no longer relies on
    // this aggregate to deduct stock.
    p_loads: Number.isFinite(weight) && weight > 0 ? Math.max(1, Math.ceil(weight / Number(body.bundleKg || 8))) : 0,
    p_loyalty_reward_id: loyaltyRewardId || null,
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data }
}

async function assertOrderAccess(orderId, identity) {
  requireBranch(identity)
  const { data: order, error } = await database.from('orders').select('id, branch_id, status').eq('id', orderId).maybeSingle()
  if (error || !order) throw Object.assign(new Error('Order not found.'), { status: 404 })
  if (identity.role !== 'admin' && order.branch_id !== identity.branchId) {
    throw Object.assign(new Error('You can only update orders assigned to your branch.'), { status: 403 })
  }
  return order
}

export async function transitionOrderItem(body, identity) {
  const itemId = String(body?.orderItemId || '').trim()
  const status = String(body?.status || '').trim()
  if (!itemId || !['on_process', 'completed'].includes(status)) {
    throw Object.assign(new Error('A service item and a valid next stage are required.'), { status: 400 })
  }
  requireBranch(identity)
  const { data, error } = await database.rpc('transition_order_item', {
    p_order_item_id: itemId, p_staff_id: identity.staffId, p_new_status: status,
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data }
}

// Keeps the existing order-board controls useful: start begins all received
// items and ready completes all in-process items, transactionally.
export async function transitionAllOrderItems(body, identity) {
  const orderId = String(body?.orderId || '').trim()
  const requestedStatus = String(body?.status || '').trim()
  const itemStatus = requestedStatus === 'on_process' ? 'on_process' : requestedStatus === 'ready' ? 'completed' : null
  if (!orderId || !itemStatus) throw Object.assign(new Error('A valid order stage is required.'), { status: 400 })
  await assertOrderAccess(orderId, identity)
  const { data, error } = await database.rpc('transition_all_order_items', {
    p_order_id: orderId, p_staff_id: identity.staffId, p_new_status: itemStatus,
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
  if (nextStatus === 'on_process' || nextStatus === 'ready') {
    const { data, error } = await database.rpc('transition_all_order_items', {
      p_order_id: orderId, p_staff_id: identity.staffId,
      p_new_status: nextStatus === 'ready' ? 'completed' : 'on_process',
    })
    if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
    return { data }
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

export async function collectOrderPayment(body, identity) {
  const orderId = String(body?.orderId || '').trim()
  const amount = Number(body?.amount)
  const paymentMethod = String(body?.paymentMethod || 'cash').trim().toLowerCase()
  if (!orderId) throw Object.assign(new Error('An order is required.'), { status: 400 })
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Enter a payment amount greater than zero.'), { status: 400 })
  }
  if (!['cash', 'gcash', 'bank_transfer', 'card', 'other'].includes(paymentMethod)) {
    throw Object.assign(new Error('Select a valid payment method.'), { status: 400 })
  }
  requireBranch(identity)

  const { data: order, error: orderError } = await database.from('orders')
    .select('id, branch_id, status, total_price, amount_paid')
    .eq('id', orderId).maybeSingle()
  if (orderError || !order) throw Object.assign(new Error('Order not found.'), { status: 404 })
  if (identity.role !== 'admin' && order.branch_id !== identity.branchId) {
    throw Object.assign(new Error('You can only collect payment for orders assigned to your branch.'), { status: 403 })
  }
  if (['released', 'cancelled'].includes(order.status)) {
    throw Object.assign(new Error('Payments cannot be added to released or cancelled orders.'), { status: 400 })
  }
  const remaining = Math.max(0, Number(order.total_price || 0) - Number(order.amount_paid || 0))
  if (amount > remaining + 0.005) {
    throw Object.assign(new Error(`Payment exceeds the remaining balance of ₱${remaining.toLocaleString()}.`), { status: 400 })
  }

  const { data, error } = await database.rpc('collect_order_payment', {
    p_order_id: order.id,
    p_staff_id: identity.staffId,
    p_amount: amount,
    p_payment_method: paymentMethod,
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data }
}
