import {
  Bell,
  CheckCircle2,
  Eye,
  EyeOff,
  Gift,
  KeyRound,
  Lock,
  MailCheck,
  Save,
  Shield,
  Timer,
} from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";
import { apiFetch } from "../services/api/client";
import LoadingButton from "../components/LoadingButton";
import ChangeEmail from "../components/ChangeEmail";
import InfoNote from "../components/InfoNote";
import useOtpCooldown from "../hooks/useOtpCooldown";
import { clearOtpSession, readOtpSession, writeOtpSession } from "../utils/otpSession";
import { passwordPolicyError } from "../utils/validation";

const PASSWORD_OTP_SESSION_KEY = "ic-laundry:settings-password-otp";
const PASSWORD_OTP_COOLDOWN_KEY = "ic-laundry:settings-password-otp-cooldown";
const SETTINGS_TABS = [
  { id: "security", label: "Account security", icon: Shield },
  { id: "recovery-email", label: "Recovery email", icon: MailCheck },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "order-timing", label: "Order timing", icon: Timer },
  { id: "loyalty", label: "Customer loyalty", icon: Gift },
];

function tabFromHash() {
  const id = window.location.hash.replace("#settings-", "");
  return SETTINGS_TABS.some((tab) => tab.id === id) ? id : SETTINGS_TABS[0].id;
}

