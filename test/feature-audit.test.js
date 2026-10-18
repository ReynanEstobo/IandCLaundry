import assert from 'node:assert/strict'
import test from 'node:test'
import { database } from '../backend/config/supabase.js'
import { execute } from '../backend/models/databaseModel.js'
import { getPublicServices, trackOrder } from '../backend/controllers/publicController.js'
import { listVisibleCustomers } from '../backend/controllers/customerController.js'
import { listOrdersPage } from '../backend/controllers/orderListController.js'
import { listCustomersPage, listInventoryPage } from '../backend/controllers/operationalListController.js'
import { cancelOrder, createInventoryItem, createOrder, restockInventory } from '../backend/controllers/operationController.js'
import { describeAuditEvent, listRecycleBin, restoreRecord } from '../backend/controllers/auditController.js'

const staff = {role:'staff', staffId:'staff-a', branchId:'branch-a', branch:'Main'}
const admin = {role:'admin', staffId:'admin-a'}

test('cancelled orders are described with their reason in the Audit Log', () => {
  const description = describeAuditEvent({
    action: 'cancel', table_name: 'orders',
    after_data: { order_number: 'ORD-1001', branch: 'Main', cancellation_reason: 'Customer request' },
  })
  assert.equal(description, 'order ORD-1001 was cancelled: Customer request at Main.')
})

test('paginated order listing keeps staff branch-scoped and bounds client paging', async t => {
  const calls = mockDatabase(t)
  database.rpc = async (name, args) => {
    calls.push({ rpc: name, args })
    return { data: { data: [{ id: 'order-1' }], count: 71 }, error: null }
  }

  const staffResult = await listOrdersPage(
    { page: '2', pageSize: '500', status: 'received', search: ' customer ' },
    staff,
  )
  assert.deepEqual(staffResult, { data: [{ id: 'order-1' }], count: 71 })
  assert.deepEqual(calls.at(-1), {
    rpc: 'list_orders_page',
    args: { p_branch_id: 'branch-a', p_status: 'received', p_search: 'customer', p_limit: 50, p_offset: 100 },
  })

  await listOrdersPage({ page: '-1', pageSize: '0' }, admin)
  assert.equal(calls.at(-1).args.p_branch_id, null)
  assert.equal(calls.at(-1).args.p_limit, 1)
  assert.equal(calls.at(-1).args.p_offset, 0)
  await assert.rejects(listOrdersPage({ status: 'unknown' }, staff), /invalid/i)
})

test('customer and inventory pages enforce staff branch scope and bounded results', async t => {
  const calls = mockDatabase(t)
  database.rpc = async (name, args) => {
    calls.push({ rpc: name, args })
    return { data: { data: [], count: 0 }, error: null }
  }

  await listCustomersPage({ page: '1', pageSize: '1000', search: 'Ana' }, staff)
  assert.deepEqual(calls.at(-1), {
    rpc: 'list_customers_page',
    args: { p_branch_id: 'branch-a', p_search: 'Ana', p_limit: 50, p_offset: 50 },
  })

  await listInventoryPage({ page: '2', pageSize: '1000', branch: 'Other branch', search: 'Detergent' }, staff)
  assert.deepEqual(calls.at(-1), {
    rpc: 'list_inventory_page',
    args: { p_branch: 'Main', p_search: 'Detergent', p_limit: 100, p_offset: 200 },
  })

  await listInventoryPage({ branch: 'Other branch' }, admin)
  assert.equal(calls.at(-1).args.p_branch, 'Other branch')
})

function mockDatabase(t, rows = []) {
  const originalFrom = database.from
  const originalRpc = database.rpc
  const calls = []
  database.from = table => {
    let selected = [...rows]
    const query = {then(resolve, reject) { return Promise.resolve({data:selected,error:null}).then(resolve,reject) }}
    for (const method of ['select','update','insert','delete','order','range','limit','gte','lte','ilike','in','not','neq']) {
      query[method] = (...args) => {calls.push({table,method,args}); return query}
    }
    for (const method of ['eq','is']) query[method] = (key,value) => {
      calls.push({table,method,args:[key,value]})
      selected = selected.filter(row => (key.split('.').reduce((value,part) => value?.[part],row) ?? null) === value)
      return query
    }
    query.neq = (key,value) => {
      calls.push({table,method:'neq',args:[key,value]})
      selected = selected.filter(row => row[key] !== value)
      return query
    }
    query.maybeSingle = query.single = async () => ({data:selected[0] || null,error:null})
    return query
  }
  database.rpc = async (name,args) => {calls.push({rpc:name,args}); return {data:{},error:null}}
  t.after(() => {database.from=originalFrom; database.rpc=originalRpc})
  return calls
}

