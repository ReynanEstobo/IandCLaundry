import { execute } from '../models/databaseModel.js'
import { events } from '../services/realtimeService.js'

function validate(table, { operation, payload = {} }) {
  if (!['insert', 'update'].includes(operation)) return
  if (table === 'customers' && operation === 'insert' && (!payload.name || !payload.phone)) {
    throw Object.assign(new Error('Name and phone are required'), { status: 400 })
  }
  if (table === 'orders' && operation === 'insert' && (!Number(payload.weight_kg) || Number(payload.weight_kg) <= 0)) {
    throw Object.assign(new Error('A valid order weight is required'), { status: 400 })
  }
  if (table === 'inventory_items' && operation === 'insert' && !payload.name) {
    throw Object.assign(new Error('Inventory item name is required'), { status: 400 })
  }
}

// The app never sends a malformed query (an unknown column, table,
// relationship or filter), and describing one would reveal the database
// schema. Business-rule, validation and constraint messages are unchanged.
function publicDatabaseMessage(error) {
  const code = String(error?.code || '')
  const isSchemaError = (code.startsWith('42') || /^PGRST[12]\d\d$/.test(code)) && code !== 'PGRST116'
  return isSchemaError ? 'The request could not be processed.' : error.message
}

export async function handleData(table, body, identity) {
  validate(table, body)
  const result = await execute(table, body, identity)
  if (result.error) throw Object.assign(new Error(publicDatabaseMessage(result.error)), { status: 400, details: result.error })
  // Do not broadcast changed record data to other browser sessions.
  if (body.operation !== 'select') events.emit('change', { table })
  return result
}