export default function Settings() {
  const { user, contactEmail } = useAuth();
  const [savedPasswordOtpRequest] = useState(() => readOtpSession(PASSWORD_OTP_SESSION_KEY));

  // Password change
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [passwordOtp, setPasswordOtp] = useState("");
  const [otpDestination, setOtpDestination] = useState(() => savedPasswordOtpRequest?.destination || "");
  const [recoveryEmailMissing, setRecoveryEmailMissing] = useState(false);
  const [passwordOtpStatus, setPasswordOtpStatus] = useState("idle");
  const [passwordOtpMessage, setPasswordOtpMessage] = useState("");
  const [pwLoading, setPwLoading] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [appearanceSaving, setAppearanceSaving] = useState(false);
  const passwordOtpCooldown = useOtpCooldown(PASSWORD_OTP_COOLDOWN_KEY);

  // One settings tab is shown at a time; the URL hash keeps it linkable.
  const [activeTab, setActiveTab] = useState(tabFromHash);
  const selectTab = (tabId) => {
    setActiveTab(tabId);
    window.history.replaceState(window.history.state, "", `#settings-${tabId}`);
  };
  const handleTabKeyDown = (event) => {
    const index = SETTINGS_TABS.findIndex((tab) => tab.id === activeTab);
    const steps = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    let next = null;
    if (event.key in steps) next = SETTINGS_TABS[(index + steps[event.key] + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    if (event.key === "Home") next = SETTINGS_TABS[0];
    if (event.key === "End") next = SETTINGS_TABS[SETTINGS_TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };

  const requestPasswordOtp = async () => {
    setPwLoading(true);
    setRecoveryEmailMissing(false);
    try {
      const result = await apiFetch('/api/auth/password/otp', { method: 'POST' });
      setOtpDestination(result.destination);
      writeOtpSession(PASSWORD_OTP_SESSION_KEY, { destination: result.destination });
      passwordOtpCooldown.start(result.cooldownSeconds);
      setPasswordOtp("");
      setPasswordOtpStatus("idle");
      setPasswordOtpMessage("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success(`Verification code sent to ${result.destination}`);
    } catch (error) {
      setRecoveryEmailMissing(error.data?.code === 'CONTACT_EMAIL_REQUIRED');
      if (error.data?.retryAfterSeconds) passwordOtpCooldown.start(error.data.retryAfterSeconds);
      toast.error(error.message);
    } finally {
      setPwLoading(false);
    }
  };

  const verifyPasswordOtp = async (code) => {
    if (!/^\d{6}$/.test(code)) return;
    setPwLoading(true);
    setPasswordOtpStatus("checking");
    setPasswordOtpMessage("");
    try {
      await apiFetch('/api/auth/password/otp/verify', { method: 'POST', body: JSON.stringify({ otp: code }) });
      setPasswordOtpStatus("valid");
    } catch (error) {
      setPasswordOtpStatus("invalid");
      setPasswordOtpMessage(/invalid verification code/i.test(error.message) ? "OTP is wrong. Please try again." : error.message);
    } finally {
      setPwLoading(false);
    }
  };

  // Business settings
  const [settings, setSettings] = useState(null);

  const [notifications, setNotifications] = useState(true);

  // ETA settings
  const [defaultProcessingMinutes, setDefaultProcessingMinutes] = useState(100);
  const [etaBufferMinutes, setEtaBufferMinutes] = useState(15);
  const [etaMinCompletedOrders, setEtaMinCompletedOrders] = useState(5);
  const [statusUndoSeconds, setStatusUndoSeconds] = useState(60);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(true);
  const [loyaltyDiscountMilestone, setLoyaltyDiscountMilestone] = useState(5);
  const [loyaltyFreeLoadMilestone, setLoyaltyFreeLoadMilestone] = useState(10);
  const [loyaltyDiscountPercent, setLoyaltyDiscountPercent] = useState(50);
  const [loyaltyRewardExpiryDays, setLoyaltyRewardExpiryDays] = useState(180);

  useEffect(() => {
    async function loadSettings() {
      const { data, error } = await supabase
        .from("settings")
        .select("*")
        .single();

      if (!error && data) {
        setSettings(data);

        // populate UI fields

        setNotifications(data.notifications !== false);

        setDefaultProcessingMinutes(data.default_processing_minutes || ((data.etawash || 45) + (data.etadrying || 40) + (data.etafolding || 15)));
        setEtaBufferMinutes(data.eta_buffer_minutes ?? 15);
        setEtaMinCompletedOrders(data.eta_min_completed_orders ?? 5);
        setStatusUndoSeconds(data.status_undo_seconds ?? 60);
        setLoyaltyEnabled(data.loyalty_enabled !== false);
        setLoyaltyDiscountMilestone(data.loyalty_discount_milestone ?? 5);
        setLoyaltyFreeLoadMilestone(data.loyalty_free_load_milestone ?? 10);
        setLoyaltyDiscountPercent(data.loyalty_discount_percent ?? 50);
        setLoyaltyRewardExpiryDays(data.loyalty_reward_expiry_days ?? 180);
      }
    }

    loadSettings();
  }, []);
  useEffect(() => {
    const channel = supabase
      .channel("settings-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "settings" },
        async () => {
          const { data } = await supabase.from("settings").select("*").single();

          if (data) {
            setSettings(data);
            setNotifications(data.notifications !== false);

            setDefaultProcessingMinutes(data.default_processing_minutes || ((data.etawash || 45) + (data.etadrying || 40) + (data.etafolding || 15)));
            setEtaBufferMinutes(data.eta_buffer_minutes ?? 15);
            setEtaMinCompletedOrders(data.eta_min_completed_orders ?? 5);
            setStatusUndoSeconds(data.status_undo_seconds ?? 60);
            setLoyaltyEnabled(data.loyalty_enabled !== false);
            setLoyaltyDiscountMilestone(data.loyalty_discount_milestone ?? 5);
            setLoyaltyFreeLoadMilestone(data.loyalty_free_load_milestone ?? 10);
            setLoyaltyDiscountPercent(data.loyalty_discount_percent ?? 50);
            setLoyaltyRewardExpiryDays(data.loyalty_reward_expiry_days ?? 180);
          }
        },
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    const policyError = passwordPolicyError(newPassword);
    if (policyError) {
      toast.error(policyError);
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    if (passwordOtpStatus !== "valid") {
      toast.error("Verify your OTP before setting a new password");
      return;
    }

    setPwLoading(true);
    try {
      await apiFetch('/api/auth/password', { method: 'PATCH', body: JSON.stringify({ newPassword, otp: passwordOtp }) });
      clearOtpSession(PASSWORD_OTP_SESSION_KEY);
      setNewPassword("");
      setConfirmPassword("");
      setPasswordOtp("");
      setOtpDestination("");
      setPasswordOtpStatus("idle");
      setPasswordChanged(true);
    } catch (err) {
      toast.error(err.message || "Failed to update password");
    }
    setPwLoading(false);
  };

  // Each tab saves only its own fields: saving order timing neither depends on
  // nor writes unsaved loyalty edits, and saving loyalty leaves timing alone.
  const handleSaveBusinessSettings = async (group) => {
    if (!settings?.id || settingsSaving) return;
    if (group === "loyalty" && (Number(loyaltyDiscountMilestone) < 1 || Number(loyaltyFreeLoadMilestone) <= Number(loyaltyDiscountMilestone)
      || Number(loyaltyDiscountPercent) < 1 || Number(loyaltyDiscountPercent) > 100 || Number(loyaltyRewardExpiryDays) < 1)) {
      toast.error("Check the loyalty milestones, percentage, and expiry period.");
      return;
    }
    const changes = group === "timing"
      ? {
          default_processing_minutes: Number(defaultProcessingMinutes),
          eta_buffer_minutes: Number(etaBufferMinutes),
          eta_min_completed_orders: Number(etaMinCompletedOrders),
          status_undo_seconds: Number(statusUndoSeconds),
        }
      : {
          loyalty_enabled: loyaltyEnabled,
          loyalty_discount_milestone: Number(loyaltyDiscountMilestone),
          loyalty_free_load_milestone: Number(loyaltyFreeLoadMilestone),
          loyalty_discount_percent: Number(loyaltyDiscountPercent),
          loyalty_reward_expiry_days: Number(loyaltyRewardExpiryDays),
        };
    setSettingsSaving(true);
    try {
      const { error } = await supabase
        .from("settings")
        .update(changes)
        .eq("id", settings.id);
      if (error) throw error;
      toast.success(group === "timing" ? "Order timing saved" : "Loyalty settings saved");
    } catch (error) {
      toast.error("Failed to save settings");
    } finally {
      setSettingsSaving(false);
    }
  };

  const saveAppearancePreference = async (field, nextValue, previousValue) => {
    if (!settings?.id || appearanceSaving) return false;
    setAppearanceSaving(true);
    try {
      const { data, error } = await supabase
        .from("settings")
        .update({ [field]: nextValue })
        .eq("id", settings.id)
        .select("id, notifications")
        .single();
      if (error) throw error;

      setSettings((current) => ({ ...current, ...data }));
      toast.success("Notification preference saved");
      return true;
    } catch (error) {
      if (field === "notifications") setNotifications(previousValue);
      toast.error(error?.message || "Failed to save appearance preference");
      return false;
    } finally {
      setAppearanceSaving(false);
    }
  };

  const handleNotificationsToggle = async () => {
    if (appearanceSaving) return;
    const next = !notifications;
    setNotifications(next);
    await saveAppearancePreference("notifications", next, notifications);
  };

  // Format time for display

  if (!settings) return null;
  return (
    <div className="settings-page settings-layout">
      <div className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={handleTabKeyDown}>
        {SETTINGS_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            className="settings-tab"
            aria-selected={activeTab === id}
            aria-controls={`settings-panel-${id}`}
            tabIndex={activeTab === id ? 0 : -1}
            onClick={() => selectTab(id)}
          >
            <Icon size={16} aria-hidden="true" /> {label}
          </button>
        ))}
      </div>

      <div className="settings-content">
        {/* ====== ACCOUNT SECURITY ====== */}
        <section id="settings-panel-security" role="tabpanel" aria-labelledby="settings-tab-security" hidden={activeTab !== "security"} className="card settings-section">
          <header className="settings-section-header">
            <h3 id="settings-security-title">Account security</h3>
            <p>Change your password with a verification code sent to your recovery email.</p>
          </header>
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Email</span>
            </div>
            <div className="settings-row-control settings-row-value">{contactEmail || user?.email}</div>
          </div>
          <div className="settings-row settings-row-stacked">
            <div className="settings-row-text">
              <span className="settings-row-label">Change password</span>
              <p>Send a verification code, enter it, then set your new password.</p>
            </div>
            <div className="settings-password-form">
              <form onSubmit={handlePasswordChange}>
                <LoadingButton type="button" className="btn btn-secondary" disabled={passwordOtpCooldown.remaining > 0} onClick={requestPasswordOtp} loading={pwLoading} loadingLabel="Sending code…" style={{ width: '100%', marginBottom: 14 }}>
                  <MailCheck size={16} /> {otpDestination ? passwordOtpCooldown.label : 'Send verification code'}
                </LoadingButton>
                {passwordOtpCooldown.remaining > 0 && <p className="otp-cooldown-notice" role="status">{passwordOtpCooldown.message}</p>}
                {recoveryEmailMissing && <div className="otp-email-missing" role="alert">No recovery email is bound to your account. Use <strong>Change Bound Email</strong> below to add one before requesting an OTP.</div>}
                {otpDestination && <div className="account-security-notice" style={{ marginBottom: 14 }}><MailCheck size={16} /><span>Code sent to <strong>{otpDestination}</strong>. It expires in 10 minutes.</span></div>}
                <div className="form-group">
                  <label htmlFor="settings-password-otp">Email Verification Code</label>
                  <div className="settings-input-wrapper">
                    <KeyRound size={16} className="settings-input-icon" />
                    <input id="settings-password-otp" autoComplete="one-time-code" spellCheck={false} className={`form-control otp-verification-input ${passwordOtpStatus}`} inputMode="numeric" maxLength={6} disabled={!otpDestination || pwLoading || passwordOtpStatus === "valid" || passwordOtpStatus === "checking"} value={passwordOtp} onChange={(e) => { const code = e.target.value.replace(/\D/g, ''); setPasswordOtp(code); setPasswordOtpStatus("idle"); setPasswordOtpMessage(""); if (code.length === 6) void verifyPasswordOtp(code); }} placeholder="6-digit code" aria-invalid={passwordOtpStatus === "invalid"} required style={{ paddingLeft: 38, textAlign: 'center', letterSpacing: 5, fontWeight: 700 }} />
                  </div>
                  {passwordOtpStatus === "checking" && <p className="otp-verification-checking" role="status">Checking OTP…</p>}
                  {passwordOtpMessage && <p className="otp-verification-message" role="alert">{passwordOtpMessage}</p>}
                </div>
                {passwordOtpStatus === "valid" && <div className="otp-verification-success" role="status">OTP verified. You can now set a new password.</div>}
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="settings-new-password">New Password</label>
                    <div className="settings-input-wrapper">
                      <Lock size={16} className="settings-input-icon" />
                      <input id="settings-new-password" autoComplete="new-password"
                        className="form-control"
                        type={showNew ? "text" : "password"}
                        placeholder="Strong password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        minLength={12}
                        disabled={pwLoading || passwordOtpStatus !== "valid"}
                        required
                        style={{ paddingLeft: 38, paddingRight: 38 }}
                      />
                      <button
                        type="button"
                        className="settings-eye-btn"
                        disabled={pwLoading || passwordOtpStatus !== "valid"}
                        onClick={() => setShowNew(!showNew)}
                      >
                        {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="settings-confirm-password">Confirm New Password</label>
                    <div className="settings-input-wrapper">
                      <Lock size={16} className="settings-input-icon" />
                      <input id="settings-confirm-password" autoComplete="new-password"
                        className="form-control"
                        type={showConfirm ? "text" : "password"}
                        placeholder="Re-enter new password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        disabled={pwLoading || passwordOtpStatus !== "valid"}
                        required
                        style={{ paddingLeft: 38, paddingRight: 38 }}
                      />
                      <button
                        type="button"
                        className="settings-eye-btn"
                        disabled={pwLoading || passwordOtpStatus !== "valid"}
                        onClick={() => setShowConfirm(!showConfirm)}
                      >
                        {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                </div>
                <LoadingButton className="btn btn-primary" type="submit" disabled={passwordOtpStatus !== "valid"} loading={pwLoading} loadingLabel="Updating password…">
                  <Lock size={15} /> Update Password
                </LoadingButton>
              </form>
            </div>
          </div>
        </section>

        {/* ====== RECOVERY EMAIL ====== */}
        <div id="settings-panel-recovery-email" role="tabpanel" aria-labelledby="settings-tab-recovery-email" hidden={activeTab !== "recovery-email"} className="settings-panel">
          <ChangeEmail onChanged={() => { clearOtpSession(PASSWORD_OTP_SESSION_KEY); setPasswordOtp(''); setOtpDestination(''); setPasswordOtpStatus('idle'); }} />
        </div>

        {/* ====== NOTIFICATIONS AND DISPLAY ====== */}
        <section id="settings-panel-notifications" role="tabpanel" aria-labelledby="settings-tab-notifications" hidden={activeTab !== "notifications"} className="card settings-section">
          <header className="settings-section-header">
            <h3 id="settings-notifications-title">Notifications and display</h3>
            <p>Your on-screen preferences. Changes here save automatically.</p>
          </header>
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label" id="settings-notifications-label">Action notifications</span>
              <p>Show toast notifications for actions.</p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                role="switch"
                className={`settings-toggle ${notifications ? "active" : ""}`}
                onClick={handleNotificationsToggle}
                disabled={appearanceSaving}
                aria-checked={notifications}
                aria-labelledby="settings-notifications-label"
              >
                <div className="settings-toggle-knob" />
              </button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Theme</span>
              <p>Use the moon or sun button in the page header to change the theme for only your account on this browser.</p>
            </div>
          </div>
          <p className="settings-auto-save-status" role="status">
            {appearanceSaving ? "Saving notification preference…" : "Notification changes are saved automatically."}
          </p>
        </section>

        {/* ====== ORDER TIMING ====== */}
        <section id="settings-panel-order-timing" role="tabpanel" aria-labelledby="settings-tab-order-timing" hidden={activeTab !== "order-timing"} className="card settings-section">
          <header className="settings-section-header">
            <h3 id="settings-order-timing-title">Order timing</h3>
            <p>Ready estimates use completed-order history when enough comparable orders exist; otherwise, the fallback time plus the safety buffer.</p>
          </header>
          <div className="settings-row">
            <div className="settings-row-text">
              <label htmlFor="setting-default-processing">Default processing time</label>
              <p>Fallback time for a new order when there is not enough order history.</p>
            </div>
            <div className="settings-row-control">
              <div className="settings-unit-input">
                <input autoComplete="off" id="setting-default-processing" className="form-control" type="number" min="1" value={defaultProcessingMinutes} onChange={(e) => setDefaultProcessingMinutes(e.target.value)} />
                <span>min</span>
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <label htmlFor="setting-undo-window">Staff undo window</label>
              <p>How long staff have to move an order back to its previous stage.</p>
            </div>
            <div className="settings-row-control">
              <div className="settings-unit-input">
                <input autoComplete="off" id="setting-undo-window" className="form-control" type="number" min="1" value={statusUndoSeconds} onChange={(e) => setStatusUndoSeconds(e.target.value)} />
                <span>sec</span>
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <label htmlFor="setting-eta-buffer">ETA safety buffer</label>
              <p>Extra time added to the fallback estimate.</p>
            </div>
            <div className="settings-row-control">
              <div className="settings-unit-input">
                <input autoComplete="off" id="setting-eta-buffer" className="form-control" type="number" min="1" value={etaBufferMinutes} onChange={(e) => setEtaBufferMinutes(e.target.value)} />
                <span>min</span>
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <label htmlFor="setting-eta-history">Minimum completed orders</label>
              <p>Completed orders needed before estimates use order history.</p>
            </div>
            <div className="settings-row-control">
              <div className="settings-unit-input">
                <input autoComplete="off" id="setting-eta-history" className="form-control" type="number" min="1" value={etaMinCompletedOrders} onChange={(e) => setEtaMinCompletedOrders(e.target.value)} />
                <span>orders</span>
              </div>
            </div>
          </div>
          <div className="settings-row settings-row-summary">
            <span>Fallback estimate for new orders</span>
            <strong>~{Number(defaultProcessingMinutes) + Number(etaBufferMinutes)} min</strong>
          </div>
          <footer className="settings-section-footer">
            <span>Saves the order timing settings on this tab only.</span>
            <LoadingButton className="btn btn-primary" loading={settingsSaving} loadingLabel="Saving…" onClick={() => handleSaveBusinessSettings("timing")}>
              <Save size={15} /> Save order timing
            </LoadingButton>
          </footer>
        </section>

        {/* ====== CUSTOMER LOYALTY ====== */}
        <section id="settings-panel-loyalty" role="tabpanel" aria-labelledby="settings-tab-loyalty" hidden={activeTab !== "loyalty"} className="card settings-section">
          <header className="settings-section-header">
            <h3 id="settings-loyalty-title">Customer loyalty</h3>
            <p>Cross-branch rewards are earned only when fully paid orders are released.</p>
          </header>
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label" id="settings-loyalty-label">Loyalty rewards</span>
              <p>Staff can redeem only the customer’s available, single-use rewards.</p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                role="switch"
                className={`settings-toggle ${loyaltyEnabled ? "active" : ""}`}
                onClick={() => setLoyaltyEnabled((value) => !value)}
                aria-checked={loyaltyEnabled}
                aria-labelledby="settings-loyalty-label"
              >
                <div className="settings-toggle-knob" />
              </button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <label htmlFor="setting-discount-milestone">Discount reward order</label>
              <p>The order in each cycle that earns the discount.</p>
            </div>
            <div className="settings-row-control">
              <div className="settings-unit-input">
                <input autoComplete="off" id="setting-discount-milestone" className="form-control" type="number" min="1" value={loyaltyDiscountMilestone} onChange={(e) => setLoyaltyDiscountMilestone(e.target.value)} />
                <span>order #</span>
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <label htmlFor="setting-discount-percent">Discount percentage</label>
              <p>Taken off the entire checkout for that order.</p>
            </div>
            <div className="settings-row-control">
              <div className="settings-unit-input">
                <input autoComplete="off" id="setting-discount-percent" className="form-control" type="number" min="1" max="100" value={loyaltyDiscountPercent} onChange={(e) => setLoyaltyDiscountPercent(e.target.value)} />
                <span>%</span>
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <label htmlFor="setting-free-load-milestone">Free 8 kg load order</label>
              <p>The order in each cycle that earns one free 8 kg standard load.</p>
            </div>
            <div className="settings-row-control">
              <div className="settings-unit-input">
                <input autoComplete="off" id="setting-free-load-milestone" className="form-control" type="number" min="2" value={loyaltyFreeLoadMilestone} onChange={(e) => setLoyaltyFreeLoadMilestone(e.target.value)} />
                <span>order #</span>
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <label htmlFor="setting-reward-expiry">Reward expiry</label>
              <p>Unused rewards expire after this many days.</p>
            </div>
            <div className="settings-row-control">
              <div className="settings-unit-input">
                <input autoComplete="off" id="setting-reward-expiry" className="form-control" type="number" min="1" value={loyaltyRewardExpiryDays} onChange={(e) => setLoyaltyRewardExpiryDays(e.target.value)} />
                <span>days</span>
              </div>
            </div>
          </div>
          <div className="settings-row settings-row-summary">
            <span>Every cycle: order #{loyaltyDiscountMilestone} earns {loyaltyDiscountPercent}% off the entire checkout; order #{loyaltyFreeLoadMilestone} earns one free 8 kg standard load.</span>
          </div>
          <div className="settings-section-note">
            <InfoNote compact title="When rewards are earned">
              A customer earns progress only after a fully paid order is released. Restoring or editing an inventory item does not change reward history.
            </InfoNote>
          </div>
          <footer className="settings-section-footer">
            <span>Saves the loyalty settings on this tab only.</span>
            <LoadingButton className="btn btn-primary" loading={settingsSaving} loadingLabel="Saving…" onClick={() => handleSaveBusinessSettings("loyalty")}>
              <Save size={15} /> Save loyalty settings
            </LoadingButton>
          </footer>
        </section>
      </div>
      {passwordChanged && <div className="modal-overlay account-security-success-overlay" role="presentation">
        <section className="account-security-success-dialog" role="alertdialog" aria-modal="true" aria-labelledby="admin-password-success-title">
          <span className="account-security-success-icon"><CheckCircle2 size={32} /></span>
          <h3 id="admin-password-success-title">Password changed successfully</h3>
          <p>Your administrator password was updated and a fresh secure session is active.</p>
          <div className="account-security-success-note">Keep your password and verification code private. Do not share them with anyone.</div>
          <button className="account-security-submit" onClick={() => setPasswordChanged(false)}>Continue</button>
        </section>
      </div>}
    </div>
  );
}
