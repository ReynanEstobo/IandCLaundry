// Fixes for the defects found in the 2026-11-15 system test.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { database } from '../backend/config/supabase.js'
import { execute } from '../backend/models/databaseModel.js'
import { resetStaffCredentials, updateProvisionedStaff } from '../backend/controllers/staffProvisionController.js'
import { createInventoryItem, restockInventory } from '../backend/controllers/operationController.js'
import { listEmailDeliveryAudit, retryEmailDelivery } from '../backend/controllers/notificationController.js'
import { describeAuditEvent, listAuditLog, restoreRecord } from '../backend/controllers/auditController.js'
import { COUNTABLE_UNITS as SERVER_COUNTABLE_UNITS } from '../backend/utils/recordRules.js'
import { formatPeso } from '../frontend/src/utils/money.js'
import { unitName } from '../frontend/src/utils/alertText.js'
import { chartGrouping } from '../frontend/src/utils/chartDates.js'
import { canStaffUndoStage, moveBackStatus, undoSecondsLeft, withUndoDeadline } from '../frontend/src/utils/orderStageRules.js'
import { orderTimingProblem } from '../frontend/src/utils/settingsRules.js'
import { COUNTABLE_UNITS, stockStep, wholeNumberProblem } from '../frontend/src/utils/inventoryUnits.js'
import { isHideableToast, readToastPreference, toastPreferenceKey } from '../frontend/src/hooks/useToastPreference.js'

const admin = { role: 'admin', staffId: 'admin-a', authUserId: 'auth-a' }
const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

// Answers each table from `tables` (a row list or a function of the recorded
// calls for that query) and records every call. The query is thenable at any
// point in the chain, like supabase-js.
function fakeDatabase(t, tables = {}) {
  const calls = []
  const originalFrom = database.from
  const originalRpc = database.rpc
  const originalAuth = Object.getOwnPropertyDescriptor(database, 'auth')
  t.after(() => { database.from = originalFrom; database.rpc = originalRpc; Object.defineProperty(database, 'auth', originalAuth) })
  database.from = table => {
    const own = []
    const answer = () => {
      const entry = tables[table]
      const rows = typeof entry === 'function' ? entry(own) : (entry ?? [])
      if (rows && !Array.isArray(rows) && (rows.error || Object.hasOwn(rows, 'data'))) return rows
      const single = own.some(call => ['single', 'maybeSingle'].includes(call.method))
      return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length }
    }
    const query = new Proxy({}, {
      get: (_target, method) => method === 'then'
        ? (resolve, reject) => Promise.resolve(answer()).then(resolve, reject)
        : (...args) => { const call = { table, method, args }; own.push(call); calls.push(call); return query },
    })
    return query
  }
  database.rpc = async (name, args) => { calls.push({ rpc: name, args }); return { data: { ok: true }, error: null } }
  Object.defineProperty(database, 'auth', { configurable: true, value: { admin: { updateUserById: async () => ({ error: null }) } } })
  return calls
}
const wrote = (calls, table, method) => calls.some(call => call.table === table && call.method === method)

// 1. Administrators cannot lock themselves (or the shop) out ------------------
test('an administrator cannot archive their own account', async t => {
  const calls = fakeDatabase(t, { staff: [{ id: 'admin-a', role: 'admin', full_name: 'Irene' }] })
  await assert.rejects(
    execute('staff', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: 'admin-a' }] }, admin),
    error => error.status === 403 && /cannot archive your own account/.test(error.message),
  )
  assert.equal(wrote(calls, 'staff', 'update'), false)
})

test('the last active administrator cannot be archived', async t => {
  const calls = fakeDatabase(t, { staff: [{ id: 'admin-b', role: 'admin', full_name: 'Carlos' }] })
  await assert.rejects(
    execute('staff', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: 'admin-b' }] }, admin),
    /At least one active administrator/,
  )
  assert.equal(wrote(calls, 'staff', 'update'), false)
})

