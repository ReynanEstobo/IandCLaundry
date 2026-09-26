import assert from 'node:assert/strict'
import test from 'node:test'
import { orderItemsTotal, serviceItemSubtotal, validServiceItem } from '../frontend/src/utils/orderPricing.js'

const settings = { bundlekg: 8, bundleprice: 200, excesskgprice: 30 }
const services = [
  { id: 'regular', pricing_type: 'bundle', unit_price: 0 },
  { id: 'comforter', pricing_type: 'bundle', unit_price: 80 },
  { id: 'gown', pricing_type: 'bundle', unit_price: 100 },
]

test('every service uses the shared Settings bundle calculation', () => {
  assert.equal(serviceItemSubtotal({ weight_kg: 10 }, services[0], settings), 260)
  assert.equal(serviceItemSubtotal({ weight_kg: 2 }, services[1], settings), 200)
  assert.equal(serviceItemSubtotal({ weight_kg: 9 }, services[2], settings), 230)
})

test('mixed services are summed once at the order level', () => {
  const items = [
    { service_type_id: 'regular', weight_kg: 6 },
    { service_type_id: 'comforter', weight_kg: 2 },
    { service_type_id: 'gown', weight_kg: 9 },
  ]
  assert.equal(orderItemsTotal(items, services, settings), 630)
})

test('every service requires a positive weight', () => {
  assert.equal(validServiceItem({ weight_kg: 1 }, services[1]), true)
  assert.equal(validServiceItem({ quantity: 1.5 }, services[2]), false)
  assert.equal(validServiceItem({}, services[2]), false)
})
