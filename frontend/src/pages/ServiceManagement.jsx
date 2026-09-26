import { Edit2, Plus, Save, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { PageError, PageLoader } from '../components/AsyncState'
import LoadingButton from '../components/LoadingButton'
import { runQuery } from '../services/api/client'

const blankService = { name: '', description: '', processing_type: 'full_service', is_active: true }
const blankRecipe = { branch_id: '', service_type_id: '', inventory_item_id: '', quantity_per_unit: '', is_active: true }

export default function ServiceManagement() {
  const [services, setServices] = useState([])
  const [requirements, setRequirements] = useState([])
  const [branches, setBranches] = useState([])
  const [inventory, setInventory] = useState([])
  const [serviceForm, setServiceForm] = useState(blankService)
  const [recipeForm, setRecipeForm] = useState(blankRecipe)
  const [editingService, setEditingService] = useState(null)
  const [editingRecipe, setEditingRecipe] = useState(null)
  const [showServiceModal, setShowServiceModal] = useState(false)
  const [savingService, setSavingService] = useState(false)
  const [savingRecipe, setSavingRecipe] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const [serviceRes, recipeRes, branchRes, inventoryRes] = await Promise.all([
      runQuery('service_types', { operation: 'select', selection: '*', orders: [{ column: 'name', options: { ascending: true } }] }),
      runQuery('service_inventory_requirements', { operation: 'select', selection: '*' }),
      runQuery('branches', { operation: 'select', selection: 'id, name', orders: [{ column: 'name', options: { ascending: true } }] }),
      runQuery('inventory_items', { operation: 'select', selection: 'id, name, unit, branch_id, branch', orders: [{ column: 'name', options: { ascending: true } }] }),
    ])
    const firstError = [serviceRes, recipeRes, branchRes, inventoryRes].find((result) => result.error)?.error
    if (firstError) setError(firstError.message || 'Unable to load service configuration.')
    else { setServices(serviceRes.data || []); setRequirements(recipeRes.data || []); setBranches(branchRes.data || []); setInventory(inventoryRes.data || []) }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  function openNewService() { setEditingService(null); setServiceForm(blankService); setShowServiceModal(true) }
  function openEditService(service) {
    setEditingService(service)
    setServiceForm({ name: service.name || '', description: service.description || '', processing_type: service.processing_type || 'full_service', is_active: service.is_active !== false })
    setShowServiceModal(true)
  }
  async function saveService(event) {
    event.preventDefault(); if (savingService) return
    setSavingService(true)
    const payload = { ...serviceForm, pricing_type: 'bundle', unit_price: 0, estimated_minutes: 120 }
    const result = await runQuery('service_types', editingService
      ? { operation: 'update', payload, filters: [{ type: 'eq', column: 'id', value: editingService.id }], returning: true }
      : { operation: 'insert', payload, returning: true })
    setSavingService(false)
    if (result.error) return toast.error(result.error.message)
    toast.success(editingService ? 'Service updated.' : 'Service added.')
    setShowServiceModal(false); setEditingService(null); setServiceForm(blankService); load()
  }
  async function removeService(service) {
    if (!confirm(`Archive ${service.name}? It will no longer be available for new orders.`)) return
    const result = await runQuery('service_types', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: service.id }] })
    if (result.error) return toast.error(result.error.message)
    toast.success('Service archived.'); load()
  }
  async function saveRecipe(event) {
    event.preventDefault(); if (savingRecipe) return
    setSavingRecipe(true)
    const payload = { ...recipeForm, usage_basis: 'per_order', quantity_per_unit: Number(recipeForm.quantity_per_unit) }
    const result = await runQuery('service_inventory_requirements', editingRecipe
      ? { operation: 'update', payload, filters: [{ type: 'eq', column: 'id', value: editingRecipe.id }], returning: true }
      : { operation: 'insert', payload, returning: true })
    setSavingRecipe(false)
    if (result.error) return toast.error(result.error.message)
    toast.success(editingRecipe ? 'Automatic deduction updated.' : 'Automatic deduction added.')
    setEditingRecipe(null); setRecipeForm(blankRecipe); load()
  }
  async function removeRecipe(id) {
    const result = await runQuery('service_inventory_requirements', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: id }] })
    if (result.error) return toast.error(result.error.message)
    toast.success('Automatic deduction removed.'); load()
  }

  if (loading) return <PageLoader label="Loading service configuration…" />
  if (error) return <PageError message={error} onRetry={load} />
  const selectedInventory = inventory.filter((item) => !recipeForm.branch_id || item.branch_id === recipeForm.branch_id)
  const serviceNames = new Map(services.map((service) => [service.id, service.name]))
  const itemNames = new Map(inventory.map((item) => [item.id, `${item.name} (${item.unit})`]))
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]))

  return <div className="settings-page">
    <div className="card settings-card" style={{ marginBottom: 18 }}>
      <div className="settings-card-header"><div><h3>Services</h3><p>All services use the bundle, excess-kilogram, and add-on prices configured in Settings. Configure each service’s workflow and automatic inventory deductions here.</p></div><button className="btn btn-primary" onClick={openNewService}><Plus size={16} /> Add service</button></div>
      <div className="table-wrapper"><table><thead><tr><th>Service</th><th>Price rule</th><th>Processing</th><th>Status</th><th /></tr></thead><tbody>{services.map((service) => <tr key={service.id}><td><strong>{service.name}</strong>{service.description && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{service.description}</div>}</td><td>Settings bundle pricing</td><td>{service.processing_type === 'air_dry_only' ? 'Air-dry only' : 'Full service'}</td><td>{service.is_active ? 'Active' : 'Inactive'}</td><td><button className="btn btn-secondary btn-sm" onClick={() => openEditService(service)}><Edit2 size={14} /> Edit</button> <button className="btn btn-danger btn-sm" onClick={() => removeService(service)}><Trash2 size={14} /></button></td></tr>)}</tbody></table></div>
    </div>

    <div className="card settings-card">
      <div className="settings-card-header"><div><h3>Automatic inventory deductions</h3><p>Choose an inventory item for a service and set the amount deducted once when that service item starts processing. The selected stock must belong to the same branch.</p></div></div>
      <form onSubmit={saveRecipe}><div className="form-row"><div className="form-group"><label>Branch *</label><select className="form-control" required value={recipeForm.branch_id} onChange={(e) => setRecipeForm((f) => ({ ...f, branch_id: e.target.value, inventory_item_id: '' }))}><option value="">Select branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div><div className="form-group"><label>Service *</label><select className="form-control" required value={recipeForm.service_type_id} onChange={(e) => setRecipeForm((f) => ({ ...f, service_type_id: e.target.value }))}><option value="">Select service</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></div><div className="form-group"><label>Inventory item *</label><select className="form-control" required value={recipeForm.inventory_item_id} onChange={(e) => setRecipeForm((f) => ({ ...f, inventory_item_id: e.target.value }))}><option value="">Select item</option>{selectedInventory.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}</select></div></div><div className="form-row"><div className="form-group"><label>Amount to deduct per service item *</label><input className="form-control" required min="0.0001" step="0.0001" type="number" value={recipeForm.quantity_per_unit} onChange={(e) => setRecipeForm((f) => ({ ...f, quantity_per_unit: e.target.value }))} /></div></div><LoadingButton className="btn btn-primary" type="submit" loading={savingRecipe} loadingLabel="Saving…"><Save size={16} /> {editingRecipe ? 'Update deduction' : 'Add deduction'}</LoadingButton>{editingRecipe && <button className="btn btn-secondary" type="button" style={{ marginLeft: 8 }} onClick={() => { setEditingRecipe(null); setRecipeForm(blankRecipe) }}>Cancel</button>}</form>
      <div className="table-wrapper" style={{ marginTop: 18 }}><table><thead><tr><th>Branch</th><th>Service</th><th>Inventory item</th><th>Amount</th><th /></tr></thead><tbody>{requirements.map((requirement) => <tr key={requirement.id}><td>{branchNames.get(requirement.branch_id) || 'Branch'}</td><td>{serviceNames.get(requirement.service_type_id) || 'Service'}</td><td>{itemNames.get(requirement.inventory_item_id) || 'Item'}</td><td>{Number(requirement.quantity_per_unit)} per service item</td><td><button className="btn btn-secondary btn-sm" onClick={() => { setEditingRecipe(requirement); setRecipeForm({ branch_id: requirement.branch_id, service_type_id: requirement.service_type_id, inventory_item_id: requirement.inventory_item_id, quantity_per_unit: requirement.quantity_per_unit, is_active: requirement.is_active }) }}><Edit2 size={14} /> Edit</button> <button className="btn btn-danger btn-sm" onClick={() => removeRecipe(requirement.id)}><Trash2 size={14} /></button></td></tr>)}</tbody></table></div>
    </div>

    {showServiceModal && <div className="modal-overlay" onClick={() => !savingService && setShowServiceModal(false)}><div className="modal" style={{ maxWidth: 560 }} onClick={(event) => event.stopPropagation()}><div className="modal-header"><h3>{editingService ? 'Edit service' : 'Add service'}</h3><button className="btn-icon" disabled={savingService} onClick={() => setShowServiceModal(false)}><X size={20} /></button></div><form onSubmit={saveService}><div className="modal-body"><div className="form-group"><label>Service name *</label><input className="form-control" required value={serviceForm.name} onChange={(event) => setServiceForm((form) => ({ ...form, name: event.target.value }))} /></div><div className="form-group"><label>Description</label><textarea className="form-control" rows="3" value={serviceForm.description} onChange={(event) => setServiceForm((form) => ({ ...form, description: event.target.value }))} /></div><div className="form-group"><label>Processing method</label><select className="form-control" value={serviceForm.processing_type} onChange={(event) => setServiceForm((form) => ({ ...form, processing_type: event.target.value }))}><option value="full_service">Full service</option><option value="air_dry_only">Air-dry only</option></select></div><label style={{ display: 'block' }}><input type="checkbox" checked={serviceForm.is_active} onChange={(event) => setServiceForm((form) => ({ ...form, is_active: event.target.checked }))} /> Available for new orders</label><p className="form-hint" style={{ marginTop: 12 }}>The price uses the bundle, excess-kilogram, and add-on settings shared by all services.</p></div><div className="modal-footer"><button className="btn btn-secondary" type="button" disabled={savingService} onClick={() => setShowServiceModal(false)}>Cancel</button><LoadingButton className="btn btn-primary" type="submit" loading={savingService} loadingLabel="Saving…"><Save size={16} /> Save service</LoadingButton></div></form></div></div>}
  </div>
}
