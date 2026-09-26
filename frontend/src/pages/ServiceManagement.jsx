import { Plus, Save, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { PageError, PageLoader } from '../components/AsyncState'
import { runQuery } from '../services/api/client'

const blankService = { name: '', description: '', pricing_type: 'per_kg', unit_price: '', processing_type: 'full_service', estimated_minutes: '120', is_active: false }
const blankRecipe = { branch_id: '', service_type_id: '', inventory_item_id: '', usage_basis: 'per_kg', quantity_per_unit: '', is_active: true }

export default function ServiceManagement() {
  const [services, setServices] = useState([])
  const [requirements, setRequirements] = useState([])
  const [branches, setBranches] = useState([])
  const [inventory, setInventory] = useState([])
  const [serviceForm, setServiceForm] = useState(blankService)
  const [recipeForm, setRecipeForm] = useState(blankRecipe)
  const [editing, setEditing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [recipeSetupError, setRecipeSetupError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(''); setRecipeSetupError('')
    const [serviceRes, recipeRes, branchRes, inventoryRes] = await Promise.all([
      runQuery('service_types', { operation: 'select', selection: '*', orders: [{ column: 'name', options: { ascending: true } }] }),
      runQuery('service_inventory_requirements', { operation: 'select', selection: '*' }),
      runQuery('branches', { operation: 'select', selection: 'id, name', orders: [{ column: 'name', options: { ascending: true } }] }),
      runQuery('inventory_items', { operation: 'select', selection: 'id, name, unit, branch_id, branch', orders: [{ column: 'name', options: { ascending: true } }] }),
    ])
    const firstError = [serviceRes, branchRes, inventoryRes].find((result) => result.error)?.error
    if (firstError) setError(firstError.message || 'Unable to load service configuration.')
    else {
      setServices((serviceRes.data || []).map((service) => ({
        ...service,
        // Old deployments do not have the 20260919 columns yet. Defaults
        // keep the existing service list readable while setup is completed.
        pricing_type: service.pricing_type || 'per_kg',
        processing_type: service.processing_type || 'full_service',
        unit_price: service.unit_price ?? service.price_per_kg ?? 0,
      })))
      setRequirements(recipeRes.data || [])
      setBranches(branchRes.data || [])
      setInventory(inventoryRes.data || [])
      if (recipeRes.error) {
        setRecipeSetupError('Inventory recipes are not available yet. Run and deploy supabase_migrations/20260919_multi_service_orders.sql, then reload this page.')
      }
    }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  async function saveService(event) {
    event.preventDefault()
    if (recipeSetupError) return toast.error('Service configuration needs the 20260919 database migration before it can be saved.')
    const payload = { ...serviceForm, unit_price: Number(serviceForm.unit_price) || 0, estimated_minutes: Number(serviceForm.estimated_minutes) || 0 }
    const result = await runQuery('service_types', editing
      ? { operation: 'update', payload, filters: [{ type: 'eq', column: 'id', value: editing.id }], returning: true }
      : { operation: 'insert', payload, returning: true })
    if (result.error) return toast.error(result.error.message)
    toast.success(editing ? 'Service updated.' : 'Service added.')
    setEditing(null); setServiceForm(blankService); load()
  }
  async function removeService(service) {
    if (!confirm(`Archive ${service.name}? It will no longer be available for new orders.`)) return
    const result = await runQuery('service_types', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: service.id }] })
    if (result.error) return toast.error(result.error.message)
    toast.success('Service archived.'); load()
  }
  async function saveRecipe(event) {
    event.preventDefault()
    if (recipeSetupError) return toast.error('Inventory recipes need the 20260919 database migration before they can be saved.')
    const result = await runQuery('service_inventory_requirements', { operation: 'insert', payload: { ...recipeForm, quantity_per_unit: Number(recipeForm.quantity_per_unit) }, returning: true })
    if (result.error) return toast.error(result.error.message)
    toast.success('Inventory requirement saved.'); setRecipeForm(blankRecipe); load()
  }
  async function removeRecipe(id) {
    const result = await runQuery('service_inventory_requirements', { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: id }] })
    if (result.error) return toast.error(result.error.message)
    load()
  }

  if (loading) return <PageLoader label="Loading service configuration…" />
  if (error) return <PageError message={error} onRetry={load} />
  const selectedInventory = inventory.filter((item) => !recipeForm.branch_id || item.branch_id === recipeForm.branch_id)
  const names = new Map(services.map((service) => [service.id, service.name]))
  const itemNames = new Map(inventory.map((item) => [item.id, `${item.name} (${item.unit})`]))
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]))
  return <div className="settings-page">
    <div className="card settings-card" style={{ marginBottom: 18 }}>
      <div className="settings-card-header"><div><h3>Service Management</h3><p>Configure pricing and processing rules. Changes affect new order items only; completed transactions retain their saved price snapshots.</p></div></div>
      <form onSubmit={saveService}>
        <div className="form-row">
          <div className="form-group"><label>Service name *</label><input className="form-control" value={serviceForm.name} required onChange={(e) => setServiceForm((f) => ({ ...f, name: e.target.value }))} /></div>
          <div className="form-group"><label>Pricing type *</label><select className="form-control" value={serviceForm.pricing_type} onChange={(e) => setServiceForm((f) => ({ ...f, pricing_type: e.target.value }))}><option value="bundle">Bundle</option><option value="per_kg">Per kilogram</option><option value="per_piece">Per piece</option><option value="fixed">Fixed price</option></select></div>
          {serviceForm.pricing_type !== 'bundle' && <div className="form-group"><label>Unit price (₱) *</label><input className="form-control" type="number" min="0" step="0.01" value={serviceForm.unit_price} required onChange={(e) => setServiceForm((f) => ({ ...f, unit_price: e.target.value }))} /></div>}
          <div className="form-group"><label>Processing</label><select className="form-control" value={serviceForm.processing_type} onChange={(e) => setServiceForm((f) => ({ ...f, processing_type: e.target.value }))}><option value="full_service">Full service</option><option value="air_dry_only">Air-dry only</option></select></div>
        </div>
        <div className="form-row"><div className="form-group"><label>Estimated minutes</label><input className="form-control" type="number" min="1" value={serviceForm.estimated_minutes} onChange={(e) => setServiceForm((f) => ({ ...f, estimated_minutes: e.target.value }))} /></div><div className="form-group"><label>Description</label><input className="form-control" value={serviceForm.description} onChange={(e) => setServiceForm((f) => ({ ...f, description: e.target.value }))} /></div></div>
        <label style={{ display: 'block', marginBottom: 12 }}><input type="checkbox" checked={serviceForm.is_active} onChange={(e) => setServiceForm((f) => ({ ...f, is_active: e.target.checked }))} /> Available for new orders</label>
        <button className="btn btn-primary" type="submit"><Save size={16} /> {editing ? 'Update service' : 'Add service'}</button>{editing && <button className="btn btn-secondary" type="button" style={{ marginLeft: 8 }} onClick={() => { setEditing(null); setServiceForm(blankService) }}>Cancel</button>}
      </form>
      <div className="table-wrapper" style={{ marginTop: 18 }}><table><thead><tr><th>Service</th><th>Pricing</th><th>Processing</th><th>Status</th><th /></tr></thead><tbody>{services.map((service) => <tr key={service.id}><td>{service.name}</td><td>{service.pricing_type === 'bundle' ? 'Bundle settings' : `${service.pricing_type.replace('_', ' ')} · ₱${Number(service.unit_price || 0).toLocaleString()}`}</td><td>{service.processing_type === 'air_dry_only' ? 'Air-dry only' : 'Full service'}</td><td>{service.is_active ? 'Active' : 'Inactive'}</td><td><button className="btn btn-secondary btn-sm" onClick={() => { setEditing(service); setServiceForm({ ...service, unit_price: service.unit_price ?? '', estimated_minutes: service.estimated_minutes ?? 120 }) }}>Edit</button> <button className="btn btn-danger btn-sm" onClick={() => removeService(service)}><Trash2 size={14} /></button></td></tr>)}</tbody></table></div>
    </div>
    <div className="card settings-card">
      <div className="settings-card-header"><div><h3>Service Inventory Requirements</h3><p>Choose which branch stock is consumed when a service item starts processing. No quantity is deducted when the order is merely received.</p></div></div>
      {recipeSetupError && <div className="alert alert-warning" role="status">{recipeSetupError}</div>}
      <form onSubmit={saveRecipe}><div className="form-row"><div className="form-group"><label>Branch *</label><select className="form-control" required value={recipeForm.branch_id} onChange={(e) => setRecipeForm((f) => ({ ...f, branch_id: e.target.value, inventory_item_id: '' }))}><option value="">Select branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div><div className="form-group"><label>Service *</label><select className="form-control" required value={recipeForm.service_type_id} onChange={(e) => setRecipeForm((f) => ({ ...f, service_type_id: e.target.value }))}><option value="">Select service</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></div><div className="form-group"><label>Inventory item *</label><select className="form-control" required value={recipeForm.inventory_item_id} onChange={(e) => setRecipeForm((f) => ({ ...f, inventory_item_id: e.target.value }))}><option value="">Select item</option>{selectedInventory.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}</select></div></div><div className="form-row"><div className="form-group"><label>Usage basis *</label><select className="form-control" value={recipeForm.usage_basis} onChange={(e) => setRecipeForm((f) => ({ ...f, usage_basis: e.target.value }))}><option value="per_kg">Per kilogram</option><option value="per_piece">Per piece</option><option value="per_order">Per order</option></select></div><div className="form-group"><label>Quantity per unit *</label><input className="form-control" required min="0.0001" step="0.0001" type="number" value={recipeForm.quantity_per_unit} onChange={(e) => setRecipeForm((f) => ({ ...f, quantity_per_unit: e.target.value }))} /></div></div><button className="btn btn-primary" type="submit"><Plus size={16} /> Add requirement</button></form>
      <div className="table-wrapper" style={{ marginTop: 18 }}><table><thead><tr><th>Branch</th><th>Service</th><th>Inventory item</th><th>Formula</th><th /></tr></thead><tbody>{requirements.map((requirement) => <tr key={requirement.id}><td>{branchNames.get(requirement.branch_id) || 'Branch'}</td><td>{names.get(requirement.service_type_id) || 'Service'}</td><td>{itemNames.get(requirement.inventory_item_id) || 'Item'}</td><td>{Number(requirement.quantity_per_unit)} × {requirement.usage_basis.replace('_', ' ')}</td><td><button className="btn btn-danger btn-sm" onClick={() => removeRecipe(requirement.id)}><Trash2 size={14} /></button></td></tr>)}</tbody></table></div>
    </div>
  </div>
}
