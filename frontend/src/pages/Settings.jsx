import {
  Bell,
  CheckCircle2,
  DollarSign,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  MailCheck,
  Moon,
  Palette,
  Save,
  Shield,
  Sun,
  Timer,
} from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";
import { apiFetch } from "../services/api/client";
import LoadingButton from "../components/LoadingButton";
import ChangeEmail from "../components/ChangeEmail";
import useOtpCooldown from "../hooks/useOtpCooldown";
import { clearOtpSession, readOtpSession, writeOtpSession } from "../utils/otpSession";
import { passwordPolicyError } from "../utils/validation";

const PASSWORD_OTP_SESSION_KEY = "ic-laundry:settings-password-otp";
const PASSWORD_OTP_COOLDOWN_KEY = "ic-laundry:settings-password-otp-cooldown";

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
  const passwordOtpCooldown = useOtpCooldown(PASSWORD_OTP_COOLDOWN_KEY);

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

  const [darkMode, setDarkMode] = useState(false);
  const [notifications, setNotifications] = useState(true);

  // Pricing settings
  const [bundleKg, setBundleKg] = useState(8);
  const [bundlePrice, setBundlePrice] = useState(200);
  const [addonPrice, setAddonPrice] = useState(15);
  const [excessKgPrice, setExcessKgPrice] = useState(30);

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

        setDarkMode(data.darkmode || false);
        setNotifications(data.notifications !== false);

        setBundleKg(data.bundlekg || 8);
        setBundlePrice(data.bundleprice || 200);
        setAddonPrice(data.addonprice || 15);
        setExcessKgPrice(data.excesskgprice || 30);

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

            setShopName(data.shopname || "I&C Laundry");
            setOpenTime(data.opentime || "08:00");
            setCloseTime(data.closetime || "20:00");
            setDarkMode(data.darkmode || false);
            setNotifications(data.notifications !== false);

            setBundleKg(data.bundlekg || 8);
            setBundlePrice(data.bundleprice || 200);
            setAddonPrice(data.addonprice || 15);
            setExcessKgPrice(data.excesskgprice || 30);

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

  // Apply dark mode on mount and changes
  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      darkMode ? "dark" : "light",
    );
  }, [darkMode]);

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

  const handleSaveBusinessSettings = async () => {
    if (!settings?.id || settingsSaving) return;
    if (Number(loyaltyDiscountMilestone) < 1 || Number(loyaltyFreeLoadMilestone) <= Number(loyaltyDiscountMilestone)
      || Number(loyaltyDiscountPercent) < 1 || Number(loyaltyDiscountPercent) > 100 || Number(loyaltyRewardExpiryDays) < 1) {
      toast.error("Check the loyalty milestones, percentage, and expiry period.");
      return;
    }
    setSettingsSaving(true);
    try {
      const { error } = await supabase
        .from("settings")
        .update({
          darkmode: darkMode,
          notifications,
          bundlekg: Number(bundleKg),
          bundleprice: Number(bundlePrice),
          addonprice: Number(addonPrice),
          excesskgprice: Number(excessKgPrice),
          default_processing_minutes: Number(defaultProcessingMinutes),
          eta_buffer_minutes: Number(etaBufferMinutes),
          eta_min_completed_orders: Number(etaMinCompletedOrders),
          status_undo_seconds: Number(statusUndoSeconds),
          loyalty_enabled: loyaltyEnabled,
          loyalty_discount_milestone: Number(loyaltyDiscountMilestone),
          loyalty_free_load_milestone: Number(loyaltyFreeLoadMilestone),
          loyalty_discount_percent: Number(loyaltyDiscountPercent),
          loyalty_reward_expiry_days: Number(loyaltyRewardExpiryDays),
        })
        .eq("id", settings.id);
      if (error) throw error;
      toast.success("Settings updated!");
    } catch (error) {
      toast.error("Failed to save settings");
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleDarkModeToggle = () => {
    const next = !darkMode;
    setDarkMode(next);
  };

  const handleNotificationsToggle = () => {
    const next = !notifications;
    setNotifications(next);
  };

  // Format time for display

  if (!settings) return null;
  return (
    <div className="settings-page">
      <div className="settings-grid">
        {/* ====== ACCOUNT SECURITY ====== */}
        <div className="card settings-card">
          <div className="settings-card-header">
            <div className="settings-card-icon blue">
              <Shield size={20} />
            </div>
            <div>
              <h3>Account Security</h3>
              <p>Change your password with a secure email verification code</p>
            </div>
          </div>

          <div className="settings-info-row">
            <span className="settings-label">Email</span>
            <span className="settings-value">{contactEmail || user?.email}</span>
          </div>

          <div className="settings-divider" />

          <h4 className="settings-subtitle">Change Password</h4>
          <form onSubmit={handlePasswordChange}>
            <LoadingButton type="button" className="btn btn-secondary" disabled={passwordOtpCooldown.remaining > 0} onClick={requestPasswordOtp} loading={pwLoading} loadingLabel="Sending code…" style={{ width: '100%', marginBottom: 14 }}>
              <MailCheck size={16} /> {otpDestination ? passwordOtpCooldown.label : 'Send verification code'}
            </LoadingButton>
            {passwordOtpCooldown.remaining > 0 && <p className="otp-cooldown-notice" role="status">{passwordOtpCooldown.message}</p>}
            {recoveryEmailMissing && <div className="otp-email-missing" role="alert">No recovery email is bound to your account. Use <strong>Change Bound Email</strong> below to add one before requesting an OTP.</div>}
            {otpDestination && <div className="account-security-notice" style={{ marginBottom: 14 }}><MailCheck size={16} /><span>Code sent to <strong>{otpDestination}</strong>. It expires in 10 minutes.</span></div>}
            <div className="form-group">
              <label>Email Verification Code</label>
              <div className="settings-input-wrapper">
                <KeyRound size={16} className="settings-input-icon" />
                <input className={`form-control otp-verification-input ${passwordOtpStatus}`} inputMode="numeric" maxLength={6} disabled={!otpDestination || pwLoading || passwordOtpStatus === "valid" || passwordOtpStatus === "checking"} value={passwordOtp} onChange={(e) => { const code = e.target.value.replace(/\D/g, ''); setPasswordOtp(code); setPasswordOtpStatus("idle"); setPasswordOtpMessage(""); if (code.length === 6) void verifyPasswordOtp(code); }} placeholder="6-digit code" aria-invalid={passwordOtpStatus === "invalid"} required style={{ paddingLeft: 38, textAlign: 'center', letterSpacing: 5, fontWeight: 700 }} />
              </div>
              {passwordOtpStatus === "checking" && <p className="otp-verification-checking" role="status">Checking OTP…</p>}
              {passwordOtpMessage && <p className="otp-verification-message" role="alert">{passwordOtpMessage}</p>}
            </div>
            {passwordOtpStatus === "valid" && <div className="otp-verification-success" role="status">OTP verified. You can now set a new password.</div>}
            <div className="form-row">
              <div className="form-group">
                <label>New Password</label>
                <div className="settings-input-wrapper">
                  <Lock size={16} className="settings-input-icon" />
                  <input
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
                <label>Confirm New Password</label>
                <div className="settings-input-wrapper">
                  <Lock size={16} className="settings-input-icon" />
                  <input
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

        {/* ====== APPEARANCE ====== */}
        <ChangeEmail onChanged={() => { clearOtpSession(PASSWORD_OTP_SESSION_KEY); setPasswordOtp(''); setOtpDestination(''); setPasswordOtpStatus('idle'); }} />
        <div className="card settings-card">
          <div className="settings-card-header">
            <div className="settings-card-icon purple">
              <Palette size={20} />
            </div>
            <div>
              <h3>Appearance</h3>
              <p>Customize the look and feel of the system</p>
            </div>
          </div>

          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <div className="settings-toggle-icon-wrap">
                {darkMode ? <Moon size={18} /> : <Sun size={18} />}
              </div>
              <div>
                <span className="settings-toggle-label">Dark Mode</span>
                <span className="settings-toggle-desc">
                  Switch between light and dark theme
                </span>
              </div>
            </div>
            <button
              className={`settings-toggle ${darkMode ? "active" : ""}`}
              onClick={handleDarkModeToggle}
            >
              <div className="settings-toggle-knob" />
            </button>
          </div>

          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <div className="settings-toggle-icon-wrap">
                <Bell size={18} />
              </div>
              <div>
                <span className="settings-toggle-label">Notifications</span>
                <span className="settings-toggle-desc">
                  Show toast notifications for actions
                </span>
              </div>
            </div>
            <button
              className={`settings-toggle ${notifications ? "active" : ""}`}
              onClick={handleNotificationsToggle}
            >
              <div className="settings-toggle-knob" />
            </button>
          </div>
        </div>

        {/* ====== PRICING ====== */}
        <div className="card settings-card">
          <div className="settings-card-header">
            <div className="settings-card-icon amber">
              <DollarSign size={20} />
            </div>
            <div>
              <h3>Bundle & Add-on Pricing</h3>
              <p>Set the shared bundle rule and order-level add-on cost</p>
            </div>
          </div>

          <div className="settings-pricing-group">
            <h4 className="settings-subtitle">Bundle-priced services</h4>
            <div className="form-row">
              <div className="form-group">
                <label>Bundle Size (kg)</label>
                <input
                  className="form-control"
                  type="number"
                  min="1"
                  step="1"
                  value={bundleKg}
                  onChange={(e) => setBundleKg(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Price per Bundle (₱)</label>
                <input
                  className="form-control"
                  type="number"
                  min="0"
                  step="1"
                  value={bundlePrice}
                  onChange={(e) => setBundlePrice(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Excess Price per KG (₱)</label>
                <input
                  className="form-control"
                  type="number"
                  min="0"
                  step="1"
                  value={excessKgPrice}
                  onChange={(e) => setExcessKgPrice(e.target.value)}
                />
              </div>
            </div>
            <div className="settings-pricing-preview">
              <span>
                ₱{Number(bundlePrice).toLocaleString()} minimum for {bundleKg}kg
                + ₱{Number(excessKgPrice).toLocaleString()} per excess kg
              </span>
            </div>
            <p className="form-hint" style={{ marginTop: 10 }}>
              This rule applies only to services configured as <strong>Bundle</strong>, such as Regular Clothing.
            </p>
          </div>

          <div className="settings-divider" />

          <div className="settings-pricing-group">
            <h4 className="settings-subtitle">Add-ons (Soap / Detergent)</h4>
            <div className="form-group">
              <label>Price per Add-on Item (₱)</label>
              <input
                className="form-control"
                type="number"
                min="0"
                step="1"
                value={addonPrice}
                onChange={(e) => setAddonPrice(e.target.value)}
              />
            </div>
            <div className="settings-pricing-preview">
              <span>
                ₱{Number(addonPrice).toLocaleString()} per soap / detergent
                add-on
              </span>
            </div>
          </div>

          <div className="settings-divider" />
          <div className="settings-pricing-group">
            <h4 className="settings-subtitle">Individual service prices & inventory</h4>
            <p className="form-hint" style={{ margin: "0 0 12px" }}>
              Configure each service’s per-kg, per-piece, or fixed price—and the inventory items it consumes—in Services. Those rules are used for new multi-service orders.
            </p>
            <Link className="btn btn-secondary" to="/dashboard/services">Manage services</Link>
          </div>

          <LoadingButton
            className="btn btn-primary"
            loading={settingsSaving}
            loadingLabel="Saving…"
            onClick={handleSaveBusinessSettings}
            style={{ marginTop: 12 }}
          >
            <Save size={15} /> Save Pricing
          </LoadingButton>
        </div>

        {/* ====== ETA / PROCESS TIMES ====== */}
        <div className="card settings-card">
          <div className="settings-card-header">
            <div className="settings-card-icon cyan">
              <Timer size={20} />
            </div>
            <div>
              <h3>Order ETA</h3>
              <p>Customer-ready estimates based on completed orders and your branch fallback.</p>
            </div>
          </div>

          <div className="settings-eta-list">
            <div className="settings-eta-row">
              <div className="settings-eta-label">
                <span className="settings-eta-icon">🧺</span>
                <span>Default processing time</span>
              </div>
              <div className="settings-eta-input">
                <input
                  className="form-control"
                  type="number"
                  min="1"
                  value={defaultProcessingMinutes}
                  onChange={(e) => setDefaultProcessingMinutes(e.target.value)}
                />
                <span className="settings-eta-unit">min</span>
              </div>
            </div>
            <div className="settings-eta-row">
              <div className="settings-eta-label">
                <span className="settings-eta-icon">↩️</span>
                <span>Staff undo window</span>
              </div>
              <div className="settings-eta-input">
                <input
                  className="form-control"
                  type="number"
                  min="1"
                  value={statusUndoSeconds}
                  onChange={(e) => setStatusUndoSeconds(e.target.value)}
                />
                <span className="settings-eta-unit">sec</span>
              </div>
            </div>
            <div className="settings-eta-row">
              <div className="settings-eta-label">
                <span className="settings-eta-icon">☀️</span>
                <span>ETA safety buffer</span>
              </div>
              <div className="settings-eta-input">
                <input
                  className="form-control"
                  type="number"
                  min="1"
                  value={etaBufferMinutes}
                  onChange={(e) => setEtaBufferMinutes(e.target.value)}
                />
                <span className="settings-eta-unit">min</span>
              </div>
            </div>
            <div className="settings-eta-row">
              <div className="settings-eta-label">
                <span className="settings-eta-icon">👕</span>
                <span>Minimum completed orders for historical ETA</span>
              </div>
              <div className="settings-eta-input">
                <input
                  className="form-control"
                  type="number"
                  min="1"
                  value={etaMinCompletedOrders}
                  onChange={(e) => setEtaMinCompletedOrders(e.target.value)}
                />
                <span className="settings-eta-unit">orders</span>
              </div>
            </div>
          </div>

          <div className="settings-pricing-preview" style={{ marginTop: 12 }}>
            <span>
              Fallback estimate for new orders:{" "}
              <strong>
                ~{Number(defaultProcessingMinutes) + Number(etaBufferMinutes)} min
              </strong>
            </span>
          </div>

          <LoadingButton
            className="btn btn-primary"
            loading={settingsSaving}
            loadingLabel="Saving…"
            onClick={handleSaveBusinessSettings}
            style={{ marginTop: 12 }}
          >
            <Save size={15} /> Save ETA Settings
          </LoadingButton>
        </div>

        {/* ====== LOYALTY PROGRAM ====== */}
        <div className="card settings-card">
          <div className="settings-card-header">
            <div className="settings-card-icon amber"><DollarSign size={20} /></div>
            <div>
              <h3>Customer Loyalty</h3>
              <p>Cross-branch rewards are earned only when fully paid orders are released.</p>
            </div>
          </div>
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <div>
                <span className="settings-toggle-label">Enable loyalty rewards</span>
                <span className="settings-toggle-desc">Staff can redeem only the customer’s available, single-use rewards.</span>
              </div>
            </div>
            <button className={`settings-toggle ${loyaltyEnabled ? "active" : ""}`} onClick={() => setLoyaltyEnabled((value) => !value)}>
              <div className="settings-toggle-knob" />
            </button>
          </div>
          <div className="form-row" style={{ marginTop: 18 }}>
            <div className="form-group">
              <label>Discount reward after orders</label>
              <input className="form-control" type="number" min="1" value={loyaltyDiscountMilestone} onChange={(e) => setLoyaltyDiscountMilestone(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Discount percentage</label>
              <input className="form-control" type="number" min="1" max="100" value={loyaltyDiscountPercent} onChange={(e) => setLoyaltyDiscountPercent(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Free 8 kg load after orders</label>
              <input className="form-control" type="number" min="2" value={loyaltyFreeLoadMilestone} onChange={(e) => setLoyaltyFreeLoadMilestone(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Reward expiry (days)</label>
              <input className="form-control" type="number" min="1" value={loyaltyRewardExpiryDays} onChange={(e) => setLoyaltyRewardExpiryDays(e.target.value)} />
            </div>
          </div>
          <div className="settings-pricing-preview">
            <span>Every cycle: order #{loyaltyDiscountMilestone} earns {loyaltyDiscountPercent}% off the entire checkout; order #{loyaltyFreeLoadMilestone} earns one free 8 kg standard load.</span>
          </div>
          <LoadingButton className="btn btn-primary" loading={settingsSaving} loadingLabel="Saving…" onClick={handleSaveBusinessSettings} style={{ marginTop: 12 }}>
            <Save size={15} /> Save Loyalty Program
          </LoadingButton>
        </div>
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
