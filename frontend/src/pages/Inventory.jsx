import { differenceInDays, format } from "date-fns";
import {
  AlertTriangle,
  Edit2,
  Package,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TrendingDown,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";
import { useRealtime } from "../lib/useRealtime";
import { restockBranchInventory } from "../services/api/operationsApi";
import { PageError, PageLoader } from "../components/AsyncState";
import ConfirmDialog from "../components/ConfirmDialog";
import LoadingButton from "../components/LoadingButton";

const BRANCHES = [
  "Main - Brgy 7",
  "2nd Branch - Brgy Calzada",
  "3rd Branch - Nasugbu",
];
export default function Inventory() {
  const { role, branch } = useAuth();
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [usageLogs, setUsageLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [showRestock, setShowRestock] = useState(null);
  const [itemToDelete, setItemToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [restocking, setRestocking] = useState(false);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState(
    role === "staff" ? branch : "all",
  );
  const [restockQty, setRestockQty] = useState("");
  const [restockCost, setRestockCost] = useState("");
  const [restockSupplier, setRestockSupplier] = useState("");

  const [form, setForm] = useState({
    name: "",
    category_id: "",
    branch: "Main - Brgy 7",
    unit: "pcs",
    current_stock: "",
    minimum_stock: "",
    cost_per_unit: "",
  });

  const loadData = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true);
      setLoadError("");
    }
    try {
      const [itemsRes, catRes, usageRes] = await Promise.all([
        supabase.from("inventory_items").select("*, inventory_categories(name)").order("name"),
        supabase.from("inventory_categories").select("*").order("name"),
        supabase.from("inventory_usage_log").select("*").order("logged_at", { ascending: false }).limit(500),
      ]);
      const error = itemsRes.error || catRes.error || usageRes.error;
      if (error) throw error;
      setItems(itemsRes.data || []);
      setCategories(catRes.data || []);
      setUsageLogs(usageRes.data || []);
    } catch (error) {
      if (!background) setLoadError(error.message || "Unable to load inventory data.");
      else console.error("Background inventory refresh failed:", error);
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Realtime: refresh when inventory changes
  useRealtime(
    [
      "inventory_items",
      "inventory_categories",
      "inventory_usage_log",
      "inventory_restocks",
    ],
    () => loadData(true),
  );

  // ===== STOCK PREDICTION =====
  function predictDaysLeft(item) {
    const itemLogs = usageLogs.filter((l) => l.item_id === item.id);
    if (itemLogs.length >= 2) {
      const sortedLogs = [...itemLogs].sort(
        (a, b) => new Date(a.logged_at) - new Date(b.logged_at),
      );
      const firstLog = new Date(sortedLogs[0].logged_at);
      const lastLog = new Date(sortedLogs[sortedLogs.length - 1].logged_at);
      const daysDiff = Math.max(differenceInDays(lastLog, firstLog), 1);
      const totalUsed = itemLogs.reduce(
        (sum, l) => sum + Number(l.quantity_used),
        0,
      );
      const dailyUsage = totalUsed / daysDiff;

      if (dailyUsage > 0)
        return Math.floor(Number(item.current_stock) / dailyUsage);
    }

    return null;
  }

  function openNew() {
    setEditing(null);
    setForm({
      name: "",
      category_id: "",
      branch: role === "staff" ? branch : "Main - Brgy 7",
      unit: "pcs",
      current_stock: "",
      minimum_stock: "",
      cost_per_unit: "",
    });
    setShowModal(true);
  }

  function openEdit(item) {
    setEditing(item);
    setForm({
      name: item.name,
      category_id: item.category_id || "",
      branch: item.branch || "Main - Brgy 7",
      unit: item.unit,
      current_stock: item.current_stock,
      minimum_stock: item.minimum_stock,
      cost_per_unit: item.cost_per_unit,
    });
    setShowModal(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (savingItem) return;
    const payload = {
      ...form,
      current_stock: parseFloat(form.current_stock) || 0,
      minimum_stock: parseFloat(form.minimum_stock) || 0,
      cost_per_unit: parseFloat(form.cost_per_unit) || 0,
      category_id: form.category_id || null,
    };

    setSavingItem(true);
    let error;
    if (editing) {
      ({ error } = await supabase
        .from("inventory_items")
        .update(payload)
        .eq("id", editing.id));
    } else {
      ({ error } = await supabase.from("inventory_items").insert(payload));

      // Auto-create expense for initial stock cost
      const stock = parseFloat(form.current_stock) || 0;
      const costPerUnit = parseFloat(form.cost_per_unit) || 0;
      if (!error && stock > 0 && costPerUnit > 0) {
        await supabase.from("expenses").insert({
          category: "inventory",
          description: `New item: ${form.name} (${stock} ${form.unit} × ₱${costPerUnit})`,
          amount: stock * costPerUnit,
          expense_date: format(new Date(), "yyyy-MM-dd"),
          ...(role === "admin" ? { branch: form.branch } : {}),
        });
      }
    }
    if (error) {
      setSavingItem(false);
      return toast.error(error.message);
    }
    toast.success(editing ? "Item updated!" : "Item added!");
    setShowModal(false);
    await loadData(true);
    setSavingItem(false);
  }

  async function handleRestock(e) {
    e.preventDefault();
    if (restocking) return;
    const qty = parseFloat(restockQty);
    if (!qty || qty <= 0) return toast.error("Enter a valid quantity");

    setRestocking(true);
    try {
      await restockBranchInventory({
        itemId: showRestock.id,
        quantity: qty,
        costTotal: parseFloat(restockCost) || null,
        supplier: restockSupplier || null,
      });
    } catch (error) {
      toast.error(error.message);
      setRestocking(false);
      return;
    }

    toast.success("Stock restocked!");
    setShowRestock(null);
    setRestockQty("");
    setRestockCost("");
    setRestockSupplier("");
    await loadData(true);
    setRestocking(false);
  }

  async function deleteItem() {
    if (!itemToDelete || deleting) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("inventory_items")
        .delete()
        .eq("id", itemToDelete.id);
      if (error) throw error;
      toast.success("Item archived");
      setItemToDelete(null);
      loadData(true);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDeleting(false);
    }
  }

  const filtered = items.filter((i) => {
    // SEARCH FILTER
    const matchesSearch =
      !search || i.name.toLowerCase().includes(search.toLowerCase());

    // BRANCH FILTER
    const matchesBranch =
      role === "staff"
        ? i.branch === branch
        : branchFilter === "all" || i.branch === branchFilter;

    return matchesSearch && matchesBranch;
  });

  if (loading) return <PageLoader label="Loading inventory…" />;
  if (loadError) return <PageError message={loadError} onRetry={loadData} />;

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 20,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {/* SEARCH */}
          <div className="search-box">
            <Search />

            <input
              placeholder="Search items..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* ADMIN ONLY BRANCH FILTER */}
          {role === "admin" && (
            <select
              className="form-control"
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              style={{
                width: 240,
              }}
            >
              <option value="all">All Branches</option>

              {BRANCHES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}
        </div>

        <button className="btn btn-primary" onClick={openNew}>
          <Plus size={18} />
          Add Item
        </button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                {role === "admin" && <th>Branch</th>}
                <th>Stock</th>
                <th>Min Level</th>
                <th>Status</th>
                <th>Forecast</th>
                <th>Cost/Unit</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={role === "admin" ? 8 : 7} className="empty-state">
                    <p>No items found</p>
                  </td>
                </tr>
              ) : (
                filtered.map((item) => {
                  const isLow =
                    Number(item.current_stock) <= Number(item.minimum_stock);
                  const pct =
                    Number(item.minimum_stock) > 0
                      ? Math.min(
                          (Number(item.current_stock) /
                            (Number(item.minimum_stock) * 3)) *
                            100,
                          100,
                        )
                      : 100;
                  const daysLeft = predictDaysLeft(item);
                  let forecastColor = "var(--success)";
                  if (daysLeft !== null) {
                    if (daysLeft <= 3) forecastColor = "var(--danger)";
                    else if (daysLeft <= 7) forecastColor = "var(--warning)";
                  }
                  return (
                    <tr key={item.id}>
                      <td
                        style={{
                          fontWeight: 600,
                          color: "var(--text-primary)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <Package
                            size={16}
                            style={{ color: "var(--text-muted)" }}
                          />
                          {item.name}
                        </div>
                      </td>
                      {role === "admin" && (
                      <td>
                        <span className="badge badge-ok">
                          {item.branch || "—"}
                        </span>
                      </td>
                      )}

                      <td>
                        <div>
                          <span
                            style={{
                              fontWeight: 600,
                              color: "var(--text-primary)",
                            }}
                          >
                            {item.current_stock}
                          </span>
                          <span style={{ color: "var(--text-muted)" }}>
                            {" "}
                            {item.unit}
                          </span>
                        </div>
                        <div
                          className="progress-bar-container"
                          style={{ marginTop: 4, width: 80 }}
                        >
                          <div
                            className="progress-bar-fill"
                            style={{
                              width: `${pct}%`,
                              background: isLow
                                ? "var(--danger)"
                                : pct < 40
                                  ? "var(--warning)"
                                  : "var(--success)",
                            }}
                          />
                        </div>
                      </td>
                      <td>
                        {item.minimum_stock} {item.unit}
                      </td>
                      <td>
                        {isLow ? (
                          <span className="badge badge-low">
                            <AlertTriangle
                              size={12}
                              style={{ marginRight: 4 }}
                            />{" "}
                            Low
                          </span>
                        ) : (
                          <span className="badge badge-ok">OK</span>
                        )}
                      </td>
                      <td>
                        {daysLeft !== null ? (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <TrendingDown
                              size={14}
                              style={{ color: forecastColor }}
                            />
                            <span
                              style={{
                                fontWeight: 600,
                                color: forecastColor,
                                fontSize: 13,
                              }}
                            >
                              {daysLeft}d
                            </span>
                            <span
                              style={{
                                color: "var(--text-muted)",
                                fontSize: 12,
                              }}
                            >
                              left
                            </span>
                          </div>
                        ) : (
                          <span
                            style={{ color: "var(--text-muted)", fontSize: 12 }}
                          >
                            No data
                          </span>
                        )}
                      </td>
                      <td>₱{Number(item.cost_per_unit).toLocaleString()}</td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            className="btn-icon"
                            title="Restock"
                            onClick={() => {
                              setShowRestock(item);
                              setRestockQty("");
                              setRestockCost("");
                              setRestockSupplier("");
                            }}
                          >
                            <RefreshCw size={16} />
                          </button>
                          <button
                            className="btn-icon"
                            onClick={() => openEdit(item)}
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            className="btn-icon"
                            onClick={() => setItemToDelete(item)}
                            style={{ color: "var(--danger)" }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Item Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing ? "Edit Item" : "Add Item"}</h3>
              <button className="btn-icon" onClick={() => setShowModal(false)}>
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="form-row">
                  <div className="form-group">
                    <label>Item Name *</label>
                    <input
                      className="form-control"
                      placeholder="e.g. Ariel Powder"
                      value={form.name}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, name: e.target.value }))
                      }
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Category</label>
                    <select
                      className="form-control"
                      value={form.category_id}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, category_id: e.target.value }))
                      }
                    >
                      <option value="">No Category</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  {/* BRANCH */}
                  {/* ADMIN ONLY BRANCH ASSIGNMENT */}
                  {role === "admin" && (
                    <div className="form-group">
                      <label>Assigned Branch *</label>

                      <select
                        className="form-control"
                        value={form.branch}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            branch: e.target.value,
                          }))
                        }
                      >
                        {BRANCHES.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* UNIT */}
                  <div className="form-group">
                    <label>Unit</label>

                    <select
                      className="form-control"
                      value={form.unit}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          unit: e.target.value,
                        }))
                      }
                    >
                      <option value="pcs">Pieces</option>
                      <option value="kg">Kilograms</option>
                      <option value="L">Liters</option>
                      <option value="mL">Milliliters</option>
                      <option value="g">Grams</option>
                      <option value="packs">Packs</option>
                      <option value="bottles">Bottles</option>
                      <option value="sachets">Sachets</option>
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Current Stock *</label>
                    <input
                      className="form-control"
                      type="number"
                      step="0.01"
                      placeholder="0"
                      value={form.current_stock}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          current_stock: e.target.value,
                        }))
                      }
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Minimum Stock Level</label>
                    <input
                      className="form-control"
                      type="number"
                      step="0.01"
                      placeholder="0"
                      value={form.minimum_stock}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          minimum_stock: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
                <p className="form-hint" style={{ marginTop: 4 }}>
                  Automatic consumption is configured per service in Services → Service Inventory Requirements.
                </p>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={savingItem}
                  onClick={() => setShowModal(false)}
                >
                  Cancel
                </button>
                <LoadingButton type="submit" className="btn btn-primary" loading={savingItem} loadingLabel={editing ? "Updating…" : "Adding…"}>
                  {editing ? "Update" : "Add Item"}
                </LoadingButton>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Restock Modal */}
      {showRestock && (
        <div className="modal-overlay" onClick={() => setShowRestock(null)}>
          <div
            className="modal"
            style={{ maxWidth: 400 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Restock: {showRestock.name}</h3>
              <button className="btn-icon" disabled={restocking} onClick={() => setShowRestock(null)}>
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleRestock}>
              <div className="modal-body">
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--text-muted)",
                    marginBottom: 16,
                  }}
                >
                  Current stock:{" "}
                  <strong style={{ color: "var(--text-primary)" }}>
                    {showRestock.current_stock} {showRestock.unit}
                  </strong>
                </p>
                <div className="form-group">
                  <label>Quantity to Add *</label>
                  <input
                    className="form-control"
                    type="number"
                    step="0.01"
                    min="0.01"
                    placeholder="0"
                    value={restockQty}
                    onChange={(e) => setRestockQty(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Total Cost (₱)</label>
                  <input
                    className="form-control"
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={restockCost}
                    onChange={(e) => setRestockCost(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Supplier</label>
                  <input
                    className="form-control"
                    placeholder="Supplier name"
                    value={restockSupplier}
                    onChange={(e) => setRestockSupplier(e.target.value)}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={restocking}
                  onClick={() => setShowRestock(null)}
                >
                  Cancel
                </button>
                <LoadingButton type="submit" className="btn btn-success" loading={restocking} loadingLabel="Restocking…">
                  <RefreshCw size={16} /> Restock
                </LoadingButton>
              </div>
            </form>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(itemToDelete)}
        title="Archive inventory item?"
        message={<> <strong>{itemToDelete?.name}</strong> will no longer be available for branch stock checks or new orders. An administrator can restore it later.</>}
        confirmLabel="Archive Item"
        cancelLabel="Keep Item"
        loading={deleting}
        onConfirm={deleteItem}
        onClose={() => setItemToDelete(null)}
      />
    </>
  );
}