test('another administrator can still be archived while one remains', async t => {
  const calls = fakeDatabase(t, {
    staff: own => own.some(call => call.method === 'ilike' && call.args[0] === 'role')
      ? [{ id: 'admin-a' }, { id: 'admin-b' }]
      : [{ id: 'admin-b', role: 'admin', full_name: 'Carlos' }],
  })
  await execute('staff', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: 'admin-b' }] }, admin)
  assert.equal(wrote(calls, 'staff', 'update'), true)
})

test('an administrator cannot change their own role or reset their own credentials', async t => {
  fakeDatabase(t, { staff: [{ id: 'admin-a', role: 'admin', full_name: 'Irene', contact_email: 'irene@example.com', auth_id: 'auth-a' }] })
  await assert.rejects(
    updateProvisionedStaff({ staffId: 'admin-a', full_name: 'Irene', role: 'staff', branch: 'Main', contact_email: 'irene@example.com' }, admin),
    error => error.status === 403 && /cannot change your own role/.test(error.message),
  )
  await assert.rejects(resetStaffCredentials({ staffId: 'admin-a' }, admin), /use Account Security/)
})

test('the last administrator cannot be demoted to staff', async t => {
  fakeDatabase(t, {
    staff: own => own.some(call => call.method === 'ilike' && call.args[0] === 'role')
      ? [{ id: 'admin-b' }]
      : [{ id: 'admin-b', role: 'admin', full_name: 'Carlos', contact_email: 'carlos@example.com' }],
    branches: [{ id: 'branch-a', name: 'Main' }],
  })
  await assert.rejects(
    updateProvisionedStaff({ staffId: 'admin-b', full_name: 'Carlos', role: 'staff', branch: 'Main', contact_email: 'carlos@example.com' }, admin),
    /At least one active administrator/,
  )
})

