import { execute } from '../models/databaseModel.js'
import { events } from '../services/realtimeService.js'

function validate(table, { operation, payload = {} }) {
  if (!['insert', 'update'].includes(operation)) return
  if (table === 'customers' && operation === 'insert' && (!payload.name || !payload.phone || !payload.email)) {
    throw Object.assign(new Error('Name, phone, and email are required'), { status: 400 })
  }
  if (table === 'orders' && operation === 'insert' && (!Number(payload.weight_kg) || Number(payload.weight_kg) <= 0)) {
    throw Object.assign(new Error('A valid order weight is required'), { status: 400 })
  }
  if (table === 'inventory_items' && operation === 'insert' && !payload.name) {
    throw Object.assign(new Error('Inventory item name is required'), { status: 400 })
  }
}

export async function handleData(table, body, identity) {
  validate(table, body)
  const result = await execute(table, body, identity)
  if (result.error) throw Object.assign(new Error(result.error.message), { status: 400, details: result.error })
  // Do not broadcast changed record data to other browser sessions.
  if (body.operation !== 'select') events.emit('change', { table })
  return result
}
