import { Edit2, PackageCheck, Plus, Save, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { PageError, PageLoader } from '../components/AsyncState'
import LoadingButton from '../components/LoadingButton'
import { runQuery } from '../services/api/client'

const blankService = { name: '', description: '', bundle_kg: 8, bundle_price: '', excess_kg_price: '', processing_type: 'full_service', is_active: true }

export default function ServiceManagement() {
  const [services, setServices] = useState([]), [branches, setBranches] = useState([])
  const [inventory, setInventory] = useState([]), [requirements, setRequirements] = useState([]), [addons, setAddons] = useState([])
  const [branchId, setBranchId] = useState(''), [serviceId, setServiceId] = useState('')
  const [recipeDraft, setRecipeDraft] = useState({}), [addonDraft, setAddonDraft] = useState({})
  const [form, setForm] = useState(blankService), [editing, setEditing] = useState(null), [showModal, setShowModal] = useState(false)
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [savingConfig, setSavingConfig] = useState(false), [error, setError] = useState('')

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true); setError('')
    const results = await Promise.all([
      runQuery('service_types', { operation: 'select', selection: '*', orders: [{ column: 'name', options: { ascending: true } }] }),
      runQuery('branches', { operation: 'select', selection: 'id, name', orders: [{ column: 'name', options: { ascending: true } }] }),
      runQuery('inventory_items', { operation: 'select', selection: 'id, name, unit, current_stock, branch_id', orders: [{ column: 'name', options: { ascending: true } }] }),
      runQuery('service_inventory_requirements', { operation: 'select', selection: '*' }),
      runQuery('service_addon_items', { operation: 'select', selection: '*' }),
    ])
    const failed = results.find(result => result.error)
    if (failed) setError(failed.error?.message || 'Unable to load service configuration.')
    else {
      setServices(results[0].data || []); setBranches(results[1].data || []); setInventory(results[2].data || [])
      setRequirements(results[3].data || []); setAddons(results[4].data || [])
      setBranchId(current => current || results[1].data?.[0]?.id || '')
      setServiceId(current => current || results[0].data?.[0]?.id || '')
    }
    if (!background) setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const recipes = requirements.filter(row => row.branch_id === branchId && row.service_type_id === serviceId)
    const options = addons.filter(row => row.branch_id === branchId && row.service_type_id === serviceId)
    setRecipeDraft(Object.fromEntries(recipes.map(row => [row.inventory_item_id, String(row.quantity_per_load)])))
    setAddonDraft(Object.fromEntries(options.map(row => [row.inventory_item_id, String(row.unit_price)])))
  }, [branchId, serviceId, requirements, addons])

  const branchItems = useMemo(() => inventory.filter(item => item.branch_id === branchId), [inventory, branchId])
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
    if (!confirm(`Archive ${service.name}? Existing orders will retain their saved details.`)) return
    const result = await runQuery('service_types', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: service.id }] })
    if (result.error) return toast.error(result.error.message)
    toast.success('Service archived.'); await load(true)
  }
  async function sync(table, existingRows, draft, column) {
    for (const item of branchItems) {
      const existing = existingRows.find(row => row.inventory_item_id === item.id)
      const value = Number(draft[item.id])
      const checked = Object.hasOwn(draft, item.id)
      const enabled = checked && Number.isFinite(value) && (column === 'quantity_per_load' ? value > 0 : value >= 0)
      const base = { branch_id: branchId, service_type_id: serviceId, inventory_item_id: item.id, [column]: value, is_active: true }
      const request = enabled && existing
        ? { operation: 'update', payload: { [column]: value, is_active: true }, filters: [{ type: 'eq', column: 'id', value: existing.id }], returning: true }
        : enabled ? { operation: 'insert', payload: base, returning: true }
          : existing ? { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: existing.id }] } : null
      if (request) { const result = await runQuery(table, request); if (result.error) throw result.error }
    }
  }
  async function saveConfiguration() {
    if (!branchId || !serviceId || savingConfig) return; setSavingConfig(true)
    try {
      await sync('service_inventory_requirements', requirements.filter(row => row.branch_id === branchId && row.service_type_id === serviceId), recipeDraft, 'quantity_per_load')
      await sync('service_addon_items', addons.filter(row => row.branch_id === branchId && row.service_type_id === serviceId), addonDraft, 'unit_price')
      toast.success('Inventory checklist saved.'); await load(true)
    } catch (saveError) { toast.error(saveError.message || 'Unable to save configuration.') }
    finally { setSavingConfig(false) }
  }
  function toggleDraft(setter, id, checked, initial) { setter(current => { const next = { ...current }; if (checked) next[id] = next[id] || initial; else delete next[id]; return next }) }

  if (loading) return <PageLoader label="Loading service configuration…" />
  if (error) return <PageError message={error} onRetry={load} />
  return <div className="settings-page">
    <div className="card settings-card" style={{ marginBottom: 18 }}>
      <div className="settings-card-header"><div><h3>Services and pricing</h3><p>Every service uses per-load pricing. Configure its included kilograms, load price, excess rate, and workflow.</p></div><button className="btn btn-primary" onClick={() => openService()}><Plus size={16} /> Add service</button></div>
      <div className="table-wrapper"><table><thead><tr><th>Service</th><th>Load price</th><th>Excess</th><th>Workflow</th><th>Status</th><th /></tr></thead><tbody>{services.map(service => <tr key={service.id}>
        <td><strong>{service.name}</strong>{service.description && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{service.description}</div>}</td>
        <td>₱{Number(service.bundle_price || 0).toLocaleString()} / {Number(service.bundle_kg || 0)} kg</td><td>₱{Number(service.excess_kg_price || 0).toLocaleString()} / kg</td>
        <td>{service.processing_type === 'air_dry_only' ? 'Air-drying only · no washing' : 'Full laundry service'}</td><td>{service.is_active ? 'Active' : 'Inactive'}</td>
        <td><button className="btn btn-secondary btn-sm" onClick={() => openService(service)}><Edit2 size={14} /> Edit</button> <button className="btn btn-danger btn-sm" onClick={() => archiveService(service)}><Trash2 size={14} /></button></td>
      </tr>)}</tbody></table></div>
    </div>
    <div className="card settings-card">
      <div className="settings-card-header"><div><h3>Branch inventory checklist</h3><p>Choose stock consumed per load and which inventory items staff may add to orders for this service.</p></div></div>
      <div className="form-row"><div className="form-group"><label>Branch</label><select className="form-control" value={branchId} onChange={event => setBranchId(event.target.value)}>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div><div className="form-group"><label>Service</label><select className="form-control" value={serviceId} onChange={event => setServiceId(event.target.value)}>{services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}</select></div></div>
      {selectedService && <div className="pricing-card" style={{ marginBottom: 16 }}><PackageCheck size={18} /> <strong>{selectedService.name}</strong> · item quantities are multiplied by the calculated loads.</div>}
      <p className="form-hint" style={{ margin: '0 0 14px' }}>Checking <strong>Offer as add-on</strong> only controls availability. Staff choose the quantity on the order form, up to the branch's available stock.</p>
      <div className="table-wrapper"><table><thead><tr><th>Inventory item</th><th>Available</th><th>Automatic deduction per load</th><th>Order add-on price</th></tr></thead><tbody>{branchItems.map(item => {
        const recipeOn = Object.hasOwn(recipeDraft, item.id), addonOn = Object.hasOwn(addonDraft, item.id)
        const itemUnit = item.unit || 'unit'
        return <tr key={item.id}><td><strong>{item.name}</strong><div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{item.unit}</div></td><td>{Number(item.current_stock).toLocaleString()} {item.unit}</td>
          <td><label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={recipeOn} onChange={event => toggleDraft(setRecipeDraft, item.id, event.target.checked, '1')} /> Deduct automatically</label>{recipeOn && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}><input className="form-control" style={{ width: 120 }} min="0.0001" step="0.0001" type="number" value={recipeDraft[item.id]} onChange={event => setRecipeDraft(current => ({ ...current, [item.id]: event.target.value }))} placeholder="Quantity" aria-label={`${item.name} quantity in ${itemUnit} deducted per load`} /><span style={{ color: 'var(--text-muted)', fontSize: 13, whiteSpace: 'nowrap' }}>{itemUnit} / load</span></div>}</td>
          <td><label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={addonOn} onChange={event => toggleDraft(setAddonDraft, item.id, event.target.checked, '1')} /> Offer as add-on</label>{addonOn && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}><div style={{ position: 'relative', width: 120 }}><span aria-hidden="true" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', zIndex: 1 }}>{'\u20B1'}</span><input className="form-control" style={{ width: '100%', paddingLeft: 29 }} min="0" step="0.01" type="number" value={addonDraft[item.id]} onChange={event => setAddonDraft(current => ({ ...current, [item.id]: event.target.value }))} placeholder="0.00" aria-label={`${item.name} add-on selling price in Philippine pesos per ${itemUnit}`} /></div><span style={{ color: 'var(--text-muted)', fontSize: 13, whiteSpace: 'nowrap' }}>/ {itemUnit}</span></div>}</td></tr>
      })}{!branchItems.length && <tr><td colSpan="4" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No inventory items for this branch.</td></tr>}</tbody></table></div>
      <div style={{ marginTop: 16 }}><LoadingButton className="btn btn-primary" onClick={saveConfiguration} loading={savingConfig} loadingLabel="Saving…"><Save size={16} /> Save inventory checklist</LoadingButton></div>
    </div>
    {showModal && <div className="modal-overlay" onClick={() => !saving && setShowModal(false)}><div className="modal" style={{ maxWidth: 620 }} onClick={event => event.stopPropagation()}><div className="modal-header"><div><h3>{editing ? 'Edit service' : 'Create service'}</h3><p style={{ margin: '4px 0 0', color: 'var(--text-muted)' }}>Configure pricing and processing.</p></div><button className="btn-icon" onClick={() => setShowModal(false)}><X size={20} /></button></div><form onSubmit={saveService}><div className="modal-body">
      <div className="form-group"><label>Service name *</label><input className="form-control" required value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></div><div className="form-group"><label>Description</label><textarea className="form-control" rows="3" value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))} /></div>
      <div className="form-row"><div className="form-group"><label>Kilograms included per load *</label><input className="form-control" required type="number" min="0.01" step="0.01" value={form.bundle_kg} onChange={event => setForm(current => ({ ...current, bundle_kg: event.target.value }))} /></div><div className="form-group"><label>Price per load *</label><input className="form-control" required type="number" min="0" step="0.01" value={form.bundle_price} onChange={event => setForm(current => ({ ...current, bundle_price: event.target.value }))} /></div></div>
      <div className="form-row"><div className="form-group"><label>Excess price per kg *</label><input className="form-control" required type="number" min="0" step="0.01" value={form.excess_kg_price} onChange={event => setForm(current => ({ ...current, excess_kg_price: event.target.value }))} /></div><div className="form-group"><label>Workflow *</label><select className="form-control" value={form.processing_type} onChange={event => setForm(current => ({ ...current, processing_type: event.target.value }))}><option value="full_service">Full laundry service</option><option value="air_dry_only">Air-drying only (no washing)</option></select></div></div>
      <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={form.is_active} onChange={event => setForm(current => ({ ...current, is_active: event.target.checked }))} /> Available for new orders</label>
    </div><div className="modal-footer"><button className="btn btn-secondary" type="button" onClick={() => setShowModal(false)}>Cancel</button><LoadingButton className="btn btn-primary" type="submit" loading={saving} loadingLabel="Saving…"><Save size={16} /> Save service</LoadingButton></div></form></div></div>}
  </div>
}
