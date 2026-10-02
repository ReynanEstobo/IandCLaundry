import assert from 'node:assert/strict'
import test from 'node:test'
import { servicePricingResponse } from '../frontend/src/utils/servicePricingResponse.js'

test('price questions list every available service with load and excess rates', () => {
  const response = servicePricingResponse([
    { name: 'Comforter', bundle_kg: 8, bundle_price: 400, excess_kg_price: 50, is_active: true },
    { name: 'Regular Laundry', bundle_kg: 8, bundle_price: 200, excess_kg_price: 30, is_active: true },
    { name: 'Hidden Service', bundle_kg: 8, bundle_price: 1, excess_kg_price: 1, is_active: false },
    { name: 'Archived Service', bundle_kg: 8, bundle_price: 1, excess_kg_price: 1, deleted_at: '2026-10-02' },
  ])

  assert.match(response, /Comforter: ₱400 per 8 kg load; ₱50 per excess kg/)
  assert.match(response, /Regular Laundry: ₱200 per 8 kg load; ₱30 per excess kg/)
  assert.doesNotMatch(response, /Hidden Service|Archived Service/)
})

test('price response does not invent rates when the service catalog is unavailable', () => {
  assert.match(servicePricingResponse([]), /temporarily unavailable/i)
})
