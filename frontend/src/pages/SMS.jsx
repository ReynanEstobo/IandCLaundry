import { AlertCircle, CheckCircle, History, Mail, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { supabase } from "../lib/supabase";
import { apiFetch } from "../services/api/client";
import { useRealtime } from "../lib/useRealtime";
import { PageError, PageLoader } from "../components/AsyncState";
import LoadingButton from "../components/LoadingButton";
import { compareOrdersForList } from "../utils/orderListPriority";
import { getEmailDeliveryAudit, retryEmail } from "../services/api/notificationApi";

const AUDIT_PAGE_SIZE = 10;
const NOTIFICATION_TYPE_LABELS = {
  manual: "Manual email",
  order_received: "Order received",
  ready_for_pickup: "Ready for pickup",
  password_otp: "Password OTP",
  email_change_otp: "Email-change OTP",
};
const RETRYABLE_NOTIFICATION_TYPES = new Set(["manual", "order_received", "ready_for_pickup"]);

function notificationTypeLabel(type) {
  return NOTIFICATION_TYPE_LABELS[type] || "Email notification";
}

function garmentLabel(delivery) {
  const garments = Array.isArray(delivery.garment_details) ? delivery.garment_details : [];
  if (!garments.length) {
    return delivery.order_number ? "Order details unavailable" : notificationTypeLabel(delivery.notification_type);
  }
  return garments.map((item) => `${item.service || "Laundry service"}${Number(item.weight_kg) > 0 ? ` · ${Number(item.weight_kg).toLocaleString()} kg` : ""}`).join(", ");
}

export default function Notifications() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState("email");
  const [emailSending, setEmailSending] = useState({});
  const [deliveryAudit, setDeliveryAudit] = useState([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState("");
  const [auditPage, setAuditPage] = useState(1);
  const [auditPagination, setAuditPagination] = useState({ page: 1, pageSize: AUDIT_PAGE_SIZE, total: 0, totalPages: 1 });
  const [retrying, setRetrying] = useState({});

  const [emailForm, setEmailForm] = useState({
    to: "",
    subject: "",
    body: "",
  });

  // ─────────────────────────────────────
  // LOAD DATA
  // ─────────────────────────────────────
  const loadData = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true);
      setLoadError("");
    }
    try {
    const { data: ordersData, error } = await supabase
      .from("orders")
      .select(
        `
          *,
          customers(
            name,
            email
          ),
          order_items(id, service_name_snapshot, weight_kg, status)
        `,
      )
      .in("status", ["received", "on_process", "ready"])
      .order("created_at", {
        ascending: false,
      });

    if (error) throw error;
    setOrders([...(ordersData || [])].sort(compareOrdersForList));
    } catch (error) {
      if (!background) setLoadError(error.message || "Unable to load notification data.");
      else console.error("Background notification refresh failed:", error);
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  const loadDeliveryAudit = useCallback(async (page = 1, background = false) => {
    if (!background) setAuditLoading(true);
    setAuditError("");
    try {
      const result = await getEmailDeliveryAudit(page, AUDIT_PAGE_SIZE);
      setDeliveryAudit(result.items || []);
      setAuditPage(result.page || page);
      setAuditPagination({
        page: result.page || page,
        pageSize: result.pageSize || AUDIT_PAGE_SIZE,
        total: result.total || 0,
        totalPages: result.totalPages || 1,
      });
    } catch (error) {
      setAuditError(error.message || "Unable to load email delivery history.");
    } finally {
      if (!background) setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    loadDeliveryAudit(1);
  }, [loadData, loadDeliveryAudit]);

  // ─────────────────────────────────────
  // REALTIME
  // ─────────────────────────────────────
  useRealtime(["orders"], () => loadData(true));

  // ─────────────────────────────────────
  // SEND EMAIL
  // ─────────────────────────────────────
  async function handleSendEmail(e) {
    e.preventDefault();

    if (!emailForm.to || !emailForm.subject || !emailForm.body) {
      return toast.error("All email fields are required");
    }

    setSending(true);

    try {
      const result = await apiFetch("/api/notifications/email", {
        method: "POST",
        body: JSON.stringify({ ...emailForm, notificationType: "manual" }),
      });
      toast.success("Email sent successfully!");
      if (result.auditRecorded === false) toast.error("Email was sent, but its audit record could not be saved.");
      setEmailForm({
        to: "",
        subject: "",
        body: "",
      });
    } catch (error) {
      toast.error(error.message || "Failed to send email");
    } finally {
      setSending(false);
      await loadDeliveryAudit(1, true);
    }
  }

  // ─────────────────────────────────────
  // QUICK READY EMAIL
  // ─────────────────────────────────────
  async function quickEmailReady(order) {
    if (!order.customers?.email) {
      return toast.error("No email address for this customer");
    }

    setEmailSending((prev) => ({
      ...prev,
      [order.id]: true,
    }));

    try {
      const result = await apiFetch("/api/notifications/email", {
        method: "POST",
        body: JSON.stringify({
          to: order.customers.email,
          orderId: order.id,
          notificationType: "ready_for_pickup",

          subject: `Your I&C Laundry order is ready - ${order.order_number}`,

          body: `Hello ${order.customers.name || "Customer"},

Your laundry is ready for pickup at I&C Laundry.

Tracking number: ${order.order_number}

You may collect it during our regular business hours. Please bring your tracking number so our staff can locate your order.

Thank you,
I&C Laundry`,
        }),
      });

      toast.success(`Email sent to ${order.customers.email}`);
      if (result.auditRecorded === false) toast.error("Email was sent, but its audit record could not be saved.");
    } catch (error) {
      toast.error(error.message || "Failed to send email");
    } finally {
      setEmailSending((prev) => ({
        ...prev,
        [order.id]: false,
      }));
      await loadDeliveryAudit(1, true);
    }
  }

  async function retryFailedEmail(delivery) {
    setRetrying((current) => ({ ...current, [delivery.id]: true }));
    try {
      await retryEmail(delivery.id);
      toast.success(`Email resent to ${delivery.recipient_email}`);
    } catch (error) {
      toast.error(error.message || "Email retry failed");
    } finally {
      setRetrying((current) => ({ ...current, [delivery.id]: false }));
      await loadDeliveryAudit(1, true);
    }
  }

  // ─────────────────────────────────────
  // LOADING
  // ─────────────────────────────────────
  if (loading) return <PageLoader label="Loading notifications…" />;
  if (loadError) return <PageError message={loadError} onRetry={loadData} />;

  return (
    <>
      {/* ───────────────────────────── */}
      {/* TABS */}
      {/* ───────────────────────────── */}
      <div
        className="tabs"
        style={{
          display: "inline-flex",
          marginBottom: 20,
        }}
      >
        <button
          className={`tab ${tab === "email" ? "active" : ""}`}
          onClick={() => setTab("email")}
        >
          <Mail
            size={15}
            style={{
              marginRight: 4,
            }}
          />
          Email Notify
        </button>

        <button
          className={`tab ${tab === "quick" ? "active" : ""}`}
          onClick={() => setTab("quick")}
        >
          Quick Notify
        </button>

        <button
          className={`tab ${tab === "audit" ? "active" : ""}`}
          onClick={() => setTab("audit")}
        >
          <History size={15} style={{ marginRight: 4 }} />
          Delivery Audit
        </button>
      </div>

      {/* ───────────────────────────── */}
      {/* EMAIL TAB */}
      {/* ───────────────────────────── */}
      {tab === "email" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 20,
            maxWidth: 900,
          }}
        >
          {/* EMAIL FORM */}
          <div className="card">
            <div className="card-header">
              <h3>
                <Mail
                  size={18}
                  style={{
                    marginRight: 6,
                  }}
                />
                Compose Email
              </h3>
            </div>

            <form onSubmit={handleSendEmail}>
              <div className="form-group">
                <label>Recipient Email *</label>

                <input
                  className="form-control"
                  type="email"
                  placeholder="customer@email.com"
                  value={emailForm.to}
                  onChange={(e) =>
                    setEmailForm((f) => ({
                      ...f,
                      to: e.target.value,
                    }))
                  }
                  required
                />
              </div>

              <div className="form-group">
                <label>Subject *</label>

                <input
                  className="form-control"
                  placeholder="e.g. Your laundry is ready!"
                  value={emailForm.subject}
                  onChange={(e) =>
                    setEmailForm((f) => ({
                      ...f,
                      subject: e.target.value,
                    }))
                  }
                  required
                />
              </div>

              <div className="form-group">
                <label>Message *</label>

                <textarea
                  className="form-control"
                  rows={6}
                  placeholder="Type your message..."
                  value={emailForm.body}
                  onChange={(e) =>
                    setEmailForm((f) => ({
                      ...f,
                      body: e.target.value,
                    }))
                  }
                  required
                  style={{
                    minHeight: 150,
                  }}
                />
              </div>

              <LoadingButton
                className="btn btn-primary"
                type="submit"
                loading={sending}
                loadingLabel="Sending…"
                style={{
                  width: "100%",
                  justifyContent: "center",
                }}
              >
                <Mail size={16} />
                Send Email
              </LoadingButton>
            </form>
          </div>

          {/* EMAIL INFO */}
          <div className="card">
            <div className="card-header">
              <h3>Email Information</h3>
            </div>

            <div
              style={{
                padding: "20px 0",
              }}
            >
              <div
                className="email-delivery-info"
                style={{
                  borderRadius: "var(--radius-sm)",
                  padding: 16,
                  marginBottom: 20,
                }}
              >
                <div
                  className="email-delivery-info-title"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontWeight: 600,
                    marginBottom: 4,
                  }}
                >
                  <CheckCircle size={16} />
                  I&C Laundry Email Delivery
                </div>

                <p
                  style={{
                    fontSize: 13,
                    color: "var(--text-secondary)",
                  }}
                >
                  Email notifications are sent from iclaundryshop@gmail.com.
                  Customers with email addresses will receive notifications when
                  their garments are ready for pickup.
                </p>
              </div>

              <div
                style={{
                  fontSize: 13,
                  color: "var(--text-muted)",
                }}
              >
                <p
                  style={{
                    marginBottom: 8,
                  }}
                >
                  <strong
                    style={{
                      color: "var(--text-secondary)",
                    }}
                  >
                    Features:
                  </strong>
                </p>

                <ul
                  style={{
                    paddingLeft: 20,
                    lineHeight: 1.8,
                  }}
                >
                  <li>Manual email notifications</li>

                  <li>Quick ready-for-pickup email sending</li>

                  <li>Secure Gmail delivery</li>

                  <li>Real-time order monitoring</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────── */}
      {/* QUICK NOTIFY */}
      {/* ───────────────────────────── */}
      {tab === "quick" && (
        <>
          <div
            style={{
              marginBottom: 16,
            }}
          >
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: 14,
              }}
            >
              Quickly notify customers about their ready orders through email
              notifications.
            </p>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Customer</th>
                    <th>Garment / Service</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {orders.filter((o) => o.status === "ready").length === 0 ? (
                    <tr>
                      <td colSpan={6} className="empty-state">
                        <p>No orders ready for pickup notification</p>
                      </td>
                    </tr>
                  ) : (
                    orders
                      .filter((o) => o.status === "ready")
                      .map((order) => (
                        <tr key={order.id}>
                          <td
                            style={{
                              fontWeight: 600,
                              color: "var(--text-primary)",
                            }}
                          >
                            {order.order_number}
                          </td>

                          <td>{order.customers?.name || "Walk-in"}</td>

                          <td>{(order.order_items || []).map((item) => item.service_name_snapshot || "Laundry service").join(", ") || "Laundry service"}</td>

                          <td>{order.customers?.email || "—"}</td>

                          <td>
                            <span className="badge badge-ready">ready</span>
                          </td>

                          <td>
                            <LoadingButton
                              className="btn btn-sm btn-primary"
                              onClick={() => quickEmailReady(order)}
                              disabled={!order.customers?.email}
                              loading={emailSending[order.id]}
                              loadingLabel="Sending…"
                              title={
                                order.customers?.email
                                  ? "Send email"
                                  : "No email address"
                              }
                            >
                              <Mail size={14} /> Email
                            </LoadingButton>
                          </td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === "audit" && (
        <section className="card notification-audit-card">
          <div className="card-header notification-audit-header">
            <div>
              <h3><History size={18} /> Email Delivery Audit</h3>
              <p>Each send and retry is recorded separately. Failed records are never overwritten.</p>
            </div>
            <button className="btn btn-sm btn-secondary" onClick={() => loadDeliveryAudit(auditPage)} disabled={auditLoading}>
              <RotateCcw size={14} className={auditLoading ? "spin" : ""} /> Refresh
            </button>
          </div>

          {auditError && (
            <div className="notification-audit-error" role="alert">
              <AlertCircle size={17} />
              <span>{auditError}</span>
              <button type="button" onClick={() => loadDeliveryAudit(auditPage)}>Try again</button>
            </div>
          )}

          {auditLoading ? (
            <div className="notification-audit-loading"><span className="spinner" /> Loading delivery history…</div>
          ) : (
            <div className="table-wrapper">
              <table className="responsive-card-table notification-audit-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Type</th>
                    <th>Order / Garment</th>
                    <th>Recipient</th>
                    <th>Attempt</th>
                    <th>Result</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {!deliveryAudit.length ? (
                    <tr><td colSpan={7} className="empty-state"><p>No email delivery attempts recorded yet</p></td></tr>
                  ) : deliveryAudit.map((delivery) => (
                    <tr key={delivery.id}>
                      <td data-label="Status">
                        <span className={`notification-delivery-status ${delivery.status}`}>
                          {delivery.status === "sent" ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                          {delivery.status === "sent" ? "Sent" : "Failed"}
                        </span>
                      </td>
                      <td data-label="Type">
                        <span className={`notification-type-badge notification-type-${delivery.notification_type || "manual"}`}>
                          {notificationTypeLabel(delivery.notification_type)}
                        </span>
                      </td>
                      <td data-label="Order / Garment" data-card-primary>
                        <div className="notification-garment">
                          <strong>{delivery.order_number || (delivery.notification_type?.includes("otp") ? "Security verification" : "Manual email")}</strong>
                          <span>{garmentLabel(delivery)}</span>
                        </div>
                      </td>
                      <td data-label="Recipient"><span className="notification-recipient">{delivery.recipient_email}</span></td>
                      <td data-label="Attempt">
                        <div className="notification-attempt">
                          <span>{new Date(delivery.attempted_at).toLocaleString("en-PH")}</span>
                          <small>{delivery.staff?.full_name || "System"}{delivery.retry_of_id ? " · Retry" : ""}</small>
                        </div>
                      </td>
                      <td data-label="Result">
                        {delivery.status === "failed"
                          ? <span className="notification-failure-reason" title={delivery.error_message || "Delivery failed"}>{delivery.error_message || "Delivery failed"}</span>
                          : <span className="notification-provider">Accepted by {delivery.provider === "gmail_smtp" ? "Gmail" : "email service"}</span>}
                      </td>
                      <td data-label="Action" data-card-actions>
                        {delivery.status === "failed" && RETRYABLE_NOTIFICATION_TYPES.has(delivery.notification_type) ? (
                          <LoadingButton
                            className="btn btn-sm btn-primary"
                            onClick={() => retryFailedEmail(delivery)}
                            loading={Boolean(retrying[delivery.id])}
                            loadingLabel="Retrying…"
                          >
                            <RotateCcw size={14} /> Retry email
                          </LoadingButton>
                        ) : delivery.status === "failed" ? (
                          <span className="notification-no-action">Request a new code</span>
                        ) : <span className="notification-no-action">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="audit-pagination notification-audit-pagination">
                <span>
                  {auditPagination.total
                    ? `Showing ${(auditPage - 1) * auditPagination.pageSize + 1}–${Math.min(auditPage * auditPagination.pageSize, auditPagination.total)} of ${auditPagination.total}`
                    : "No delivery attempts"}
                </span>
                <div>
                  <button className="btn btn-sm btn-secondary" type="button" disabled={auditLoading || auditPage <= 1} onClick={() => loadDeliveryAudit(auditPage - 1)}>
                    Previous
                  </button>
                  <span className="notification-audit-page">Page {auditPage} of {auditPagination.totalPages}</span>
                  <button className="btn btn-sm btn-secondary" type="button" disabled={auditLoading || auditPage >= auditPagination.totalPages} onClick={() => loadDeliveryAudit(auditPage + 1)}>
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}
