import { format } from "date-fns";
import { Edit2, Gift, Phone, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { supabase } from "../lib/supabase";
import { useRealtime } from "../lib/useRealtime";
import { useAuth } from "../context/AuthContext";
import { getVisibleCustomers } from "../services/api/operationsApi";
import { InlineSkeleton, PageError, PageLoader } from "../components/AsyncState";
import ConfirmDialog from "../components/ConfirmDialog";
import LoadingButton from "../components/LoadingButton";
import { DataTable, EmptyState, SortableHeader, TableToolbar, useSortableRows } from "../components/DataView";
import { isValidPhilippineMobile, normalizePhone } from "../utils/validation";
import useActiveBranches from "../hooks/useActiveBranches";

export default function Customers() {
  const branchNames = useActiveBranches();
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const [allCustomers, setAllCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [customerToDelete, setCustomerToDelete] = useState(null);
  const [rewardCustomer, setRewardCustomer] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    branch: branchNames[0] || "",
  });
  // 🔥 PAGINATION STATES
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;
  const totalCount = allCustomers.length;

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const loadCustomers = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true);
      setLoadError("");
    } else setRefreshing(true);

    try {
      // Admin receives the master customer directory. Staff receive only customers
      // associated with their branch through customer_branches. Preserve the
      // server order because it reflects the correct recency for each role.
      const { data: allData = [] } = await getVisibleCustomers();
      setAllCustomers(allData);
    } catch (error) {
      if (!background) {
        setLoadError(error.message || "Unable to load customer records.");
        setAllCustomers([]);
      } else {
        console.error("Background customer refresh failed:", error);
      }
    }

    if (!background) setLoading(false);
    else setRefreshing(false);
  }, []);

  // Page changes use the already loaded directory and never trigger a
  // full-screen network refresh.
  useEffect(() => {
    const lastPage = Math.max(0, Math.ceil(allCustomers.length / PAGE_SIZE) - 1);
    if (page > lastPage) {
      setPage(lastPage);
    }
  }, [allCustomers, page]);

  const customers = useMemo(
    () => allCustomers.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [allCustomers, page]
  );

  // 🔥 RESET PAGE WHEN SEARCH CHANGES
  // 🔥 LOAD DATA ON START + PAGE CHANGE
  useEffect(() => {
    loadCustomers();
  }, [loadCustomers]);

  // Realtime: refresh when customers change
  useRealtime(["customers"], () => loadCustomers(true));

  function openEdit(cust) {
    setEditing(cust);
    setForm({
      name: cust.name,
      phone: cust.phone,
      email: cust.email || "",
      branch: cust.branch || "",
    });
    setShowModal(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.phone.trim() || !form.email.trim())
      return toast.error("Name, phone, and email are required");
    if (!isValidPhilippineMobile(form.phone))
      return toast.error("Phone number must start with 09 and contain exactly 11 digits.");
    if (isAdmin && !form.branch)
      return toast.error("Please assign this customer to a branch");

    setSaving(true);
    try {
      if (!editing?.id) throw new Error("Customers can only be created while placing an order.");
      const { error } = await supabase
        .from("customers")
        .update(form)
        .eq("id", editing.id);
      if (error) throw error;
      toast.success("Customer updated!");
      setShowModal(false);
      await loadCustomers(true);
    } catch (error) {
      toast.error(error.message || "Unable to save the customer.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteCustomer() {
    if (!customerToDelete || deleting) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from("customers").delete().eq("id", customerToDelete.id);
      if (error) throw error;
      toast.success("Customer archived");
      setCustomerToDelete(null);
      loadCustomers(true);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDeleting(false);
    }
  }

  // 🔥 SAME LOGIC AS ORDERS
  const source = search ? allCustomers : customers;

  const filtered = source.filter((c) => {
    if (!search) return true;

    const q = search.toLowerCase();

    return (
      c.name?.toLowerCase().includes(q) ||
      c.phone?.includes(q) ||
      (c.email || "").toLowerCase().includes(q)
    );
  });
  const { sortedRows, sort, requestSort } = useSortableRows(filtered, "name", {
    name: (customer) => customer.name,
    phone: (customer) => customer.phone,
    email: (customer) => customer.email,
    branch: (customer) => customer.branch,
    rewards: (customer) => customer.loyaltyRewards?.length || 0,
    added: (customer) => new Date(customer.created_at).getTime(),
  });

  const rewardLabel = (reward) => {
    if (!reward) return "No issued reward";
    const benefit = reward.reward_type === "free_load"
      ? `Free ${Number(reward.free_load_kg || 8)} kg load`
      : `${reward.discount_percent}% off`;
    return `${benefit} · ${reward.status}`;
  };

  if (loading) return <PageLoader label="Loading customers…" />;
  if (loadError) return <PageError message={loadError} onRetry={loadCustomers} />;

  return (
    <>
      <TableToolbar>
        <div className="search-box">
          <Search />
          <input
            placeholder="Search customers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </TableToolbar>

      {refreshing && <div className="section-fetch-state"><InlineSkeleton label="Refreshing customers…" /></div>}

      <DataTable ariaLabel="Customers">
            <thead>
              <tr>
                <SortableHeader label="Name" column="name" sort={sort} onSort={requestSort} />
                <SortableHeader label="Phone" column="phone" sort={sort} onSort={requestSort} />
                <SortableHeader label="Email" column="email" sort={sort} onSort={requestSort} />
                {isAdmin && <SortableHeader label="Branch" column="branch" sort={sort} onSort={requestSort} />}
                <SortableHeader label="Issued rewards" column="rewards" sort={sort} onSort={requestSort} />
                <SortableHeader label="Added" column="added" sort={sort} onSort={requestSort} />
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 ? (
                <EmptyState colSpan={isAdmin ? 7 : 6} message="No customers found" />
              ) : (
                sortedRows.map((c) => (
                  <tr key={c.id}>
                    <td data-card-primary data-label="Customer"
                      style={{ fontWeight: 600, color: "var(--text-primary)" }}
                    >
                      {c.name}
                    </td>
                    <td data-label="Phone">
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <Phone size={14} /> {c.phone}
                      </span>
                    </td>
                    <td data-label="Email">{c.email || "—"}</td>
                    {isAdmin && <td data-label="Branch">{c.branch || "Unassigned"}</td>}
                    <td data-label="Issued rewards">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setRewardCustomer(c)}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 210 }}
                        title="View this customer's issued loyalty rewards"
                      >
                        <Gift size={14} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {rewardLabel(c.loyaltyRewards?.[0])}{c.loyaltyRewards?.length > 1 ? ` +${c.loyaltyRewards.length - 1}` : ""}
                        </span>
                      </button>
                    </td>
                    <td data-label="Added" style={{ fontSize: 13, color: "var(--text-muted)" }}>
                      {format(new Date(c.created_at), "MMM d, yyyy")}
                    </td>
                    <td data-card-actions data-label="Actions">
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          className="btn-icon"
                          onClick={() => openEdit(c)}
                          title="Edit customer"
                          aria-label={`Edit ${c.name}`}
                        >
                          <Edit2 size={16} /><span className="mobile-action-label">Edit</span>
                        </button>
                        <button
                          className="btn-icon"
                          onClick={() => setCustomerToDelete(c)}
                          style={{ color: "var(--danger)" }}
                          title="Archive customer"
                          aria-label={`Archive ${c.name}`}
                        >
                          <Trash2 size={16} /><span className="mobile-action-label">Archive</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
      </DataTable>
      {!search && (
        <div className="system-pagination" style={{ textAlign: "center" }}>
          <div
            className="system-pagination-controls"
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 6,
              marginBottom: 8,
            }}
          >
            {/* FIRST */}
            <button
              className="btn btn-sm"
              disabled={page === 0}
              onClick={() => setPage(0)}
            >
              «
            </button>

            {/* PREVIOUS */}
            <button
              className="btn btn-sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(p - 1, 0))}
            >
              ‹
            </button>

            {/* PAGE NUMBERS */}
            {Array.from({ length: Math.min(totalPages, 3) }).map((_, offset) => {
              const start = Math.min(Math.max(page - 1, 0), Math.max(totalPages - 3, 0));
              const pageIndex = start + offset;
              return (
                <button
                  key={pageIndex}
                  onClick={() => setPage(pageIndex)}
                  style={{
                    minWidth: 36,
                    height: 36,
                    borderRadius: 8,
                    background: pageIndex === page ? "#1e293b" : "transparent",
                    color: pageIndex === page ? "#fff" : "#94a3b8",
                    fontWeight: 600,
                  }}
                >
                  {pageIndex + 1}
                </button>
              );
            })}

            {/* NEXT */}
            <button
              className="btn btn-sm"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              ›
            </button>

            {/* LAST */}
            <button
              className="btn btn-sm"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage(totalPages - 1)}
            >
              »
            </button>
          </div>

          {/* RANGE TEXT */}
          <div style={{ fontSize: 13, color: "#94a3b8" }}>
            {totalCount === 0
              ? "0 of 0"
              : `${page * PAGE_SIZE + 1}–${Math.min(
                  (page + 1) * PAGE_SIZE,
                  totalCount,
                )} out of ${totalCount}`}
          </div>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>Edit Customer</h3>
                <p>Update the customer’s contact details. New customers are created when an order is placed.</p>
              </div>
              <button className="btn-icon" type="button" aria-label="Close customer form" disabled={saving} onClick={() => setShowModal(false)}>
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="form-row">
                  <div className="form-group">
                    <label>Full Name *</label>
                    <input
                      className="form-control"
                      placeholder="Juan Dela Cruz"
                      value={form.name}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, name: e.target.value }))
                      }
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Phone Number *</label>
                    <input
                      className="form-control"
                      placeholder="09171234567"
                      value={form.phone}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, phone: normalizePhone(e.target.value) }))
                      }
                      inputMode="numeric"
                      pattern="09[0-9]{9}"
                      maxLength={11}
                      required
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label>Email *</label>
                  <input
                    className="form-control"
                    type="email"
                    placeholder="email@example.com"
                    value={form.email}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, email: e.target.value }))
                    }
                    required
                  />
                </div>
                {isAdmin && (
                  <div className="form-group">
                    <label>Branch *</label>
                    <select
                      className="form-control"
                      value={form.branch}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, branch: e.target.value }))
                      }
                      required
                    >
                      <option value="">Select branch</option>
                      {branchNames.map((branch) => (
                        <option key={branch} value={branch}>
                          {branch}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={saving}
                  onClick={() => setShowModal(false)}
                >
                  Cancel
                </button>
                <LoadingButton type="submit" className="btn btn-primary" loading={saving} loadingLabel="Updating…">
                  Update Customer
                </LoadingButton>
              </div>
            </form>
          </div>
        </div>
      )}
      {rewardCustomer && (
        <div className="modal-overlay" onClick={() => setRewardCustomer(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: 620 }}>
            <div className="modal-header">
              <div>
                <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Gift size={20} /> Issued Rewards</h3>
                <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 13 }}>{rewardCustomer.name} · {rewardCustomer.phone}</p>
              </div>
              <button className="btn-icon" onClick={() => setRewardCustomer(null)} aria-label="Close issued rewards"><X size={20} /></button>
            </div>
            <div className="modal-body">
              {!rewardCustomer.loyaltyRewards?.length ? (
                <p style={{ margin: 0, color: "var(--text-muted)" }}>No loyalty rewards have been issued to this customer yet.</p>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {rewardCustomer.loyaltyRewards.map((reward) => (
                    <div key={reward.id} style={{ border: "1px solid var(--border-color)", borderRadius: 10, padding: 12, background: "var(--bg-secondary)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
                        <strong>{reward.reward_type === "free_load" ? `Free ${Number(reward.free_load_kg || 8)} kg load` : `${reward.discount_percent}% discount`}</strong>
                        <span className={`loyalty-reward-status loyalty-reward-status-${reward.status}`} style={{ textTransform: "capitalize", fontSize: 12, fontWeight: 700, padding: "3px 8px", borderRadius: 999 }}>{reward.status}</span>
                      </div>
                      <p style={{ margin: "7px 0 0", color: "var(--text-muted)", fontSize: 13 }}>Issued {format(new Date(reward.earned_at), "MMM d, yyyy, h:mm a")}</p>
                      {reward.status === "revoked" && reward.revoke_reason && <p style={{ margin: "6px 0 0", color: "var(--danger)", fontSize: 13 }}>Reason: {reward.revoke_reason}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-footer"><button className="btn btn-secondary" onClick={() => setRewardCustomer(null)}>Close</button></div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(customerToDelete)}
        title="Archive customer?"
        message={<> <strong>{customerToDelete?.name}</strong> will be hidden from active customer lists. An administrator can restore the customer later from the Audit Log.</>}
        confirmLabel="Archive Customer"
        cancelLabel="Keep Customer"
        loading={deleting}
        onConfirm={deleteCustomer}
        onClose={() => setCustomerToDelete(null)}
      />
    </>
  );
}
