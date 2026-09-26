import assert from 'node:assert/strict'
import test from 'node:test'
import { orderItemsTotal, serviceItemSubtotal, validServiceItem } from '../frontend/src/utils/orderPricing.js'

const services = [
  { id: 'regular', bundle_kg: 8, bundle_price: 200, excess_kg_price: 30, processing_type: 'full_service' },
  { id: 'comforter', bundle_kg: 5, bundle_price: 350, excess_kg_price: 50, processing_type: 'full_service' },
  { id: 'gown', bundle_kg: 3, bundle_price: 180, excess_kg_price: 40, processing_type: 'air_dry_only' },
]

test('every service uses its own per-load price configuration', () => {
  assert.equal(serviceItemSubtotal({ weight_kg: 10 }, services[0]), 260)
  assert.equal(serviceItemSubtotal({ weight_kg: 2 }, services[1]), 350)
  assert.equal(serviceItemSubtotal({ weight_kg: 5 }, services[2]), 260)
})

test('mixed services are summed once at the order level', () => {
  const items = [
    { service_type_id: 'regular', weight_kg: 6 },
    { service_type_id: 'comforter', weight_kg: 2 },
    { service_type_id: 'gown', weight_kg: 9 },
  ]
  assert.equal(orderItemsTotal(items, services), 970)
})

test('every service requires a positive weight', () => {
  assert.equal(validServiceItem({ weight_kg: 1 }, services[1]), true)
  assert.equal(validServiceItem({ quantity: 1.5 }, services[2]), false)
  assert.equal(validServiceItem({}, services[2]), false)
})
