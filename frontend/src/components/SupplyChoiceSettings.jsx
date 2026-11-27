import { Package, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { runQuery } from '../services/api/client'
import { quantity, unitName } from '../utils/alertText'
import { stockStep, wholeNumberProblem } from '../utils/inventoryUnits'
import AutoSaveStatus from './AutoSaveStatus'

let rowKey = 0
const nextKey = () => `new-${++rowKey}`
const SAVE_DELAY = 700
const firstRow = data => (Array.isArray(data) ? data[0] : data) || null
const pesos = value => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Services page: what staff may offer when a customer asks for something
// different, for each usual supply of the selected service at the selected
// branch. Every change saves by itself: switches at once, replacement rows a
// moment after typing stops (and only once they are complete and valid).
export default function SupplyChoiceSettings({ branchId, serviceId, serviceName, branchName, inventory, requirements, replacements, onRequirementSaved, onReplacementsChange }) {
  const lines = useMemo(() => requirements
    .filter(row => row.branch_id === branchId && row.service_type_id === serviceId && row.is_active !== false)
    .map(row => ({ ...row, item: inventory.find(item => item.id === row.inventory_item_id) }))
    .filter(row => row.item)
    .sort((a, b) => a.item.name.localeCompare(b.item.name)), [requirements, inventory, branchId, serviceId])
  const usualIds = useMemo(() => new Set(lines.map(line => line.inventory_item_id)), [lines])
  const branchItems = useMemo(() => inventory.filter(item => item.branch_id === branchId && !item.deleted_at)
    .sort((a, b) => a.name.localeCompare(b.name)), [inventory, branchId])
  const [rowsByLine, setRowsByLine] = useState({})
  const [status, setStatus] = useState({ state: 'idle' })
  const timers = useRef(new Map())
  const pending = useRef(0)
  const rowsRef = useRef(rowsByLine)
  rowsRef.current = rowsByLine
  const replacementsRef = useRef(replacements)
  replacementsRef.current = replacements

  // Rows are rebuilt only when another branch, service, or set of usual
  // supplies is shown, so a save never clears what is being typed elsewhere.
  const linesKey = `${branchId}|${serviceId}|${lines.map(line => line.id).join(',')}`
  useEffect(() => {
    setRowsByLine(Object.fromEntries(lines.map(line => [line.id, replacements
      .filter(option => option.requirement_id === line.id)
      .map(option => ({
        key: option.id, id: option.id, replacement_item_id: option.replacement_item_id,
        quantity_per_load: String(Number(option.quantity_per_load)), extra_charge_per_load: String(Number(option.extra_charge_per_load ?? 0)),
      }))])))
    setStatus({ state: 'idle' })
  }, [linesKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => timers.current.forEach(timer => clearTimeout(timer)), [])

  const track = useCallback(async work => {
    pending.current += 1
    setStatus({ state: 'saving' })
    try {
      await work()
      pending.current -= 1
      if (!pending.current) setStatus({ state: 'saved', at: Date.now() })
    } catch (error) {
      pending.current -= 1
      setStatus({ state: 'error', message: error.message || 'A change could not be saved.' })
    }
  }, [])

  function rowProblem(line, row, rows) {
    const item = inventory.find(candidate => candidate.id === row.replacement_item_id)
    if (!item) return 'Choose the item that may be used instead.'
    if (item.deleted_at || item.branch_id !== branchId) return `${item.name} is no longer in this branch's inventory. Remove it.`
    if (usualIds.has(item.id)) return `${item.name} is a usual supply of ${serviceName}. Remove it.`
    if (rows.some(other => other.key !== row.key && other.replacement_item_id === row.replacement_item_id)) return `${item.name} is already listed.`
    const amount = Number(row.quantity_per_load)
    if (row.quantity_per_load === '' || !(amount > 0) || amount > 100000) return 'Enter the amount used per load (more than 0).'
    const whole = wholeNumberProblem(item.unit, row.quantity_per_load, 'The amount per load')
    if (whole) return whole
    const charge = row.extra_charge_per_load === '' ? 0 : Number(row.extra_charge_per_load)
    if (!Number.isFinite(charge) || charge < 0 || charge > 10000) return 'Enter an extra charge from ₱0 to ₱10,000.'
    return null
  }

  // Saves one replacement row if it is complete, valid and different from
  // what is saved. A new row is inserted once; later edits update it.
  async function saveRow(lineId, key) {
    const line = lines.find(candidate => candidate.id === lineId)
    const rows = rowsRef.current[lineId] || []
    const row = rows.find(candidate => candidate.key === key)
    if (!line || !row || rowProblem(line, row, rows)) return
    const values = {
      replacement_item_id: row.replacement_item_id,
      quantity_per_load: Number(row.quantity_per_load),
      extra_charge_per_load: row.extra_charge_per_load === '' ? 0 : Number(row.extra_charge_per_load),
    }
    const saved = row.id ? replacementsRef.current.find(option => option.id === row.id) : null
    if (saved && saved.replacement_item_id === values.replacement_item_id && Number(saved.quantity_per_load) === values.quantity_per_load
      && Number(saved.extra_charge_per_load) === values.extra_charge_per_load) return
    await track(async () => {
      const result = await runQuery('service_supply_replacements', row.id
        ? { operation: 'update', payload: values, filters: [{ type: 'eq', column: 'id', value: row.id }], returning: true }
        : { operation: 'insert', payload: { ...values, requirement_id: lineId, branch_id: branchId, service_type_id: serviceId, is_active: true }, returning: true })
      if (result.error) throw result.error
      const stored = firstRow(result.data)
      if (!stored) return
      setRowsByLine(current => ({ ...current, [lineId]: (current[lineId] || []).map(candidate => candidate.key === key ? { ...candidate, id: stored.id } : candidate) }))
      onReplacementsChange(list => [...list.filter(option => option.id !== stored.id), stored])
    })
  }

  function schedule(lineId, key, delay = SAVE_DELAY) {
    const timerKey = `${lineId}:${key}`
    clearTimeout(timers.current.get(timerKey))
    timers.current.set(timerKey, setTimeout(() => { timers.current.delete(timerKey); saveRow(lineId, key) }, delay))
  }

  function editRow(lineId, key, changes, delay) {
    setRowsByLine(current => ({ ...current, [lineId]: (current[lineId] || []).map(row => row.key === key ? { ...row, ...changes } : row) }))
    schedule(lineId, key, delay)
  }

  function addRow(line) {
    setRowsByLine(current => ({ ...current, [line.id]: [...(current[line.id] || []), {
      key: nextKey(), replacement_item_id: '', quantity_per_load: String(Number(line.quantity_per_load)), extra_charge_per_load: '0',
    }] }))
  }

  function removeRow(lineId, row) {
    clearTimeout(timers.current.get(`${lineId}:${row.key}`))
    setRowsByLine(current => ({ ...current, [lineId]: (current[lineId] || []).filter(candidate => candidate.key !== row.key) }))
    if (!row.id) return
    track(async () => {
      const result = await runQuery('service_supply_replacements', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: row.id }] })
      if (result.error) throw result.error
      onReplacementsChange(list => list.filter(option => option.id !== row.id))
    })
  }

  function toggle(line, field) {
    const value = !(line[field] !== false)
    onRequirementSaved(line.id, { [field]: value })
    track(async () => {
      const result = await runQuery('service_inventory_requirements', {
        operation: 'update', payload: { [field]: value }, filters: [{ type: 'eq', column: 'id', value: line.id }], returning: true,
      })
      if (result.error) {
        onRequirementSaved(line.id, { [field]: !value })
        throw result.error
      }
    })
  }

  return <div className="card settings-card supply-settings-card">
    <div className="settings-card-header supply-settings-header">
      <div>
        <h3>Customer supply choices</h3>
        <p>When a customer asks for something different, what may staff do with each usual supply of <strong>{serviceName || 'this service'}</strong> at <strong>{branchName || 'this branch'}</strong>?</p>
      </div>
      <AutoSaveStatus status={status} />
    </div>
    {!lines.length ? <div className="addon-empty-state">Turn on &ldquo;Deduct automatically&rdquo; for at least one item in the checklist above. Its customer choices will appear here.</div>
      : <div className="supply-setup-list">{lines.map(line => {
        const rows = rowsByLine[line.id] || []
        const taken = new Set(rows.map(row => row.replacement_item_id))
        const allowOwn = line.allow_customer_own !== false
        const allowLeaveOut = line.allow_leave_out !== false
        return <section key={line.id} className="supply-setup-item" aria-labelledby={`supply-setup-${line.id}`}>
          <header className="supply-setup-head">
            <span className="supply-setup-icon" aria-hidden="true"><Package size={17} /></span>
            <div className="supply-setup-title">
              <strong id={`supply-setup-${line.id}`}>{line.item.name}</strong>
              <span>Usual amount: {quantity(line.quantity_per_load, line.item.unit)} per load</span>
            </div>
          </header>

          <div className="supply-setup-switches">
            <SwitchRow
              id={`supply-own-${line.id}`} on={allowOwn} onToggle={() => toggle(line, 'allow_customer_own')}
              label="Customer may bring their own" detail="Nothing is taken from stock. The price stays the same." />
            <SwitchRow
              id={`supply-none-${line.id}`} on={allowLeaveOut} onToggle={() => toggle(line, 'allow_leave_out')}
              label="May be left out" detail="None of it is used. The price stays the same." />
          </div>

          <div className="supply-setup-replacements">
            <div className="supply-setup-subhead">
              <strong>Approved replacements</strong>
              <span>Staff can choose these under &ldquo;Other item&rdquo;.</span>
            </div>
            {!rows.length && <p className="supply-setup-empty">None yet. Staff cannot choose &ldquo;Other item&rdquo; for {line.item.name} until you add one.</p>}
            {rows.map(row => {
              const item = inventory.find(candidate => candidate.id === row.replacement_item_id)
              const choices = branchItems.filter(candidate => !usualIds.has(candidate.id) && (candidate.id === row.replacement_item_id || !taken.has(candidate.id)))
              const problem = row.replacement_item_id ? rowProblem(line, row, rows) : null
              const charge = Number(row.extra_charge_per_load) || 0
              const id = `replacement-${line.id}-${row.key}`
              return <div key={row.key} className={`supply-replacement-card ${problem ? 'has-problem' : ''}`}>
                <div className="supply-replacement-fields">
                  <div className="form-group">
                    <label htmlFor={`${id}-item`}>Item</label>
                    <select id={`${id}-item`} className="form-control" value={row.replacement_item_id || ''}
                      onChange={event => editRow(line.id, row.key, { replacement_item_id: event.target.value }, 0)}>
                      <option value="" disabled>Choose an item</option>
                      {item && !choices.some(candidate => candidate.id === item.id) && <option value={item.id}>{item.name} (no longer available)</option>}
                      {choices.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor={`${id}-amount`}>Amount per load</label>
                    <div className="supply-input-unit">
                      <input id={`${id}-amount`} className="form-control" type="number" inputMode="decimal"
                        min={stockStep(item?.unit)} step={stockStep(item?.unit)} value={row.quantity_per_load}
                        onChange={event => editRow(line.id, row.key, { quantity_per_load: event.target.value })}
                        onBlur={() => schedule(line.id, row.key, 0)} />
                      <span>{item ? unitName(item.unit) : ''}</span>
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor={`${id}-charge`}>Extra charge per load</label>
                    <div className="supply-input-unit is-prefix">
                      <span>₱</span>
                      <input id={`${id}-charge`} className="form-control" type="number" inputMode="decimal" min="0" max="10000" step="0.01"
                        placeholder="0.00" value={row.extra_charge_per_load}
                        onChange={event => editRow(line.id, row.key, { extra_charge_per_load: event.target.value })}
                        onBlur={() => schedule(line.id, row.key, 0)} />
                    </div>
                  </div>
                  <button type="button" className="btn-icon supply-replacement-remove" aria-label={`Remove ${item?.name || 'this replacement'}`}
                    title="Remove" onClick={() => removeRow(line.id, row)}><Trash2 size={16} aria-hidden="true" /></button>
                </div>
                <p className={`supply-replacement-note ${problem ? 'is-problem' : ''}`} role={problem ? 'alert' : undefined}>
                  {problem || (item
                    ? `Uses ${quantity(Number(row.quantity_per_load) || 0, item.unit)} per load instead of ${quantity(line.quantity_per_load, line.item.unit)} of ${line.item.name}. ${charge > 0 ? `The customer pays ${pesos(charge)} more per load.` : 'No extra charge.'}`
                    : 'Choose an item to save this replacement.')}
                </p>
              </div>
            })}
            <button type="button" className="btn btn-sm btn-secondary supply-add-replacement" onClick={() => addRow(line)}>
              <Plus size={14} aria-hidden="true" /> Add a replacement for {line.item.name}
            </button>
          </div>
        </section>
      })}</div>}
  </div>
}

function SwitchRow({ id, on, onToggle, label, detail }) {
  return <div className="supply-switch-row">
    <div>
      <span className="supply-switch-label" id={`${id}-label`}>{label}</span>
      <span className="supply-switch-detail" id={`${id}-detail`}>{detail}</span>
    </div>
    <button type="button" role="switch" className={`settings-toggle ${on ? 'active' : ''}`} aria-checked={on}
      aria-labelledby={`${id}-label`} aria-describedby={`${id}-detail`} onClick={onToggle}>
      <div className="settings-toggle-knob" />
    </button>
  </div>
}