test('staff cannot alter settings, directly set stages, or delete transaction history', async t => {
  const calls = mockDatabase(t)
  for (const [table,operation,payload] of [
    ['settings','update',{}], ['orders','update',{status:'released'}],
    ['staff','insert',{}], ['orders','delete',{}],
  ]) await assert.rejects(execute(table,{operation,payload},staff))
  assert.equal(calls.length,0)
})

test('staff can archive inventory items assigned to their branch only', async t => {
  const calls = mockDatabase(t, [{ id: 'inventory-1', name: 'Detergent', branch: 'Main', branch_id: 'branch-a' }])
  await execute('inventory_items', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: 'inventory-1' }] }, staff)
  assert.equal(calls.some(call => call.table === 'inventory_items' && call.method === 'update'), true)
  assert.equal(calls.some(call => call.table === 'audit_logs' && call.method === 'insert'), true)
  assert.equal(calls.some(call => call.table === 'inventory_items' && call.method === 'eq' && call.args[0] === 'branch' && call.args[1] === staff.branch), true)

  const otherBranchCalls = mockDatabase(t, [{ id: 'inventory-2', name: 'Other stock', branch: 'Calzada', branch_id: 'branch-b' }])
  await execute('inventory_items', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: 'inventory-2' }] }, staff)
  assert.equal(otherBranchCalls.some(call => call.table === 'inventory_items' && call.method === 'update'), false)
  assert.equal(otherBranchCalls.some(call => call.table === 'audit_logs'), false)
})

test('placed order pricing, services, inventory selections, and ownership are immutable', async t => {
  const calls = mockDatabase(t)
  for (const payload of [
    { total_price: 1 }, { service_type_id: 'other-service' }, { weight_kg: 1 },
    { addons: {} }, { customer_id: 'other-customer' }, { branch_id: 'other-branch' },
  ]) await assert.rejects(execute('orders', { operation: 'update', payload, filters: [{ type: 'eq', column: 'id', value: 'order-1' }] }, staff))
  assert.equal(calls.length, 0)
})

test('new client records require email, but order clients may omit it', async t => {
  const calls = mockDatabase(t)
  await assert.rejects(
    execute('customers', { operation: 'insert', payload: { name: 'Test Client', phone: '09123456789' } }, staff),
    /email/i,
  )
  await createOrder({
    customer: { name: 'Test Client', phone: '09123456789' },
    order: { weight_kg: 8, total_price: 200 },
  }, staff)
  const orderCall = calls.find(call => call.rpc === 'create_branch_order')
  assert.equal(orderCall.args.p_order.amount_paid, 0)
  assert.equal(orderCall.args.p_order.payment_status, 'unpaid')
})

test('staff cannot change customer phone numbers or email addresses', async t => {
  const calls = mockDatabase(t)
  for (const payload of [
    { phone: '09999999999' },
    { email: 'replacement@example.com' },
    { name: 'Changed Name', phone: '09999999999', email: 'replacement@example.com' },
  ]) {
    await assert.rejects(
      execute('customers', {
        operation: 'update', payload,
        filters: [{ type: 'eq', column: 'id', value: 'customer-1' }],
      }, staff),
      /Only administrators/,
    )
  }
  assert.equal(calls.length, 0)
})

test('staff cannot overwrite current inventory stock outside audited workflows', async t => {
  const calls = mockDatabase(t)
  for (const payload of [{ current_stock: 999 }, { branch: 'Other' }, { branch_id: 'other' }, { unit: 'kg' }]) {
    await assert.rejects(execute('inventory_items', {
      operation: 'update', payload,
      filters: [{ type: 'eq', column: 'id', value: 'inventory-1' }],
    }, staff), /cannot be edited directly|branch and unit are locked/)
  }
  assert.equal(calls.length, 0)
})

