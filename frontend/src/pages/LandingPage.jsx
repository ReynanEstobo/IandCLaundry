import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  Circle,
  Clock,
  Loader2,
  Mail,
  MapPin,
  Package,
  Phone,
  Search,
  Send,
  Shield,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { apiFetch } from "../services/api/client";
import LandingChatbot from "../components/LandingChatbot";
import FacebookIcon from "../components/FacebookIcon";
import { isValidPhilippineMobile, normalizePhone } from "../utils/validation";

function useScrollReveal(threshold = 0.15) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          obs.unobserve(el);
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, visible];
}

function AnimatedCounter({ end, suffix = "", duration = 2000 }) {
  const [count, setCount] = useState(0);
  const [ref, visible] = useScrollReveal(0.5);
  useEffect(() => {
    if (!visible) return;
    let start = 0;
    const step = end / (duration / 16);
    const timer = setInterval(() => {
      start += step;
      if (start >= end) {
        setCount(end);
        clearInterval(timer);
      } else setCount(Math.floor(start));
    }, 16);
    return () => clearInterval(timer);
  }, [visible, end, duration]);
  return (
    <strong ref={ref}>
      {count}
      {suffix}
    </strong>
  );
}

/* ─── Modern Toast Component ─────────────────────────────────────────── */
function Toast({ show, type, message, onClose }) {
  const isSuccess = type === "success";

  const styles = {
    wrapper: {
      position: "fixed",
      top: "24px",
      right: "24px",
      zIndex: 9999,
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      pointerEvents: show ? "auto" : "none",
    },
    toast: {
      display: "flex",
      alignItems: "flex-start",
      gap: "12px",
      padding: "14px 16px",
      borderRadius: "14px",
      background: "rgba(15, 15, 20, 0.82)",
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      border: `1px solid ${isSuccess ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)"}`,
      boxShadow: `0 8px 32px rgba(0,0,0,0.35), 0 0 0 1px ${isSuccess ? "rgba(52,211,153,0.08)" : "rgba(248,113,113,0.08)"}`,
      minWidth: "300px",
      maxWidth: "380px",
      transform: show
        ? "translateX(0) scale(1)"
        : "translateX(calc(100% + 32px)) scale(0.96)",
      opacity: show ? 1 : 0,
      transition:
        "transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.28s ease",
      overflow: "hidden",
      position: "relative",
    },
    iconWrap: {
      flexShrink: 0,
      width: "34px",
      height: "34px",
      borderRadius: "50%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: isSuccess
        ? "rgba(52,211,153,0.15)"
        : "rgba(248,113,113,0.15)",
      color: isSuccess ? "#34d399" : "#f87171",
      marginTop: "1px",
    },
    content: {
      flex: 1,
      display: "flex",
      flexDirection: "column",
      gap: "2px",
    },
    label: {
      fontSize: "11px",
      fontWeight: 600,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: isSuccess ? "#34d399" : "#f87171",
    },
    message: {
      fontSize: "13.5px",
      color: "rgba(255,255,255,0.88)",
      lineHeight: 1.45,
    },
    closeBtn: {
      flexShrink: 0,
      background: "none",
      border: "none",
      cursor: "pointer",
      color: "rgba(255,255,255,0.35)",
      padding: "2px",
      borderRadius: "6px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      transition: "color 0.15s, background 0.15s",
      lineHeight: 1,
    },
    progressBar: {
      position: "absolute",
      bottom: 0,
      left: 0,
      height: "2px",
      background: isSuccess
        ? "linear-gradient(90deg, #34d399, #6ee7b7)"
        : "linear-gradient(90deg, #f87171, #fca5a5)",
      borderRadius: "0 0 14px 14px",
      animation: show ? "toastProgress 3s linear forwards" : "none",
    },
  };

  return (
    <>
      <style>{`
        @keyframes toastProgress {
          from { width: 100%; }
          to   { width: 0%; }
        }
        .toast-close-btn:hover {
          color: rgba(255,255,255,0.75) !important;
          background: rgba(255,255,255,0.08) !important;
        }
      `}</style>
      <div style={styles.wrapper}>
        <div style={styles.toast} role="alert" aria-live="polite">
          <div style={styles.iconWrap}>
            {isSuccess ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 8.5l3.5 3.5 6.5-7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 5v4M8 11.5v.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <circle
                  cx="8"
                  cy="8"
                  r="6.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            )}
          </div>
          <div style={styles.content}>
            <span style={styles.label}>{isSuccess ? "Success" : "Error"}</span>
            <span style={styles.message}>{message}</span>
          </div>
          <button
            style={styles.closeBtn}
            className="toast-close-btn"
            onClick={onClose}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
          <div style={styles.progressBar} />
        </div>
      </div>
    </>
  );
}

/* ─── Spinner SVG ─────────────────────────────────────────────────────── */
function Spinner({ size = 16 }) {
  return <Loader2 size={size} className="button-spinner" aria-hidden="true" />;
}

export default function LandingPage() {
  const navigate = useNavigate();
  const [showTopBtn, setShowTopBtn] = useState(false);

  const [notification, setNotification] = useState({
    show: false,
    type: "",
    message: "",
  });
  const [sending, setSending] = useState(false);
  const [settings, setSettings] = useState({});
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    message: "",
  });
  const [scrolled, setScrolled] = useState(false);
  const [heroRef, heroVisible] = useScrollReveal(0.1);
  const [processRef, processVisible] = useScrollReveal(0.1);
  const [trackRef, trackVisible] = useScrollReveal(0.1);
  const [contactRef, contactVisible] = useScrollReveal(0.1);

  // Garment tracking state
  const [trackOrderId, setTrackOrderId] = useState("");
  const [trackResults, setTrackResults] = useState(null);
  const [trackLoading, setTrackLoading] = useState(false);
  const [trackError, setTrackError] = useState("");
  const [, setTicker] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setTicker((t) => t + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const TRACK_STAGES = [
    "received",
    "on_process",
    "ready",
  ];

  const STAGE_LABELS = {
    received: "Received",
    on_process: "On Process",
    ready: "Ready for pick-up",
    released: "Released",
  };

  const handleTrack = async (e) => {
    if (e) e.preventDefault();
    const cleaned = trackOrderId.trim();
    if (!cleaned) {
      setTrackError("Please enter your order number");
      setTrackResults(null);
      return;
    }
    setTrackLoading(true);
    setTrackError("");
    setTrackResults(null);
    try {
      const { data: orders } = await apiFetch(
        `/api/public/orders/track?q=${encodeURIComponent(cleaned)}`,
      );
      const enriched = (orders || []).map((o) => ({
        ...o,
        service_name: o.order_items?.length
          ? o.order_items.map((item) => item.service_name_snapshot).join(", ")
          : o.service_types?.name || "Service",
      }));
      setTrackResults(enriched.length > 0 ? enriched : null);
      if (enriched.length === 0)
        setTrackError("No orders found for this order number");
    } catch (err) {
      setTrackError(err.message || "Unable to track your order. Please try again.");
    } finally {
      setTrackLoading(false);
    }
  };

  // Poll every 5s + realtime subscription to keep tracking results fresh
  useEffect(() => {
    if (!trackResults || trackResults.length === 0) return;
    const cleaned = trackOrderId.trim();
    if (!cleaned) return;

    const refetch = () => {
      apiFetch(`/api/public/orders/track?q=${encodeURIComponent(cleaned)}`)
        .then(({ data }) => {
          if (data) {
            const enriched = data.map((o) => ({
              ...o,
              service_name: o.order_items?.length
                ? o.order_items.map((item) => item.service_name_snapshot).join(", ")
                : o.service_types?.name || "Service",
            }));
            setTrackResults(enriched.length > 0 ? enriched : null);
          }
        }).catch(() => {
          // Preserve the last result on a temporary polling failure.
        });
    };

    const interval = setInterval(refetch, 5000);
    const channel = supabase
      .channel("track-orders-realtime-" + Date.now())
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders" },
        refetch,
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [trackResults !== null, trackOrderId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let isMounted = true;

    const fetchSettings = async () => {
      const { data } = await supabase.from("settings").select("*").single();
      if (data && isMounted) setSettings(data);
    };

    fetchSettings();

    // 🔥 REALTIME SUBSCRIPTION
    const channel = supabase
      .channel("settings-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "settings" },
        (payload) => {
          if (payload.new) {
            setSettings(payload.new);

            // 🔥 FORCE ETA RECALCULATION
            setSettingsVersion((v) => v + 1);
          }
        },
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, []);
  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 20);
      setShowTopBtn(window.scrollY > 50); // 👈 show button after scroll
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleChange = (e) => {
    const value = e.target.name === "phone" ? normalizePhone(e.target.value) : e.target.value;
    setFormData((prev) => ({ ...prev, [e.target.name]: value }));
  };
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToSection = (e, id) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  /* ── dismiss helper so the close button and auto-dismiss share one path */
  const dismissToast = () =>
    setNotification({ show: false, type: "", message: "" });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.phone && !isValidPhilippineMobile(formData.phone)) {
      setNotification({ show: true, type: "error", message: "Phone number must start with 09 and contain exactly 11 digits." });
      return;
    }
    setSending(true);

    try {
      const data = await apiFetch("/api/public/contact", {
        method: "POST",
        body: JSON.stringify(formData),
      });

      if (data.success) {
        setNotification({
          show: true,
          type: "success",
          message: "Your message was sent! We'll get back to you soon.",
        });
        setFormData({
          name: "",
          email: "",
          phone: "",
          address: "",
          message: "",
        });
      } else {
        setNotification({
          show: true,
          type: "error",
          message: "Failed to send message. Please try again.",
        });
      }
    } catch (err) {
      setNotification({
        show: true,
        type: "error",
        message: "Something went wrong. Please try again.",
      });
    } finally {
      setSending(false);
      setTimeout(dismissToast, 3000);
    }
  };

  return (
    <div className="landing-page">
      {/* ── Modern Toast ── */}
      <Toast
        show={notification.show}
        type={notification.type}
        message={notification.message}
        onClose={dismissToast}
      />

      {/* NAVBAR */}
      <nav className={`landing-nav ${scrolled ? "landing-nav-scrolled" : ""}`}>
        <div className="landing-container landing-nav-inner">
          <div className="landing-logo">
            <img
              src="/assets/Rectangle.png"
              alt="I&C Laundry"
              className="landing-logo-img-nav"
            />
            <span>I&C Laundry</span>
          </div>
          <div className="landing-nav-links">
            <a href="#home" onClick={(e) => scrollToSection(e, "home")}>
              Home
            </a>
            <a href="#process" onClick={(e) => scrollToSection(e, "process")}>
              Process
            </a>
            <a href="#track" onClick={(e) => scrollToSection(e, "track")}>
              Track
            </a>
            <a href="#contact" onClick={(e) => scrollToSection(e, "contact")}>
              Contact
            </a>
            <button
              className="landing-btn-login"
              onClick={() => navigate("/login")}
            >
              Login
              <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </nav>

      {/* HERO SECTION */}
      <section className="landing-hero" id="home">
        <div className="hero-decoration hero-decoration-1" />
        <div className="hero-decoration hero-decoration-2" />
        <div className="hero-decoration hero-decoration-3" />
        <div className="hero-blob" />

        <div className="landing-container landing-hero-inner" ref={heroRef}>
          <div
            className={`landing-hero-text ${heroVisible ? "animate-in" : ""}`}
          >
            <div className="landing-hero-badge">
              <Sparkles size={14} />
              <span>Professional Laundry Service</span>
            </div>
            <h1>
              Simplify Your Life with{" "}
              <span className="text-highlight">I&C Laundry</span> Service
            </h1>
            <p>
              A modern multi-branch laundry management platform designed to
              provide efficient garment tracking, customer service, analytics,
              loyalty rewards, and AI-powered operational insights.
            </p>
            <div className="landing-hero-buttons">
              <button
                className="landing-btn-primary landing-btn-glow"
                onClick={() => navigate("/login")}
              >
                Login
                <ChevronRight size={18} />
              </button>
              <button
                className="landing-btn-secondary"
                onClick={(e) => scrollToSection(e, "track")}
              >
                Track Garment
              </button>
            </div>
          </div>
          <div
            className={`landing-hero-image ${heroVisible ? "animate-in-right" : ""}`}
          >
            <div className="landing-hero-image-bg" />
            <div className="landing-hero-image-ring" />
            <img src="/assets/image%2046.png" alt="I&C Laundry Service" />
            <div className="hero-float-badge hero-float-badge-1">
              <Star size={16} />
              <span>Top Rated</span>
            </div>
            <div className="hero-float-badge hero-float-badge-2">
              <Clock size={16} />
              <span>Fast Service</span>
            </div>
            <div className="hero-float-badge hero-float-badge-3">
              <Shield size={16} />
              <span>Trusted</span>
            </div>
          </div>
        </div>
      </section>

      {/* WORKING PROCESS */}
      <section className="landing-process" id="process" ref={processRef}>
        <div className="landing-container">
          <div
            className={`landing-section-header ${processVisible ? "animate-in" : ""}`}
          >
            <span className="landing-section-tag">How It Works</span>
            <h2>Our Working Process</h2>
            <p>Simple steps to get your clothes fresh and clean</p>
          </div>
          <div
            className={`landing-process-steps ${processVisible ? "steps-animate" : ""}`}
          >
            {[
              {
                img: "/assets/image%2011.png",
                alt: "Walk-in",
                num: "01",
                title: "Walk-in to Store",
                desc: "Visit our store at Paz Street, Brgy. 7, Balayan, Batangas",
              },
              null,
              {
                img: "/assets/image%2014.png",
                alt: "Collection",
                num: "02",
                title: "Laundry Collection",
                desc: "We carefully collect and sort your garments",
              },
              null,
              {
                img: "/assets/image%2013.png",
                alt: "Cleaning",
                num: "03",
                title: "Expert Cleaning",
                desc: "Professional washing, drying, and folding",
              },
              null,
              {
                img: "/assets/image%2012.png",
                alt: "Pickup",
                num: "04",
                title: "Ready for Pickup",
                desc: "Pick up your fresh, clean clothes anytime",
              },
            ].map((item, i) =>
              item === null ? (
                <div className="landing-step-connector" key={`conn-${i}`}>
                  <div className="connector-line" />
                </div>
              ) : (
                <div
                  className="landing-step"
                  key={item.num}
                  style={{ animationDelay: `${parseInt(item.num) * 0.15}s` }}
                >
                  <div className="landing-step-icon">
                    <img src={item.img} alt={item.alt} />
                  </div>
                  <div className="landing-step-number">{item.num}</div>
                  <h3>{item.title}</h3>
                  <p>{item.desc}</p>
                </div>
              ),
            )}
          </div>
        </div>
      </section>

      {/* TRACK GARMENT SECTION */}
      <section className="landing-track" id="track" ref={trackRef}>
        <div className="landing-container">
          <div
            className={`landing-section-header ${trackVisible ? "animate-in" : ""}`}
          >
            <span className="landing-section-tag">Order Status</span>
            <h2>Track Your Garment</h2>
            <p>Enter your order number to check the status of your laundry</p>
          </div>

          <div
            className={`track-search-box ${trackVisible ? "animate-in" : ""}`}
          >
            <form className="track-form" onSubmit={handleTrack}>
              <div className="track-input-wrap">
                <Package size={18} className="track-input-icon" />
                <input
                  type="text"
                  placeholder="Enter order number (e.g. IC-20260327-1234)"
                  value={trackOrderId}
                  onChange={(e) => setTrackOrderId(e.target.value)}
                  required
                />
              </div>
              <button
                type="submit"
                className="landing-btn-primary landing-btn-glow"
                disabled={trackLoading}
              >
                {trackLoading ? (
                  <Loader2 size={18} className="spin" />
                ) : (
                  <Search size={18} />
                )}
                {trackLoading ? "Searching..." : "Track"}
              </button>
            </form>
            {trackError && <p className="track-error">{trackError}</p>}
          </div>

          {Array.isArray(trackResults) &&
            trackResults.map((order) => {
              const normalizedStatus = (order.status || "")
                .toLowerCase()
                .trim();

              const safeStatus = [...TRACK_STAGES, "released"].includes(normalizedStatus)
                ? normalizedStatus
                : "received";

              const currentIdx = safeStatus === "released" ? TRACK_STAGES.length - 1 : TRACK_STAGES.indexOf(safeStatus);

              const eta = order.estimated_ready_at ? new Date(order.estimated_ready_at) : null;

              return (
                <div className="track-card" key={order.order_number}>
                  <div className="track-card-header">
                    <div className="track-card-info">
                      <span className="track-order-num">
                        #{order.order_number}
                      </span>
                    </div>
                    <div className="track-card-meta">
                      <span className="track-service">
                        {order.service_name}
                      </span>
                      <span className="track-weight">{order.weight_kg} kg</span>
                    </div>
                  </div>

                  {/* ✅ PROGRESS BAR */}
                  <div className="track-progress">
                    {TRACK_STAGES.map((stage, i) => {
                      const done = i <= currentIdx;
                      const isCurrent = i === currentIdx;

                      return (
                        <div
                          className={`track-step ${done ? "done" : ""} ${isCurrent ? "current" : ""}`}
                          key={stage}
                        >
                          <div className="track-dot">
                            {done ? (
                              <CheckCircle2 size={16} />
                            ) : (
                              <Circle size={16} />
                            )}
                          </div>

                          {i < TRACK_STAGES.length - 1 && (
                            <div
                              className={`track-line ${
                                done && i < currentIdx ? "filled" : ""
                              }`}
                            />
                          )}

                          <span className="track-label">
                            {STAGE_LABELS[stage] || stage}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* ✅ FOOTER */}
                  <div className="track-card-footer">
                    <span>
                      Status:{" "}
                      <strong className={`status-text status-${safeStatus}`}>
                        {STAGE_LABELS[safeStatus]}
                      </strong>
                    </span>

                    <span>
                      Placed:{" "}
                      {new Date(order.created_at).toLocaleDateString("en-PH", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>

                    {/* ✅ ETA */}
                    {eta && !["ready", "released"].includes(safeStatus) && (
                      <>
                        <span>
                          Estimated ready:{" "}
                          <strong>
                            {eta.toLocaleString("en-PH", {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "numeric",
                            })}
                          </strong>
                        </span>
                        <span>
                          {order.eta_revised_at
                            ? "Updated after a staff correction"
                            : order.eta_source === "historical_service_branch"
                              ? "Based on similar completed orders"
                              : "Based on the branch default"}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      </section>

      {/* CONTACT SECTION */}
      <section className="landing-contact" id="contact" ref={contactRef}>
        <div className="landing-container">
          <div
            className={`landing-section-header ${contactVisible ? "animate-in" : ""}`}
          >
            <span className="landing-section-tag">Get In Touch</span>
            <h2>Reach Out to Us</h2>
            <p>Have questions? We'd love to hear from you.</p>
          </div>
          <div
            className={`landing-contact-grid ${contactVisible ? "animate-in" : ""}`}
          >
            <div className="landing-contact-info">
              <div className="contact-info-glow" />
              <h3>Contact Information</h3>
              <p>Reach out to us through any of these channels</p>
              <div className="landing-contact-items">
                <div className="landing-contact-item">
                  <div className="landing-contact-icon">
                    <Phone size={20} />
                  </div>
                  <div>
                    <strong>Phone</strong>
                    <span>0967-281-3602</span>
                  </div>
                </div>
                <div className="landing-contact-item">
                  <div className="landing-contact-icon">
                    <Mail size={20} />
                  </div>
                  <div>
                    <strong>Email</strong>
                    <span>iclaundryshop@gmail.com</span>
                  </div>
                </div>
                <div className="landing-contact-item">
                  <div className="landing-contact-icon">
                    <MapPin size={20} />
                  </div>
                  <div>
                    <strong>Address</strong>
                    <span>Paz Street, Brgy. 7, Balayan, Batangas</span>
                  </div>
                </div>
                <div className="landing-contact-item">
                  <div className="landing-contact-icon">
                    <FacebookIcon size={20} title="Facebook" />
                  </div>
                  <div>
                    <strong>Facebook</strong>
                    <a href="https://web.facebook.com/profile.php?id=100089597336119" target="_blank" rel="noopener noreferrer">I and C Laundry Hub</a>
                  </div>
                </div>
              </div>
            </div>

            <form className="landing-contact-form" onSubmit={handleSubmit}>
              <div className="landing-form-row">
                <div className="landing-form-group">
                  <label>Name</label>
                  <input
                    type="text"
                    name="name"
                    placeholder="Your Name"
                    value={formData.name}
                    onChange={handleChange}
                    required
                    disabled={sending}
                  />
                </div>
                <div className="landing-form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    name="email"
                    placeholder="Your Email"
                    value={formData.email}
                    onChange={handleChange}
                    required
                    disabled={sending}
                  />
                </div>
              </div>
              <div className="landing-form-row">
                <div className="landing-form-group">
                  <label>Phone</label>
                  <input
                    type="tel"
                    name="phone"
                    placeholder="09171234567"
                    inputMode="numeric"
                    pattern="09[0-9]{9}"
                    maxLength={11}
                    value={formData.phone}
                    onChange={handleChange}
                    disabled={sending}
                  />
                </div>
                <div className="landing-form-group">
                  <label>Address</label>
                  <input
                    type="text"
                    name="address"
                    placeholder="Your Address"
                    value={formData.address}
                    onChange={handleChange}
                    disabled={sending}
                  />
                </div>
              </div>
              <div className="landing-form-group">
                <label>Message</label>
                <textarea
                  name="message"
                  placeholder="Your Message"
                  rows="4"
                  value={formData.message}
                  onChange={handleChange}
                  required
                  disabled={sending}
                />
              </div>

              {/* ── Submit button with loading state ── */}
              <button
                type="submit"
                className="landing-btn-primary landing-btn-glow"
                disabled={sending}
                style={{
                  opacity: sending ? 0.75 : 1,
                  cursor: sending ? "not-allowed" : "pointer",
                  transition: "opacity 0.2s",
                }}
              >
                {sending ? (
                  <>
                    <Spinner size={16} />
                    Sending…
                  </>
                ) : (
                  <>
                    <Send size={16} />
                    Send Message
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="landing-footer">
        <div className="landing-container landing-footer-inner">
          <div className="landing-footer-brand">
            <div className="landing-logo">
              <img
                src="/assets/Rectangle.png"
                alt="I&C Laundry"
                className="landing-logo-img"
              />
              <span>
                <strong>I&C</strong> Laundry
              </span>
            </div>
            <p>
              Laundry service providers offer professionals laundering solutions
              to assist individuals and business in achieving optimal garment
              care and cleanliness
            </p>
          </div>
          <div className="landing-footer-divider" />
          <div className="landing-footer-contact">
            <h4>Contact Info</h4>
            <div className="landing-footer-contact-card">
              <div className="landing-footer-contact-item">
                <Phone size={18} />
                <span>0967-281-3602</span>
              </div>
              <div className="landing-footer-contact-item">
                <Mail size={18} />
                <span>iclaundryshop@gmail.com</span>
              </div>
              <div className="landing-footer-contact-item">
                <MapPin size={18} />
                <span>Paz Street, Brgy. 7, Balayan, Batangas</span>
              </div>
              <a className="landing-footer-contact-item" href="https://web.facebook.com/profile.php?id=100089597336119" target="_blank" rel="noopener noreferrer">
                <FacebookIcon size={18} title="Facebook" />
                <span>Facebook: I and C Laundry Hub</span>
              </a>
            </div>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <div className="landing-container">
            <p>
              Copyright &copy; {new Date().getFullYear()} I&C Laundry. All rights
              reserved
            </p>
          </div>
        </div>
      </footer>
      <LandingChatbot settings={settings} />
      {/* 🔝 Back to Top Button */}
      {showTopBtn && (
        <button className="back-to-top" onClick={scrollToTop}>
          <ChevronUp size={18} />
        </button>
      )}
    </div>
  );
}
