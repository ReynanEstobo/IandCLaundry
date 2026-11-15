import assert from 'node:assert/strict'
import test from 'node:test'
import { byBranch, days, quantity, shortBranch } from '../frontend/src/utils/alertText.js'

test('branch names are shortened to the name people use', () => {
  assert.equal(shortBranch('2nd Branch - Brgy Calzada'), 'Calzada')
  assert.equal(shortBranch('3rd Branch - Nasugbu'), 'Nasugbu')
  assert.equal(shortBranch('Main - Brgy 7'), 'Main')
  assert.equal(shortBranch('Balayan'), 'Balayan')
  assert.equal(shortBranch(null), '')
})

test('quantities and days read naturally in the singular and plural', () => {
  assert.equal(quantity(1, 'sachets'), '1 sachet')
  assert.equal(quantity(3, 'sachets'), '3 sachets')
  assert.equal(quantity(1, 'pcs'), '1 pc')
  assert.equal(quantity(13, 'pcs'), '13 pcs')
  assert.equal(quantity(2, 'L'), '2 L')
  assert.equal(quantity(1200, 'pcs'), '1,200 pcs')
  assert.equal(days(1), '1 day')
  assert.equal(days(3), '3 days')
})

test('alert items are grouped under each branch once, with a limit', () => {
  const items = [
    { name: 'Bleach', branch: '2nd Branch - Brgy Calzada', stock: 3 },
    { name: 'Hanger', branch: '2nd Branch - Brgy Calzada', stock: 13 },
    { name: 'Color-Safe Bleach', branch: '3rd Branch - Nasugbu', stock: 1 },
  ]
  assert.equal(byBranch(items, i => `${i.name} ${i.stock}`), 'Calzada: Bleach 3, Hanger 13 · Nasugbu: Color-Safe Bleach 1')
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `Item ${i + 1}`, branch: 'Main - Brgy 7' }))
  assert.equal(byBranch(many, i => i.name, 3), 'Main: Item 1, Item 2, Item 3 · +5 more')
})