test('staff cannot use recycle-bin administration', async t => {
  const calls = mockDatabase(t)
  await assert.rejects(listRecycleBin(staff), /Administrator/)
  await assert.rejects(restoreRecord({table:'staff',id:'other'},staff), /Administrator/)
  assert.equal(calls.length,0)
})

test('cancellation and restock reject other branches and invalid quantities', async t => {
  const calls = mockDatabase(t,[{id:'other',branch_id:'branch-b'}])
  await assert.rejects(cancelOrder({orderId:'other',reason:'Mistake'},staff), /branch/)
  await assert.rejects(restockInventory({itemId:'other',quantity:-1},staff), /quantity/)
  assert.equal(calls.some(call => call.rpc),false)
})

test('restock no longer accepts or forwards a supplier name', async t => {
  const calls = mockDatabase(t, [{ id: 'item-a', branch_id: staff.branchId }])
  await restockInventory({ itemId: 'item-a', quantity: 2, costTotal: 40, supplier: 'ignored supplier' }, staff)
  const rpcCall = calls.find(call => call.rpc === 'restock_branch_inventory')
  assert.ok(rpcCall)
  assert.equal(rpcCall.args.p_supplier, '')
})

test('initial inventory creation validates its total cost and records it through the atomic branch RPC', async t => {
  const calls = mockDatabase(t, [{ id: 'branch-a', name: 'Main' }])
  await assert.rejects(createInventoryItem({ name: 'Soap', unit: 'pcs', quantity: 0, costTotal: 25 }, staff), /stock must be greater than zero/i)
  await assert.rejects(createInventoryItem({ name: 'Soap', unit: 'invalid', quantity: 2, costTotal: 25 }, staff), /valid inventory unit/i)
  assert.equal(calls.length, 0)

  await createInventoryItem({ name: ' Soap ', unit: 'pcs', quantity: 10, minimumStock: 2, costTotal: 250, branch: 'Other', supplier: 'ignored supplier' }, staff)
  const rpcCall = calls.find(call => call.rpc === 'create_branch_inventory_item')
  assert.ok(rpcCall)
  assert.equal(rpcCall.args.p_branch_id, 'branch-a')
  assert.equal(rpcCall.args.p_staff_id, staff.staffId)
  assert.equal(rpcCall.args.p_name, 'Soap')
  assert.equal(rpcCall.args.p_quantity, 10)
  assert.equal(rpcCall.args.p_cost_total, 250)
  assert.equal(rpcCall.args.p_supplier, '')
})

test('global admin must choose a branch for a new order', async t => {
  const calls = mockDatabase(t)
  await assert.rejects(createOrder({order:{}},admin), /select a branch/)
  assert.equal(calls.length,0)
})

test('public tracking must reject wildcard-only input before querying orders', async t => {
  const calls = mockDatabase(t)
  for (const input of ['%', '_', 'IC-', '20260909', 'IC-20260909-12%4', {}, '']) {
    await assert.rejects(trackOrder(input))
  }
  assert.equal(calls.length,0)
})

test('public service pricing returns only active, non-archived service rates', async t => {
  const active = {
    name: 'Regular Laundry', bundle_kg: 8, bundle_price: 200,
    excess_kg_price: 30, processing_type: 'full_service', is_active: true, deleted_at: null,
  }
  mockDatabase(t, [
    active,
    { ...active, name: 'Inactive', is_active: false },
    { ...active, name: 'Archived', deleted_at: '2026-10-02T00:00:00Z' },
  ])
  const result = await getPublicServices()
  assert.deepEqual(result.data, [active])
})

test('customer directory must exclude records in the recycle bin', async t => {
  mockDatabase(t,[{id:'deleted-client',deleted_at:'2026-09-08T00:00:00Z'}])
  assert.deepEqual((await listVisibleCustomers(admin)).data,[])
})

