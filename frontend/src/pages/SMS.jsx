import { CheckCircle, Mail } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { supabase } from "../lib/supabase";
import { apiFetch } from "../services/api/client";
import { useRealtime } from "../lib/useRealtime";
import { PageError, PageLoader } from "../components/AsyncState";
import LoadingButton from "../components/LoadingButton";
import { compareOrdersForList } from "../utils/orderListPriority";

export default function Notifications() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState("email");
  const [emailSending, setEmailSending] = useState({});

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
          )
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

  useEffect(() => {
    loadData();
  }, [loadData]);

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
      await apiFetch("/api/notifications/email", {
        method: "POST",
        body: JSON.stringify(emailForm),
      });
      toast.success("Email sent successfully!");
      setEmailForm({
        to: "",
        subject: "",
        body: "",
      });
    } catch (error) {
      toast.error("Failed to send email — check network");
    }

    setSending(false);
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
      await apiFetch("/api/notifications/email", {
        method: "POST",
        body: JSON.stringify({
          to: order.customers.email,

          subject: `Your Laundry is Ready for Pickup! (Order #${order.order_number})`,

          body: `Hi ${order.customers.name || "Customer"},

Great news! Your laundry (Order #${
            order.order_number
          }) is now ready for pickup at I&C Laundry.

Please pick it up at your earliest convenience during our business hours.

Thank you for choosing I&C Laundry!

— I&C Laundry Team`,
        }),
      });

      toast.success(`Email sent to ${order.customers.email}`);
    } catch (error) {
      toast.error(error.message || "Failed to send email");
    }

    setEmailSending((prev) => ({
      ...prev,
      [order.id]: false,
    }));
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
                    <th>Email</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {orders.filter((o) => o.status === "ready").length === 0 ? (
                    <tr>
                      <td colSpan={5} className="empty-state">
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
    </>
  );
}