// 2. Toast preference is personal, and errors always show ---------------------
test('the toast preference is per account and never hides errors or warnings', async () => {
  const store = new Map()
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  assert.equal(readToastPreference('user-1', storage), true)
  store.set(toastPreferenceKey('user-1'), 'off')
  assert.equal(readToastPreference('user-1', storage), false)
  assert.equal(readToastPreference('user-2', storage), true, 'another account keeps its own preference')
  assert.equal(isHideableToast({ type: 'success' }), true)
  assert.equal(isHideableToast({ type: 'loading' }), true)
  assert.equal(isHideableToast({ type: 'error' }), false)
  assert.equal(isHideableToast({ type: 'blank' }), false, 'warnings such as a restore notice always show')

  const app = await source('frontend/src/App.jsx')
  assert.doesNotMatch(app, /if \(!notificationsEnabled\) return null/, 'the message area is never removed')
  assert.match(app, /isHideableToast\(toast\)/)
  const settings = await source('frontend/src/pages/Settings.jsx')
  assert.doesNotMatch(settings, /saveAppearancePreference|\.update\(\{ \[field\]/, 'the switch no longer writes the shared settings row')
})

// 3. Failed emails are reported to staff --------------------------------------
test('a failed order email is reported instead of silently ignored', async () => {
  const orders = await source('frontend/src/pages/Orders.jsx')
  assert.doesNotMatch(orders, /Silently fail/)
  assert.match(orders, /ready-for-pickup email to \$\{customerEmail\} could not be sent/)
  assert.match(orders, /confirmation email to \$\{customerEmail\} could not be sent/)
  assert.match(orders, /setManualPickupReminder\(\{ \.\.\.order, emailFailed: true \}\)/)
})

// 5. Order timing values are checked -------------------------------------------
test('order timing refuses blank, zero and negative values on the screen and the server', async t => {
  const valid = { defaultProcessingMinutes: '100', etaBufferMinutes: '0', etaMinCompletedOrders: '5', statusUndoSeconds: '60' }
  assert.equal(orderTimingProblem(valid), null)
  assert.match(orderTimingProblem({ ...valid, defaultProcessingMinutes: '' }), /Default processing time must be a whole number/)
  assert.match(orderTimingProblem({ ...valid, defaultProcessingMinutes: '0' }), /from 1/)
  assert.match(orderTimingProblem({ ...valid, etaBufferMinutes: '-5' }), /ETA safety buffer/)
  assert.match(orderTimingProblem({ ...valid, statusUndoSeconds: '1.5' }), /Staff undo window/)

  const calls = fakeDatabase(t, { settings: [{ id: 's1' }] })
  const update = payload => execute('settings', { operation: 'update', payload, filters: [{ type: 'eq', column: 'id', value: 's1' }] }, admin)
  for (const payload of [{ default_processing_minutes: 0 }, { default_processing_minutes: '' }, { eta_buffer_minutes: -1 }, { status_undo_seconds: 2.5 }]) {
    await assert.rejects(update(payload), error => error.status === 400 && /must be a whole number/.test(error.message))
  }
  await assert.rejects(update({ loyalty_discount_milestone: 5, loyalty_free_load_milestone: 5 }), /free load order must come after/)
  assert.equal(wrote(calls, 'settings', 'update'), false)
  await update({ default_processing_minutes: 120, eta_buffer_minutes: 0 })
  assert.equal(wrote(calls, 'settings', 'update'), true)
})

// 6 and 7. Duplicate names and phone numbers ------------------------------------
test('a second active service with the same name is refused', async t => {
  const calls = fakeDatabase(t, { service_types: [{ id: 'svc-1', name: 'Comforter' }] })
  await assert.rejects(
    execute('service_types', { operation: 'insert', payload: { name: ' comforter ' } }, admin),
    error => error.status === 409 && /A service named "Comforter" already exists/.test(error.message),
  )
  assert.equal(wrote(calls, 'service_types', 'insert'), false)
  // Saving the same service under its own name is fine.
  await execute('service_types', { operation: 'update', payload: { name: 'Comforter' }, filters: [{ type: 'eq', column: 'id', value: 'svc-1' }] }, admin)
  assert.equal(wrote(calls, 'service_types', 'update'), true)
})

test('a second active item with the same name at the same branch is refused', async t => {
  fakeDatabase(t, { branches: [{ id: 'branch-a', name: 'Calzada' }], inventory_items: [{ id: 'item-1', name: 'Hanger' }] })
  await assert.rejects(
    createInventoryItem({ name: 'hanger', unit: 'pcs', branch: 'Calzada', quantity: 20 }, admin),
    error => error.status === 409 && /Calzada already has an item named "Hanger"/.test(error.message),
  )
})

test('renaming an item to another item\'s name at its branch is refused', async t => {
  fakeDatabase(t, {
    inventory_items: own => own.some(call => call.method === 'ilike')
      ? [{ id: 'item-2', name: 'Hanger' }]
      : [{ id: 'item-1', name: 'Wire Hanger', unit: 'pcs', branch: 'Calzada', branch_id: 'branch-a' }],
  })
  await assert.rejects(
    execute('inventory_items', { operation: 'update', payload: { name: 'Hanger' }, filters: [{ type: 'eq', column: 'id', value: 'item-1' }] }, admin),
    /already has an item named "Hanger"/,
  )
})

test('changing a customer\'s phone to another customer\'s number names who has it', async t => {
  const calls = fakeDatabase(t, { customers: [{ id: 'customer-2', name: 'Juan Salazar' }] })
  await assert.rejects(
    execute('customers', { operation: 'update', payload: { phone: '09451151587' }, filters: [{ type: 'eq', column: 'id', value: 'customer-1' }] }, admin),
    error => error.status === 409 && error.message === 'This phone number is already used by Juan Salazar. Each customer needs their own number.',
  )
  assert.equal(wrote(calls, 'customers', 'update'), false)
})

test('restoring an item or service is refused when an active one has its name', async t => {
  fakeDatabase(t, {
    service_types: own => own.some(call => call.method === 'not')
      ? [{ id: 'svc-old', name: 'Comforter', deleted_at: '2026-11-01' }]
      : [{ id: 'svc-new', name: 'Comforter' }],
  })
  await assert.rejects(restoreRecord({ table: 'service_types', id: 'svc-old' }, admin), error => error.status === 409 && /an active service is already named "Comforter"/.test(error.message))
})

// 10. Counted items take whole numbers ------------------------------------------
test('pieces, packs, bottles and sachets take whole numbers; weights and volumes may not', async t => {
  assert.deepEqual([...SERVER_COUNTABLE_UNITS].sort(), [...COUNTABLE_UNITS].sort(), 'screen and server agree')
  assert.equal(stockStep('pcs'), '1')
  assert.equal(stockStep('kg'), '0.01')
  assert.match(wholeNumberProblem('pcs', '2.5', 'Quantity to add'), /whole number for items counted in pcs/)
  assert.equal(wholeNumberProblem('kg', '2.5', 'Quantity to add'), null)

  fakeDatabase(t, { inventory_items: [{ id: 'item-1', name: 'Hanger', unit: 'pcs', branch_id: 'branch-a', current_stock: 13 }] })
  await assert.rejects(restockInventory({ itemId: 'item-1', quantity: 2.5 }, admin), error => error.status === 400 && /whole number/.test(error.message))
  await restockInventory({ itemId: 'item-1', quantity: 3 }, admin)
  await assert.rejects(
    execute('inventory_items', { operation: 'update', payload: { current_stock: 15.5 }, filters: [{ type: 'eq', column: 'id', value: 'item-1' }] }, admin),
    /Current stock must be a whole number/,
  )
})

// 9. A failed email is not resent after it was already delivered -------------------
test('a failed email cannot be retried again once a later send succeeded', async t => {
  const failed = { id: 'd1', status: 'failed', notification_type: 'ready_for_pickup', recipient_email: 'nenita@example.com', order_id: 'o1', subject: 'Ready', attempted_at: '2026-11-15T07:21:52Z', branch_id: null }
  const resent = { id: 'd2', status: 'sent', notification_type: 'ready_for_pickup', recipient_email: 'nenita@example.com', order_id: 'o1', subject: 'Ready', attempted_at: '2026-11-15T07:22:34Z' }
  fakeDatabase(t, { email_delivery_audit: own => own.some(call => call.method === 'eq' && call.args[0] === 'status') ? [resent] : [failed] })
  await assert.rejects(retryEmailDelivery({ deliveryId: 'd1' }, admin), error => error.status === 409 && /already sent successfully/.test(error.message))
  const page = await listEmailDeliveryAudit(admin)
  assert.equal(page.items[0].resent_successfully, true)
})

// 13. Clearer Audit Log ----------------------------------------------------------
test('the Audit Log describes new orders, service lines and stock changes plainly', () => {
  assert.equal(describeAuditEvent({ action: 'insert', table_name: 'orders', after_data: { order_number: 'IC-1', status: 'received', branch: 'Main' } }),
    'Order IC-1 was created at Main.')
  assert.equal(describeAuditEvent({ action: 'insert', table_name: 'order_items', order_number: 'IC-1', after_data: { service_name_snapshot: 'Wash & Fold', weight_kg: 6 } }),
    'Wash & Fold (6 kg) was added to order IC-1.')
  assert.equal(describeAuditEvent({ action: 'update', table_name: 'order_items', order_number: 'IC-1', before_data: { service_name_snapshot: 'Wash & Fold', status: 'received' }, after_data: { service_name_snapshot: 'Wash & Fold', status: 'on_process' }, changed_fields: { status: true } }),
    'Wash & Fold on order IC-1 moved from Received to On Process.')
  assert.equal(describeAuditEvent({ action: 'update', table_name: 'inventory_items', before_data: { name: 'Plastic Laundry Bag', current_stock: 75, unit: 'pcs' }, after_data: { name: 'Plastic Laundry Bag', current_stock: 73, unit: 'pcs' }, changed_fields: { current_stock: true, updated_at: true } }),
    'Plastic Laundry Bag stock changed from 75 to 73 pcs.')
  assert.equal(describeAuditEvent({ action: 'update', table_name: 'staff', before_data: { full_name: 'Mylene Atienza' }, after_data: { full_name: 'Mylene Atienza' }, changed_fields: { contact_email: true } }),
    'Mylene Atienza was updated: Contact Email.')
})

test('the Audit Log hides unattributed duplicate staff entries and sorts by time on request', async t => {
  const calls = fakeDatabase(t, { audit_logs: [], customers: [], staff: [], inventory_items: [], inventory_categories: [], service_types: [], expenses: [] })
  await listAuditLog(admin, { page: 1, direction: 'asc' })
  const auditCalls = calls.filter(call => call.table === 'audit_logs')
  assert.ok(auditCalls.some(call => call.method === 'or' && call.args[0] === 'table_name.neq.staff,source.neq.database_trigger,actor_staff_id.not.is.null'))
  assert.ok(auditCalls.some(call => call.method === 'order' && call.args[0] === 'created_at' && call.args[1].ascending === true))
})

// 15. Money and unit wording ------------------------------------------------------
test('peso amounts show centavos with two digits and units read naturally', () => {
  assert.equal(formatPeso(70984.5), '₱70,984.50')
  assert.equal(formatPeso(55121), '₱55,121')
  assert.equal(formatPeso(-1250.5), '-₱1,250.50')
  assert.equal(formatPeso(null), '₱0')
  assert.equal(unitName('sachets'), 'sachet')
  assert.equal(unitName('pcs'), 'pc')
  assert.equal(unitName('kg'), 'kg')
})

// 14. Custom date ranges group by their own length -------------------------------
test('a custom date range chart is grouped by the range, not the period button', () => {
  assert.equal(chartGrouping('yearly', { start: '2026-11-01', end: '2026-11-07' }), 'weekly')
  assert.equal(chartGrouping('weekly', { start: '2026-01-01', end: '2026-11-07' }), 'monthly')
  assert.equal(chartGrouping('weekly', { start: '2022-01-01', end: '2026-11-07' }), 'yearly')
  assert.equal(chartGrouping('monthly', {}), 'monthly')
})

// 17. Staff see "Move back" only when they may use it -----------------------------
test('staff are offered Move back only while the database says they may undo', () => {
  const requestedAt = Date.parse('2026-11-15T07:30:00Z')
  const mine = withUndoDeadline({ stage_undo: { staff_id: 'staff-a', seconds_left: 40 } }, requestedAt)
  assert.equal(mine.undo_until, requestedAt + 40_000, 'counted from when the list was requested')
  assert.equal(canStaffUndoStage(mine, { staffId: 'staff-a', now: requestedAt + 39_000 }), true)
  assert.equal(canStaffUndoStage(mine, { staffId: 'staff-a', now: requestedAt + 40_000 }), false, 'gone when the window ends')
  assert.equal(canStaffUndoStage(mine, { staffId: 'staff-b', now: requestedAt }), false, "someone else's change")
  // The database sends null when the latest change cannot be undone by staff
  // (a payment after someone else's stage change, a correction, an expired window).
  assert.equal(canStaffUndoStage(withUndoDeadline({ stage_undo: null }, requestedAt), { staffId: 'staff-a', now: requestedAt }), false)
  assert.equal(canStaffUndoStage(withUndoDeadline({ stage_undo: { staff_id: 'staff-a', seconds_left: 0 } }, requestedAt), { staffId: 'staff-a', now: requestedAt }), false)
  assert.equal(canStaffUndoStage(withUndoDeadline({}, requestedAt), { staffId: null, now: requestedAt }), false)
})

test('staff are told why Move back is unavailable, and see the seconds left', () => {
  const requestedAt = Date.parse('2026-11-15T07:30:00Z')
  const mine = withUndoDeadline({ id: 'o1', stage_undo: { staff_id: 'staff-a', seconds_left: 42 } }, requestedAt)
  assert.equal(undoSecondsLeft(mine, requestedAt), 42)
  assert.equal(undoSecondsLeft(mine, requestedAt + 41_500), 1)
  assert.equal(undoSecondsLeft(mine, requestedAt + 43_000), 0)
  assert.deepEqual(moveBackStatus(mine, { staffId: 'staff-a', now: requestedAt + 2_000 }), { allowed: true, secondsLeft: 40 })

  const refreshed = withUndoDeadline({ id: 'o1', stage_undo: null }, requestedAt + 10_000)
  const deadline = requestedAt + 42_000
  const changed = moveBackStatus(refreshed, { staffId: 'staff-a', now: requestedAt + 10_000, rememberedDeadline: deadline })
  assert.equal(changed.reason, 'changed', 'gone before the time was up: someone else worked on the order')
  assert.match(changed.message, /Someone else has worked on this order since your step/)
  const expired = moveBackStatus(refreshed, { staffId: 'staff-a', now: deadline, rememberedDeadline: deadline, undoSeconds: 60 })
  assert.equal(expired.reason, 'expired')
  assert.match(expired.message, /Your 60-second undo time for this order has ended/)
  const neverMine = moveBackStatus(withUndoDeadline({ id: 'o2', stage_undo: { staff_id: 'staff-b', seconds_left: 30 } }, requestedAt), { staffId: 'staff-a', now: requestedAt, undoSeconds: 60 })
  assert.equal(neverMine.reason, 'not_yours')
  assert.match(neverMine.message, /only their own latest step on an order, within 60 seconds/)
  for (const status of [changed, expired, neverMine]) assert.match(status.hint, /ask an administrator/i)
})

test('the correction box checks the order first, counts down, and closes when the undo is refused', async () => {
  const orders = await source('frontend/src/pages/Orders.jsx')
  assert.match(orders, /async function latestOrder[\s\S]*getOrdersPage\(\{ page: 0, pageSize: 10, search: order\.order_number \}\)/, 'the latest state of one order is fetched')
  assert.match(orders, /async function openCorrection[\s\S]{0,200}correctionProblem\(current, order\.status\)/, 'checked before the box opens')
  assert.match(orders, /async function confirmCorrection[\s\S]{0,400}correctionProblem\(await latestOrder\(shown\), shown\.status\)/, 'and again before it is saved')
  assert.match(orders, /Someone changed it in the meantime, so nothing was changed/)
  assert.match(orders, /You can undo your step for <strong>\{correctionSecondsLeft\}<\/strong>/)
  assert.match(orders, /Your undo time ran out before the correction was confirmed/)
  assert.match(orders, /only an administrator can correct this order now\|one stage forward or one stage backward\/i\.test\(lastStageError\.current\)[\s\S]{0,200}closeCorrection\(\)/)
  assert.match(orders, /hint: moveBackInfo\(order\)\.hint, icon: RotateCcw, disabled: true/)
  const menu = await source('frontend/src/components/RowActionsMenu.jsx')
  assert.match(menu, /row-actions-menu-hint/)
})

// 8, 11, 12, 16. Screen fixes ----------------------------------------------------
test('screen fixes: full board, all-page sorting, archive wording and custom email labels', async () => {
  const orders = await source('frontend/src/pages/Orders.jsx')
  assert.match(orders, /boardColumns\[status\]\?\.orders/, 'the board loads each stage itself')
  assert.match(orders, /Use the table view to see the rest/)
  const customers = await source('frontend/src/pages/Customers.jsx')
  assert.match(customers, /getCustomersPage\(\{ page, pageSize: PAGE_SIZE, search: searchQuery, sort: sort\.key, direction: sort\.direction \}\)/)
  const inventory = await source('frontend/src/pages/Inventory.jsx')
  assert.match(inventory, /or new orders\.\{" "\}/)
  const notifications = await source('frontend/src/pages/SMS.jsx')
  assert.match(notifications, /delivery\.subject \|\| "Custom email"/)
  assert.match(notifications, /delivery\.resent_successfully/)
})
