import { format } from "date-fns";
import { Edit2, Eye, EyeOff, KeyRound, Plus, Search, Trash2, X } from "lucide-react";

import { useCallback, useEffect, useState } from "react";

import toast from "react-hot-toast";

import { supabase } from "../lib/supabase";
import { apiFetch } from "../services/api/client";
import { useRealtime } from "../lib/useRealtime";
import { PageError, PageLoader } from "../components/AsyncState";
import ConfirmDialog from "../components/ConfirmDialog";
import LoadingButton from "../components/LoadingButton";
import { isValidPhilippineMobile, normalizePhone } from "../utils/validation";

// ─────────────────────────────────────
// ROLES
// ─────────────────────────────────────
const ROLES = [
  {
    value: "admin",
    label: "Admin",
  },

  {
    value: "staff",
    label: "Staff",
  },
];

// ─────────────────────────────────────
// BRANCHES
// ─────────────────────────────────────
const BRANCHES = [
  {
    value: "Main - Brgy 7",
    label: "Main - Brgy 7",
  },

  {
    value: "2nd Branch - Brgy Calzada",
    label: "2nd Branch - Brgy Calzada",
  },

  {
    value: "3rd Branch - Nasugbu",
    label: "3rd Branch - Nasugbu",
  },
];

export default function Staff() {
  // ─────────────────────────────────────
  // STATES
  // ─────────────────────────────────────
  const [staffList, setStaffList] = useState([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [showModal, setShowModal] = useState(false);

  const [editing, setEditing] = useState(null);

  const [search, setSearch] = useState("");

  const [showPassword, setShowPassword] = useState(false);

  const [saving, setSaving] = useState(false);
  const [staffToDelete, setStaffToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [staffToReset, setStaffToReset] = useState(null);
  const [resettingCredentials, setResettingCredentials] = useState(false);
  const [issuedCredentials, setIssuedCredentials] = useState(null);

  const [form, setForm] = useState({
    full_name: "",
    phone: "",
    email: "",
    role: "staff",
    branch: "Main - Brgy 7",
    position: "",
    password: "",
  });

  // ─────────────────────────────────────
  // LOAD STAFF
  // ─────────────────────────────────────
  const loadStaff = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true);
      setLoadError("");
    }
    try {
      const { data, error } = await supabase.from("staff").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      setStaffList(data || []);
    } catch (error) {
      if (!background) setLoadError(error.message || "Unable to load staff records.");
      else console.error("Background staff refresh failed:", error);
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStaff();
  }, [loadStaff]);

  // ─────────────────────────────────────
  // REALTIME
  // ─────────────────────────────────────
  useRealtime(["staff"], () => loadStaff(true));

  // ─────────────────────────────────────
  // OPEN NEW
  // ─────────────────────────────────────
  function openNew() {
    setEditing(null);

    setForm({
      full_name: "",
      phone: "",
      email: "",
      role: "staff",
      branch: "Main - Brgy 7",
      position: "",
      password: "",
    });

    setShowPassword(false);

    setShowModal(true);
  }

  // ─────────────────────────────────────
  // OPEN EDIT
  // ─────────────────────────────────────
  function openEdit(staff) {
    setEditing(staff);

    setForm({
      full_name: staff.full_name,
      phone: staff.phone || "",
      email: staff.contact_email || "",
      role: staff.role || "staff",
      branch: staff.branch || "Main - Brgy 7",
      position: staff.position || "",
      password: "",
    });

    setShowPassword(false);

    setShowModal(true);
  }

  // ─────────────────────────────────────
  // SUBMIT
  // ─────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();

    if (!form.full_name.trim()) {
      return toast.error("Full name is required");
    }
    if (form.phone && !isValidPhilippineMobile(form.phone)) {
      return toast.error("Phone number must start with 09 and contain exactly 11 digits.");
    }

    setSaving(true);

    // ─────────────────────────────────
    // UPDATE STAFF
    // ─────────────────────────────────
    if (editing) {
      try {
        await apiFetch("/api/staff/update", {
          method: "POST",
          body: JSON.stringify({
            staffId: editing.id,
            full_name: form.full_name,
            phone: form.phone,
            contact_email: form.email,
            role: form.role,
            branch: form.branch,
            position: form.position,
          }),
        });
      } catch (error) {
        setSaving(false);
        return toast.error(error.message || "Unable to update staff.");
      }

      // PASSWORD UPDATE
      if (false && form.password && form.password.length >= 6 && editing.auth_id) {
        const { error: pwErr } = await supabase.functions.invoke(
          "update-staff-password",
          {
            body: {
              user_id: editing.auth_id,
              password: form.password,
            },
          },
        );

        if (pwErr) {
          toast.error(
            "Staff updated but password change failed — use Supabase dashboard",
          );
        }
      }

      toast.success("Staff updated!");
    }

    // ─────────────────────────────────
    // CREATE STAFF
    // ─────────────────────────────────
    else {
      try {
        const result = await apiFetch("/api/staff/provision", {
          method: "POST",
          body: JSON.stringify({
            full_name: form.full_name,
            phone: form.phone,
            contact_email: form.email,
            role: form.role,
            branch: form.branch,
            position: form.position,
          }),
        });
        setIssuedCredentials(result.credentials);
        toast.success(`${form.role === "admin" ? "Administrator" : "Staff"} account provisioned. Save the credentials now.`);
      } catch (error) {
        setSaving(false);
        return toast.error(error.message || "Unable to provision the staff account.");
      }
    }

    setSaving(false);

    setShowModal(false);

    loadStaff(true);
  }

  // ─────────────────────────────────────
  // DELETE STAFF
  // ─────────────────────────────────────
  async function deleteStaff() {
    if (!staffToDelete || deleting) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from("staff").delete().eq("id", staffToDelete.id);
      if (error) throw error;
      toast.success("Staff account archived");
      setStaffToDelete(null);
      loadStaff(true);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDeleting(false);
    }
  }

  async function resetCredentials() {
    if (!staffToReset || resettingCredentials) return;
    setResettingCredentials(true);
    try {
      const result = await apiFetch("/api/staff/reset-credentials", {
        method: "POST",
        body: JSON.stringify({ staffId: staffToReset.id }),
      });
      setStaffToReset(null);
      setIssuedCredentials(result.credentials);
      toast.success("New temporary credentials created.");
      loadStaff(true);
    } catch (error) {
      toast.error(error.message || "Unable to reset credentials.");
    } finally {
      setResettingCredentials(false);
    }
  }

  // ─────────────────────────────────────
  // FILTER
  // ─────────────────────────────────────
  const filtered = staffList.filter((s) => {
    if (!search) return true;

    const q = search.toLowerCase();

    return (
      s.full_name.toLowerCase().includes(q) ||
      (s.email || "").toLowerCase().includes(q) ||
      (s.phone || "").includes(q) ||
      (s.branch || "").toLowerCase().includes(q)
    );
  });

  // ─────────────────────────────────────
  // LOADING
  // ─────────────────────────────────────
  if (loading) return <PageLoader label="Loading staff…" />;
  if (loadError) return <PageError message={loadError} onRetry={loadStaff} />;

  return (
    <>
      {/* HEADER */}
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
        {/* SEARCH */}
        <div className="search-box">
          <Search />

          <input
            placeholder="Search staff..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* ADD BUTTON */}
        <button className="btn btn-primary" onClick={openNew}>
          <Plus size={18} />
          Add Account
        </button>
      </div>

      {/* TABLE */}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Staff ID / Username</th>
                <th>Contact Email</th>
                <th>Phone</th>
                <th>Position</th>
                <th>Branch</th>
                <th>Role</th>
                <th>Added</th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="empty-state">
                    <p>No staff found</p>
                  </td>
                </tr>
              ) : (
                filtered.map((s) => (
                  <tr key={s.id}>
                    {/* NAME */}
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

                          gap: 10,
                        }}
                      >
                        <div
                          style={{
                            width: 32,
                            height: 32,

                            borderRadius: "50%",

                            background:
                              s.role === "admin"
                                ? "var(--primary)"
                                : "var(--primary-light)",

                            color: "#fff",

                            display: "flex",

                            alignItems: "center",

                            justifyContent: "center",

                            fontSize: 13,

                            fontWeight: 700,

                            flexShrink: 0,
                          }}
                        >
                          {s.full_name.charAt(0).toUpperCase()}
                        </div>

                        {s.full_name}
                      </div>
                    </td>

                    <td>
                      <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                        <strong>{s.staff_code || "—"}</strong><br />
                        <span style={{ color: "var(--text-muted)" }}>{s.username || "Legacy account"}</span>
                      </div>
                    </td>

                    {/* CONTACT EMAIL — the auth email for provisioned accounts
                        is intentionally internal and must not be shown here. */}
                    <td>{s.contact_email || (s.username ? "No contact email" : s.email || "—")}</td>

                    {/* PHONE */}
                    <td>{s.phone || "—"}</td>

                    {/* POSITION */}
                    <td>{s.position || "—"}</td>

                    {/* BRANCH */}
                    <td>{s.branch || "—"}</td>

                    {/* ROLE */}
                    <td>
                      <span
                        className={`badge ${
                          s.role === "admin" ? "badge-paid" : "badge-partial"
                        }`}
                        style={{
                          textTransform: "capitalize",
                        }}
                      >
                        {s.role}
                      </span>
                    </td>

                    {/* DATE */}
                    <td
                      style={{
                        fontSize: 13,

                        color: "var(--text-muted)",
                      }}
                    >
                      {s.created_at
                        ? format(new Date(s.created_at), "MMM d, yyyy")
                        : "—"}
                    </td>

                    {/* ACTIONS */}
                    <td>
                      <div
                        style={{
                          display: "flex",

                          gap: 4,
                        }}
                      >
                        {/* EDIT */}
                        <button
                          className="btn-icon"
                          onClick={() => openEdit(s)}
                          title="Edit"
                        >
                          <Edit2 size={16} />
                        </button>

                        {s.auth_id && (
                          <button
                            className="btn-icon"
                            onClick={() => setStaffToReset(s)}
                            title="Reset generated credentials"
                          >
                            <KeyRound size={16} />
                          </button>
                        )}

                        {/* DELETE */}
                        <button
                          className="btn-icon"
                          onClick={() => setStaffToDelete(s)}
                          title="Delete"
                          style={{
                            color: "var(--danger)",
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MODAL */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {/* HEADER */}
            <div className="modal-header">
              <h3>{editing ? "Edit Account" : "Add Account"}</h3>

              <button className="btn-icon" onClick={() => setShowModal(false)}>
                <X size={20} />
              </button>
            </div>

            {/* FORM */}
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {/* ROW */}
                <div className="form-row">
                  {/* FULL NAME */}
                  <div className="form-group">
                    <label>Full Name *</label>

                    <input
                      className="form-control"
                      placeholder="Juan Dela Cruz"
                      value={form.full_name}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,

                          full_name: e.target.value,
                        }))
                      }
                      required
                    />
                  </div>

                  {/* PHONE */}
                  <div className="form-group">
                    <label>Phone Number</label>

                    <input
                      className="form-control"
                      placeholder="09171234567"
                      value={form.phone}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,

                          phone: normalizePhone(e.target.value),
                        }))
                      }
                      inputMode="numeric"
                      pattern="09[0-9]{9}"
                      maxLength={11}
                    />
                  </div>
                </div>

                {/* EMAIL */}
                <div className="form-group">
                  <label>
                    Contact email{form.role === "admin" ? " *" : " "}
                    <span
                      style={{
                        fontSize: 11,

                        color: "var(--text-muted)",
                      }}
                    >
                      {form.role === "admin" ? "(required for password recovery; not used for login)" : "(optional; not used for login)"}
                    </span>
                  </label>

                  <input
                    className="form-control"
                    type="email"
                    placeholder="staff@example.com"
                    value={form.email}
                    required={form.role === "admin"}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,

                        email: e.target.value,
                      }))
                    }
                  />
                </div>

                {/* POSITION + STAFF BRANCH */}
                <div className="form-row">
                  {/* POSITION */}
                  <div className="form-group">
                    <label>Position</label>

                    <input
                      className="form-control"
                      placeholder="e.g. Cashier, Washer"
                      value={form.position}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,

                          position: e.target.value,
                        }))
                      }
                    />
                  </div>

                  {/* Administrators are global; a branch selector only applies to staff. */}
                  {form.role === "staff" && <div className="form-group">
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
                        <option key={b.value} value={b.value}>
                          {b.label}
                        </option>
                      ))}
                    </select>
                  </div>}
                </div>

                {/* ROLE */}
                <div className="form-group">
                  <label>Role *</label>

                  <select
                    className="form-control"
                    value={form.role}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,

                        role: e.target.value,
                      }))
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  {form.role === "admin" && !editing && (
                    <p style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45 }}>
                      Administrators are global accounts with no branch assignment. They can access all branches, reports, settings, staff accounts, and the Audit Log. Only create this role for a trusted owner or manager.
                    </p>
                  )}
                </div>

                {/* Passwords are generated and reset only through the provisioning workflow. */}
                {false && <div className="form-group">
                  <label>
                    {editing ? "New Password" : "Password *"}{" "}
                    <span
                      style={{
                        fontSize: 11,

                        color: "var(--text-muted)",
                      }}
                    >
                      {editing
                        ? "(leave blank to keep current)"
                        : "(min 6 characters)"}
                    </span>
                  </label>

                  <div
                    style={{
                      position: "relative",
                    }}
                  >
                    <input
                      className="form-control"
                      type={showPassword ? "text" : "password"}
                      placeholder={
                        editing ? "Leave blank to keep" : "Min. 6 characters"
                      }
                      value={form.password}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,

                          password: e.target.value,
                        }))
                      }
                      {...(!editing && {
                        required: true,
                        minLength: 6,
                      })}
                      style={{
                        paddingRight: 40,
                      }}
                    />

                    <button
                      type="button"
                      onClick={() => setShowPassword((p) => !p)}
                      style={{
                        position: "absolute",

                        right: 8,

                        top: "50%",

                        transform: "translateY(-50%)",

                        background: "none",

                        border: "none",

                        cursor: "pointer",

                        color: "var(--text-muted)",

                        padding: 4,
                      }}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>}
              </div>

              {/* FOOTER */}
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={saving}
                  onClick={() => setShowModal(false)}
                >
                  Cancel
                </button>

                <LoadingButton
                  type="submit"
                  className="btn btn-primary"
                  loading={saving}
                  loadingLabel={editing ? "Updating…" : "Creating…"}
                >
                  {editing ? "Update Staff" : "Create Account"}
                </LoadingButton>
              </div>
            </form>
          </div>
        </div>
      )}
      {issuedCredentials && (
        <div className="modal-overlay" onClick={() => setIssuedCredentials(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h3>{issuedCredentials.role === "admin" ? "Administrator" : "Staff"} credentials created</h3>
              <button className="btn-icon" onClick={() => setIssuedCredentials(null)}><X size={20} /></button>
            </div>
            <div className="modal-body">
              <p style={{ marginTop: 0, color: "var(--text-muted)", lineHeight: 1.55 }}>
                Give these credentials to the account holder securely. The temporary password is shown only now and must be changed at first sign-in.
              </p>
              <div className="card" style={{ padding: 16, background: "var(--bg-body)" }}>
                <p><strong>Account ID:</strong> {issuedCredentials.staffCode}</p>
                <p><strong>Role:</strong> {issuedCredentials.role === "admin" ? "Administrator" : "Staff"}</p>
                <p><strong>Username:</strong> {issuedCredentials.username}</p>
                <p><strong>Temporary password:</strong> <code style={{ fontSize: 15, userSelect: "all" }}>{issuedCredentials.temporaryPassword}</code></p>
                {issuedCredentials.branch && <p style={{ marginBottom: 0 }}><strong>Assigned branch:</strong> {issuedCredentials.branch}</p>}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => navigator.clipboard?.writeText(`I&C Laundry\nAccount ID: ${issuedCredentials.staffCode}\nRole: ${issuedCredentials.role === "admin" ? "Administrator" : "Staff"}\nUsername: ${issuedCredentials.username}\nTemporary password: ${issuedCredentials.temporaryPassword}${issuedCredentials.branch ? `\nBranch: ${issuedCredentials.branch}` : ""}`).then(() => toast.success("Credentials copied."))}>Copy credentials</button>
              <button className="btn btn-primary" onClick={() => setIssuedCredentials(null)}>I saved them</button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(staffToReset)}
        title="Generate new staff credentials?"
        message={<>The current password for <strong>{staffToReset?.full_name}</strong> will stop working. The new temporary password will be shown once and must be changed on first sign-in.</>}
        confirmLabel="Generate credentials"
        cancelLabel="Cancel"
        loading={resettingCredentials}
        onConfirm={resetCredentials}
        onClose={() => setStaffToReset(null)}
      />
      <ConfirmDialog
        open={Boolean(staffToDelete)}
        title="Archive staff account?"
        message={<> <strong>{staffToDelete?.full_name}</strong>'s account will be archived and removed from active staff lists. An administrator can restore the account later.</>}
        confirmLabel="Archive Account"
        cancelLabel="Keep Account"
        loading={deleting}
        onConfirm={deleteStaff}
        onClose={() => setStaffToDelete(null)}
      />
    </>
  );
}