test('customer loyalty lookups are batched so a large directory does not exceed the database URL limit', async t => {
  const customers = Array.from({ length: 205 }, (_, index) => ({
    id: `customer-${index + 1}`,
    deleted_at: null,
  }))
  const calls = mockDatabase(t, customers)
  const result = await listVisibleCustomers(admin)
  const rewardLookups = calls.filter(call => call.table === 'loyalty_rewards' && call.method === 'in')
  assert.equal(result.data.length, 205)
  assert.equal(rewardLookups.length, 3)
  assert.deepEqual(rewardLookups.map(call => call.args[1].length), [100, 100, 5])
})

test('staff must not be allowed to delete another staff account via generic data API', async t => {
  const calls = mockDatabase(t, [{id:'other-account'}])
  await assert.rejects(execute('staff',{operation:'delete',filters:[{type:'eq',column:'id',value:'other-account'}]},staff))
  assert.equal(calls.some(call => call.table === 'staff' && call.method === 'update'),false)
})

test('new orders reject invalid payments but allow a blank payment to follow later', async t => {
  const calls = mockDatabase(t)
  for (const amount_paid of ['invalid', 'Infinity', Infinity, NaN, -1, true, [], 201]) {
    await assert.rejects(createOrder({customer:{ name:'Test Customer', phone:'09123456789' },order:{weight_kg:8,total_price:200,amount_paid}},staff))
  }
  for (const amount_paid of [null, '', undefined, 0, 99]) {
    await createOrder({customer:{ name:'Test Customer', phone:'09123456789' },order:{weight_kg:8,total_price:200,amount_paid}},staff)
  }
  assert.deepEqual(calls.filter(call => call.rpc).map(call => call.args.p_order.payment_status), ['unpaid', 'unpaid', 'unpaid', 'unpaid', 'partial'])
})

test('tracking supports complete current and legacy receipts, excludes cancelled orders, and selects no customer or payment fields', async t => {
  const rows = ['IC','HC','4J'].map(prefix => ({order_number:prefix+'-20260909-1234',status:'received'}))
  rows.push({order_number:'IC-20260909-5678',status:'cancelled'})
  const calls = mockDatabase(t,rows)
  for (const row of rows.slice(0,3)) {
    assert.deepEqual((await trackOrder(' '+row.order_number.toLowerCase()+' ')).data,[row])
  }
  assert.deepEqual((await trackOrder('IC-20260909-5678')).data,[])
  assert.deepEqual((await trackOrder('IC-20260909-9999')).data,[])
  for (const call of calls.filter(call => call.method === 'select')) {
    assert.doesNotMatch(call.args[0], /customer|total_price|payment|notes|staff/)
  }
  assert.equal(calls.some(call => call.method === 'ilike'),false)
  assert.equal(calls.filter(call => call.method === 'limit' && call.args[0] === 1).length,5)
})

test('staff client directory excludes deleted associations and other branches', async t => {
  const active = {id:'active-client',deleted_at:null}
  mockDatabase(t,[
    {branch_id:'branch-a',customers:active},
    {branch_id:'branch-a',customers:{id:'deleted-client',deleted_at:'2026-09-09'}},
    {branch_id:'branch-b',customers:{id:'other-client',deleted_at:null}},
    {branch_id:'branch-a',customers:null},
  ])
  assert.deepEqual((await listVisibleCustomers(staff)).data,[{ ...active, loyaltyRewards: [] }])
})

test('admin may still archive another account and its audit is written', async t => {
  const calls = mockDatabase(t,[{id:'other-account'}])
  await execute('staff',{operation:'delete',filters:[{type:'eq',column:'id',value:'other-account'}]},admin)
  assert.equal(calls.some(call => call.table === 'staff' && call.method === 'update'),true)
  assert.equal(calls.some(call => call.table === 'audit_logs' && call.method === 'insert'),true)
})

test('valid numeric payment strings retain partial and paid order behavior', async t => {
  const calls = mockDatabase(t)
  for (const amount_paid of ['100','200']) {
    await createOrder({
      customer: { name: 'Test Customer', phone: '09123456789', email: 'customer@example.com' },
      order:{weight_kg:8,total_price:200,amount_paid},
    },staff)
  }
  assert.deepEqual(calls.filter(call => call.rpc).map(call => [
    call.args.p_order.amount_paid,call.args.p_order.payment_status,
  ]),[[100,'partial'],[200,'paid']])
})
