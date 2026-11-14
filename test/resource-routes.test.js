import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { TABLES } from '../backend/models/databaseModel.js'
import { resourceRoutes } from '../backend/routes/resourceRoutes.js'

// The browser's table → URL map in client.js, read as text so the browser
// module (and its storage access) is not loaded in Node.
async function browserResourcePaths() {
  const source = await readFile(new URL('../frontend/src/services/api/client.js', import.meta.url), 'utf8')
  const block = source.match(/const resourcePaths = \{([\s\S]*?)\n\}/)?.[1] || ''
  return Object.fromEntries([...block.matchAll(/(\w+):\s*'([^']+)'/g)].map(match => [match[1], match[2]]))
}

test('every table the backend serves has a backend route and the same URL in the browser', async () => {
  const routedTables = new Map([...resourceRoutes].map(([route, table]) => [table, route]))
  const browser = await browserResourcePaths()
  for (const table of TABLES) {
    assert.ok(routedTables.has(table), `${table} has no backend route in backend/routes/resourceRoutes.js`)
    // ai_forecasts is server-side only; the browser never reads it directly.
    if (table === 'ai_forecasts') continue
    assert.equal(browser[table], `/api/${routedTables.get(table)}`, `${table} is missing or different in client.js resourcePaths`)
  }
})
