import { AlertTriangle, Edit2, PackageCheck, Plus, Save, Trash2, X } from 'lucide-react'

const SAVE_DELAY = 700
const firstRow = data => (Array.isArray(data) ? data[0] : data) || null
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useEscapeToClose from '../components/useEscapeToClose'
import toast from 'react-hot-toast'
import { useShowPageLoader, InlineSkeleton, PageError, PageLoader } from '../components/AsyncState'
import RowActionsMenu from '../components/RowActionsMenu'
import LoadingButton from '../components/LoadingButton'
import ConfirmDialog from '../components/ConfirmDialog'
import InfoNote from '../components/InfoNote'
import { runQuery } from '../services/api/client'
import { findInvalidServiceInventoryConfigs } from '../utils/serviceInventoryConfig'
import { unitName } from '../utils/alertText'
import SupplyChoiceSettings from '../components/SupplyChoiceSettings'
import AutoSaveStatus from '../components/AutoSaveStatus'

const blankService = { name: '', description: '', bundle_kg: 8, bundle_price: '', excess_kg_price: '', processing_type: 'full_service', is_active: true }

export default function ServiceManagement() {
  const [services, setServices] = useState([]), [branches, setBranches] = useState([])
  const [inventory, setInventory] = useState([]), [requirements, setRequirements] = useState([]), [addons, setAddons] = useState([]), [replacements, setReplacements] = useState([])
  const [branchId, setBranchId] = useState(''), [serviceId, setServiceId] = useState('')
  const [recipeDraft, setRecipeDraft] = useState({}), [addonDraft, setAddonDraft] = useState({})
  const [form, setForm] = useState(blankService), [editing, setEditing] = useState(null), [showModal, setShowModal] = useState(false)
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const showPageLoader = useShowPageLoader(loading)
  const [serviceToArchive, setServiceToArchive] = useState(null), [archiving, setArchiving] = useState(false)
  const [removingConfigId, setRemovingConfigId] = useState('')
  // The checklist saves each change by itself (see saveChecklistItem).
  const [checklistStatus, setChecklistStatus] = useState({ state: 'idle' })
  const [loadTick, setLoadTick] = useState(0)
  const [supplyToRemove, setSupplyToRemove] = useState(null)
  const checklistTimers = useRef(new Map())
  const pendingChecklistSaves = useRef(0)
  const requirementsRef = useRef(requirements)
  requirementsRef.current = requirements
  const addonsRef = useRef(addons)
  addonsRef.current = addons

  const load = useCallback(async (background = false) => {
    if (!background) { setLoading(true); setError('') }
    else setRefreshing(true)
    try {
      const results = await Promise.all([
        runQuery('service_types', { operation: 'select', selection: '*', orders: [{ column: 'name', options: { ascending: true } }] }),
        runQuery('branches', { operation: 'select', selection: 'id, name', orders: [{ column: 'name', options: { ascending: true } }] }),
        runQuery('inventory_items', { operation: 'select', selection: 'id, name, unit, current_stock, branch_id, deleted_at', orders: [{ column: 'name', options: { ascending: true } }] }),
        runQuery('service_inventory_requirements', { operation: 'select', selection: '*' }),
        runQuery('service_addon_items', { operation: 'select', selection: '*' }),
        runQuery('service_supply_replacements', { operation: 'select', selection: '*' }),
      ])
      const failed = results.find(result => result.error)
      if (failed) {
        if (!background) setError(failed.error?.message || 'Unable to load service configuration.')
        else console.error('Background service refresh failed:', failed.error)
        return
      }
      setServices(results[0].data || []); setBranches(results[1].data || []); setInventory(results[2].data || [])
      setRequirements(results[3].data || []); setAddons(results[4].data || []); setReplacements(results[5].data || [])
      setLoadTick(tick => tick + 1)
      setBranchId(current => current || results[1].data?.[0]?.id || '')
      setServiceId(current => current || results[0].data?.[0]?.id || '')
    } catch (loadError) {
      if (!background) setError(loadError.message || 'Unable to load service configuration.')
      else console.error('Background service refresh failed:', loadError)
    } finally {
      if (!background) setLoading(false)
      else setRefreshing(false)
    }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const recipes = requirements.filter(row => row.branch_id === branchId && row.service_type_id === serviceId && row.is_active !== false)
    const options = addons.filter(row => row.branch_id === branchId && row.service_type_id === serviceId && row.is_active !== false)
    setRecipeDraft(Object.fromEntries(recipes.map(row => [row.inventory_item_id, String(row.quantity_per_load)])))
    setAddonDraft(Object.fromEntries(options.map(row => [row.inventory_item_id, String(row.unit_price)])))
  }, [branchId, serviceId, loadTick]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => checklistTimers.current.forEach(timer => clearTimeout(timer)), [])

  const branchItems = useMemo(() => inventory.filter(item => item.branch_id === branchId && !item.deleted_at), [inventory, branchId])
  const invalidRequirements = useMemo(
    () => findInvalidServiceInventoryConfigs(requirements.filter(row => row.branch_id === branchId && row.service_type_id === serviceId), inventory),
    [requirements, inventory, branchId, serviceId],
  )
  const invalidAddons = useMemo(
    () => findInvalidServiceInventoryConfigs(addons.filter(row => row.branch_id === branchId && row.service_type_id === serviceId), inventory),
    [addons, inventory, branchId, serviceId],
  )
  const selectedService = services.find(service => service.id === serviceId)
  function openService(service = null) {
    setEditing(service)
    setForm(service ? { name: service.name || '', description: service.description || '', bundle_kg: service.bundle_kg || 8, bundle_price: service.bundle_price ?? '', excess_kg_price: service.excess_kg_price ?? '', processing_type: service.processing_type || 'full_service', is_active: service.is_active !== false } : blankService)
    setShowModal(true)
  }
  async function saveService(event) {
    event.preventDefault(); if (saving) return; setSaving(true)
    const payload = { ...form, bundle_kg: Number(form.bundle_kg), bundle_price: Number(form.bundle_price), excess_kg_price: Number(form.excess_kg_price), estimated_minutes: 120 }
    const result = await runQuery('service_types', editing
      ? { operation: 'update', payload, filters: [{ type: 'eq', column: 'id', value: editing.id }], returning: true }
      : { operation: 'insert', payload, returning: true })
    setSaving(false)
    if (result.error) return toast.error(result.error.message)
    toast.success(editing ? 'Service updated.' : 'Service created.'); setShowModal(false); await load(true)
  }
  async function archiveService(service) {
    if (!service || archiving) return
    setArchiving(true)
    const result = await runQuery('service_types', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: service.id }] })
    setArchiving(false)
    if (result.error) return toast.error(result.error.message)
    setServiceToArchive(null); toast.success('Service archived.'); await load(true)
  }
  // Saves one checklist change: an item turned on, its amount or price
  // changed, or turned off. Invalid amounts are shown on the field, not saved.
  async function saveChecklistItem(kind, itemId, rawValue, scope = { branchId, serviceId }) {
    const table = kind === 'recipe' ? 'service_inventory_requirements' : 'service_addon_items'
    const column = kind === 'recipe' ? 'quantity_per_load' : 'unit_price'
    const rows = kind === 'recipe' ? requirementsRef.current : addonsRef.current
    const existing = rows.find(row => row.branch_id === scope.branchId && row.service_type_id === scope.serviceId && row.inventory_item_id === itemId)
    const enabled = rawValue !== undefined
    const value = Number(rawValue)
    if (enabled && (rawValue === '' || !Number.isFinite(value) || (kind === 'recipe' ? value <= 0 : value < 0))) return
    if (enabled && existing && Number(existing[column]) === value && existing.is_active !== false) return
    if (!enabled && !existing) return
    const setRows = kind === 'recipe' ? setRequirements : setAddons
    pendingChecklistSaves.current += 1
    setChecklistStatus({ state: 'saving' })
    try {
      const request = enabled && existing
        ? { operation: 'update', payload: { [column]: value, is_active: true }, filters: [{ type: 'eq', column: 'id', value: existing.id }], returning: true }
        : enabled ? { operation: 'insert', payload: { branch_id: scope.branchId, service_type_id: scope.serviceId, inventory_item_id: itemId, [column]: value, is_active: true }, returning: true }
          : { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: existing.id }] }
      const result = await runQuery(table, request)
      if (result.error) throw result.error
      if (enabled) {
        const stored = firstRow(result.data)
        if (stored) setRows(list => [...list.filter(row => row.id !== stored.id), stored])
      } else {
        setRows(list => list.filter(row => row.id !== existing.id))
        // Removing a usual supply also removes its customer choices.
        if (kind === 'recipe') setReplacements(list => list.filter(option => option.requirement_id !== existing.id))
      }
      pendingChecklistSaves.current -= 1
      if (!pendingChecklistSaves.current) setChecklistStatus({ state: 'saved' })
    } catch (saveError) {
      pendingChecklistSaves.current -= 1
      setChecklistStatus({ state: 'error', message: saveError.message || 'A change could not be saved.' })
    }
  }
  function scheduleChecklistSave(kind, itemId, rawValue, delay = SAVE_DELAY) {
    const timerKey = `${kind}:${branchId}:${serviceId}:${itemId}`
    const scope = { branchId, serviceId }
    clearTimeout(checklistTimers.current.get(timerKey))
    checklistTimers.current.set(timerKey, setTimeout(() => {
      checklistTimers.current.delete(timerKey)
      saveChecklistItem(kind, itemId, rawValue, scope)
    }, delay))
  }
  function editChecklistValue(kind, itemId, value) {
    const setter = kind === 'recipe' ? setRecipeDraft : setAddonDraft
    setter(current => ({ ...current, [itemId]: value }))
    scheduleChecklistSave(kind, itemId, value)
  }
  function toggleChecklistItem(kind, item, checked) {
    const setter = kind === 'recipe' ? setRecipeDraft : setAddonDraft
    if (checked) {
      setter(current => ({ ...current, [item.id]: current[item.id] || '1' }))
      scheduleChecklistSave(kind, item.id, '1', 0)
      return
    }
    const requirement = requirements.find(row => row.branch_id === branchId && row.service_type_id === serviceId && row.inventory_item_id === item.id)
    const approved = requirement ? replacements.filter(option => option.requirement_id === requirement.id).length : 0
    if (kind === 'recipe' && approved > 0) {
      setSupplyToRemove({ item, approved })
      return
    }
    setter(current => { const next = { ...current }; delete next[item.id]; return next })
    scheduleChecklistSave(kind, item.id, undefined, 0)
  }
  function confirmSupplyRemoval() {
    if (!supplyToRemove) return
    const { item } = supplyToRemove
    setRecipeDraft(current => { const next = { ...current }; delete next[item.id]; return next })
    scheduleChecklistSave('recipe', item.id, undefined, 0)
    setSupplyToRemove(null)
  }
  async function removeInvalidConfiguration(table, row) {
    if (removingConfigId) return
    setRemovingConfigId(row.id)
    const result = await runQuery(table, { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: row.id }] })
    setRemovingConfigId('')
    if (result.error) return toast.error(result.error.message || 'Unable to remove the invalid checklist entry.')
    toast.success(`Removed invalid ${table === 'service_inventory_requirements' ? 'automatic deduction' : 'add-on'} configuration.`)
    await load(true)
  }

  useEscapeToClose(showModal, () => !saving && setShowModal(false))
  if (showPageLoader) return <PageLoader label="Loading service configuration…" />
  if (error) return <PageError message={error} onRetry={load} />
  return <div className="settings-page">
    {refreshing && <div className="section-fetch-state"><InlineSkeleton label="Refreshing service configuration…" /></div>}
    <div className="card settings-card" style={{ marginBottom: 18 }}>
      <div className="settings-card-header"><div><h3>Services and pricing</h3><p>Every service uses per-load pricing. Configure its included kilograms, load price, excess rate, and workflow.</p></div><button className="btn btn-primary" onClick={() => openService()}><Plus size={16} /> Add service</button></div>
      <div className="table-wrapper responsive-card-table"><table><thead><tr><th>Service</th><th>Load price</th><th>Excess</th><th>Workflow</th><th>Status</th><th /></tr></thead><tbody>{services.map(service => <tr key={service.id}>
        <td data-card-primary data-label="Service"><strong>{service.name}</strong>{service.description && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{service.description}</div>}</td>
        <td data-label="Load price">₱{Number(service.bundle_price || 0).toLocaleString()} / {Number(service.bundle_kg || 0)} kg</td><td data-label="Excess">₱{Number(service.excess_kg_price || 0).toLocaleString()} / kg</td>
        <td data-label="Workflow">{service.processing_type === 'air_dry_only' ? 'Air-drying only · no washing' : 'Full laundry service'}</td><td data-label="Status">{service.is_active ? 'Active' : 'Inactive'}</td>
        <td data-card-actions data-label="Actions"><div className="row-actions">
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => openService(service)} aria-label={`Edit ${service.name}`}><Edit2 size={14} aria-hidden="true" /> Edit</button>
          <RowActionsMenu label={`More actions for ${service.name}`} items={[{ key: 'archive', label: 'Archive service', icon: Trash2, tone: 'danger', onSelect: () => setServiceToArchive(service) }]} />
        </div></td>
      </tr>)}</tbody></table></div>
    </div>
    <div className="card settings-card">
      <div className="settings-card-header supply-settings-header"><div><h3>Branch inventory checklist</h3><p>Choose stock consumed per load and which inventory items staff may add to orders for this service.</p></div><AutoSaveStatus status={checklistStatus} /></div>
      <div className="form-row"><div className="form-group"><label htmlFor="recipe-branch">Branch</label><select id="recipe-branch" className="form-control" value={branchId} onChange={event => setBranchId(event.target.value)}>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div><div className="form-group"><label htmlFor="recipe-service">Service</label><select id="recipe-service" className="form-control" value={serviceId} onChange={event => setServiceId(event.target.value)}>{services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}</select></div></div>
      {selectedService && <div className="pricing-card" style={{ marginBottom: 16 }}><PackageCheck size={18} /> <strong>{selectedService.name}</strong> · item quantities are multiplied by the calculated loads.</div>}
      {(invalidRequirements.length > 0 || invalidAddons.length > 0) && <div role="alert" style={{ marginBottom: 16, padding: 14, border: '1px solid #d99b2b', borderRadius: 10, background: 'rgba(217, 155, 43, 0.12)', color: 'var(--text-primary, inherit)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, marginBottom: 8 }}><AlertTriangle size={17} /> Invalid inventory configuration must be removed before affected orders can be created.</div>
        {[...invalidRequirements.map(row => ({ ...row, table: 'service_inventory_requirements', kind: 'Automatic deduction' })), ...invalidAddons.map(row => ({ ...row, table: 'service_addon_items', kind: 'Optional add-on' }))].map(row => <div key={`${row.table}:${row.id}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0' }}>
          <span>{row.kind}: <strong>{row.inventory_name}</strong> — {row.invalid_reason}</span>
          <button type="button" className="btn btn-danger btn-sm" disabled={Boolean(removingConfigId)} onClick={() => removeInvalidConfiguration(row.table, row)}>{removingConfigId === row.id ? 'Removing…' : 'Remove invalid entry'}</button>
        </div>)}
      </div>}
      <InfoNote compact title="Optional add-ons">
        Checking <strong>Offer as add-on</strong> only controls availability. Staff choose the quantity on the order form, up to the branch's available stock.
      </InfoNote>
      <div className="table-wrapper responsive-card-table services-checklist"><table><thead><tr><th>Inventory item</th><th>Available</th><th>Automatic deduction (unit/load)</th><th>Order add-on price</th></tr></thead><tbody>{branchItems.map(item => {
        const recipeOn = Object.hasOwn(recipeDraft, item.id), addonOn = Object.hasOwn(addonDraft, item.id)
        const recipeInvalid = recipeOn && !(Number(recipeDraft[item.id]) > 0)
        const addonInvalid = addonOn && (addonDraft[item.id] === '' || !(Number(addonDraft[item.id]) >= 0))
        const itemUnit = item.unit || 'unit'
        return <tr key={item.id}><td data-card-primary data-label="Inventory item"><strong>{item.name}</strong><div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{item.unit}</div></td><td data-label="Available">{Number(item.current_stock).toLocaleString()} {item.unit}</td>
          <td data-label="Automatic deduction"><label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={recipeOn} onChange={event => toggleChecklistItem('recipe', item, event.target.checked)} /> Deduct automatically ({itemUnit}/load)</label>{recipeOn && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}><input autoComplete="off" className="form-control" style={{ width: 120 }} min="0.0001" step="0.0001" type="number" value={recipeDraft[item.id]} onChange={event => editChecklistValue('recipe', item.id, event.target.value)} placeholder="Quantity" aria-label={`${item.name} quantity in ${itemUnit} deducted per load`} aria-invalid={recipeInvalid || undefined} /><span style={{ color: 'var(--text-muted)', fontSize: 13, whiteSpace: 'nowrap' }}>{itemUnit}/load</span></div>}{recipeInvalid && <span className="checklist-field-error" role="alert">Enter an amount greater than 0. It is not saved yet.</span>}</td>
          <td data-label="Order add-on price"><label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={addonOn} onChange={event => toggleChecklistItem('addon', item, event.target.checked)} /> Offer as add-on</label>{addonOn && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}><div style={{ position: 'relative', width: 120 }}><span aria-hidden="true" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', zIndex: 1 }}>{'\u20B1'}</span><input autoComplete="off" className="form-control" style={{ width: '100%', paddingLeft: 29 }} min="0" step="0.01" type="number" value={addonDraft[item.id]} onChange={event => editChecklistValue('addon', item.id, event.target.value)} placeholder="0.00" aria-label={`${item.name} add-on selling price in Philippine pesos per ${unitName(itemUnit)}`} aria-invalid={addonInvalid || undefined} /></div><span style={{ color: 'var(--text-muted)', fontSize: 13, whiteSpace: 'nowrap' }}>/ {unitName(itemUnit)}</span></div>}{addonInvalid && <span className="checklist-field-error" role="alert">Enter a price of ₱0 or more. It is not saved yet.</span>}</td></tr>
      })}{!branchItems.length && <tr className="empty-state-row"><td colSpan="4" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No inventory items for this branch.</td></tr>}</tbody></table></div>
    </div>
    <SupplyChoiceSettings
      branchId={branchId}
      serviceId={serviceId}
      serviceName={selectedService?.name}
      branchName={branches.find(branch => branch.id === branchId)?.name}
      inventory={inventory}
      requirements={requirements}
      replacements={replacements}
      onRequirementSaved={(id, changes) => setRequirements(list => list.map(row => row.id === id ? { ...row, ...changes } : row))}
      onReplacementsChange={setReplacements}
    />
    <ConfirmDialog
      open={Boolean(supplyToRemove)}
      title={supplyToRemove ? `Stop deducting ${supplyToRemove.item.name}?` : ''}
      message={supplyToRemove ? `${supplyToRemove.item.name} will no longer be a usual supply of ${selectedService?.name || 'this service'}, and its ${supplyToRemove.approved} approved replacement${supplyToRemove.approved === 1 ? '' : 's'} will be removed too.` : ''}
      confirmLabel="Stop deducting"
      onClose={() => setSupplyToRemove(null)}
      onConfirm={confirmSupplyRemoval}
    />
    {showModal && <div className="modal-overlay" onClick={() => !saving && setShowModal(false)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="service-modal-title" style={{ maxWidth: 620 }} onClick={event => event.stopPropagation()}><div className="modal-header"><div><h3 id="service-modal-title">{editing ? 'Edit service' : 'Create service'}</h3><p>Configure the service pricing, included weight, and workflow.</p></div><button className="btn-icon" type="button" aria-label="Close service form" disabled={saving} onClick={() => setShowModal(false)}><X size={20} /></button></div><form onSubmit={saveService}><div className="modal-body">
      <div className="form-group"><label htmlFor="service-name">Service name *</label><input id="service-name" autoComplete="off" className="form-control" required value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></div><div className="form-group"><label htmlFor="service-description">Description</label><textarea id="service-description" autoComplete="off" className="form-control" rows="3" value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))} /></div>
      <div className="form-row"><div className="form-group"><label htmlFor="service-bundle-kg">Kilograms included per load *</label><input id="service-bundle-kg" autoComplete="off" className="form-control" required type="number" min="0.01" step="0.01" value={form.bundle_kg} onChange={event => setForm(current => ({ ...current, bundle_kg: event.target.value }))} /></div><div className="form-group"><label htmlFor="service-bundle-price">Price per load *</label><input id="service-bundle-price" autoComplete="off" className="form-control" required type="number" min="0" step="0.01" value={form.bundle_price} onChange={event => setForm(current => ({ ...current, bundle_price: event.target.value }))} /></div></div>
      <div className="form-row"><div className="form-group"><label htmlFor="service-excess-price">Excess price per kg *</label><input id="service-excess-price" autoComplete="off" className="form-control" required type="number" min="0" step="0.01" value={form.excess_kg_price} onChange={event => setForm(current => ({ ...current, excess_kg_price: event.target.value }))} /></div><div className="form-group"><label htmlFor="service-workflow">Workflow *</label><select id="service-workflow" className="form-control" value={form.processing_type} onChange={event => setForm(current => ({ ...current, processing_type: event.target.value }))}><option value="full_service">Full laundry service</option><option value="air_dry_only">Air-drying only (no washing)</option></select></div></div>
      <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={form.is_active} onChange={event => setForm(current => ({ ...current, is_active: event.target.checked }))} /> Available for new orders</label>
    </div><div className="modal-footer"><button className="btn btn-secondary" type="button" onClick={() => setShowModal(false)}>Cancel</button><LoadingButton className="btn btn-primary" type="submit" loading={saving} loadingLabel="Saving…"><Save size={16} /> Save service</LoadingButton></div></form></div></div>}
    <ConfirmDialog
      open={Boolean(serviceToArchive)}
      title="Archive service?"
      message={serviceToArchive ? `${serviceToArchive.name} will no longer be available for new orders. Existing orders will retain their saved service details.` : ''}
      confirmLabel="Archive service"
      loading={archiving}
      onClose={() => !archiving && setServiceToArchive(null)}
      onConfirm={() => archiveService(serviceToArchive)}
    />
  </div>
}
