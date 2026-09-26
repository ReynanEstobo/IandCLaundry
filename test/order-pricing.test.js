import assert from 'node:assert/strict'
import test from 'node:test'
import { orderItemsTotal, serviceItemSubtotal, validServiceItem } from '../frontend/src/utils/orderPricing.js'

const settings = { bundlekg: 8, bundleprice: 200, excesskgprice: 30 }
const services = [
  { id: 'regular', pricing_type: 'bundle', unit_price: 0 },
  { id: 'comforter', pricing_type: 'per_kg', unit_price: 80 },
  { id: 'gown', pricing_type: 'per_piece', unit_price: 100 },
  { id: 'delivery', pricing_type: 'fixed', unit_price: 50 },
]

test('each supported service pricing type has an independent subtotal', () => {
  assert.equal(serviceItemSubtotal({ weight_kg: 10 }, services[0], settings), 260)
  assert.equal(serviceItemSubtotal({ weight_kg: 2 }, services[1], settings), 160)
  assert.equal(serviceItemSubtotal({ quantity: 3 }, services[2], settings), 300)
  assert.equal(serviceItemSubtotal({}, services[3], settings), 50)
})

test('mixed services are summed once at the order level', () => {
  const items = [
    { service_type_id: 'regular', weight_kg: 6 },
    { service_type_id: 'comforter', weight_kg: 2 },
    { service_type_id: 'gown', quantity: 1 },
  ]
  assert.equal(orderItemsTotal(items, services, settings), 460)
})

test('service input validation follows pricing configuration rather than service name', () => {
  assert.equal(validServiceItem({ weight_kg: 1 }, services[1]), true)
  assert.equal(validServiceItem({ quantity: 1.5 }, services[2]), false)
  assert.equal(validServiceItem({}, services[3]), true)
})
