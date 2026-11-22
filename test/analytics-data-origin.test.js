import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dataOrigin,
  isLiveOperationalRecord,
  isVerifiedAggregateRecord,
} from '../frontend/src/utils/analyticsMetrics.js'

test('legacy and new operational records default to live analytics', () => {
  assert.equal(dataOrigin({}), 'live')
  assert.equal(isLiveOperationalRecord({ data_origin: 'live' }), true)
  assert.equal(isVerifiedAggregateRecord({ data_origin: 'live' }), true)
})

test('aggregate reconstructions remain available only to aggregate analytics', () => {
  const record = { data_origin: 'aggregate_reconstruction' }
  assert.equal(isVerifiedAggregateRecord(record), true)
  assert.equal(isLiveOperationalRecord(record), false)
})

test('demo records are excluded from both live and verified aggregate analytics', () => {
  const record = { data_origin: 'demo' }
  assert.equal(isVerifiedAggregateRecord(record), false)
  assert.equal(isLiveOperationalRecord(record), false)
})
