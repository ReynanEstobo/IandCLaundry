import { differenceInDays, format, startOfToday } from "date-fns";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Brain,
  CheckCircle2,
  Clock,
  PhilippinePeso,
  Lightbulb,
  Package,
  ShoppingBag,
  ShoppingCart,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { supabase } from "../lib/supabase";
import { useRealtime } from "../lib/useRealtime";
import { generateDecisionSupport } from "../services/geminiService";
import { PageError, PageLoader } from "../components/AsyncState";
import { compareOrdersForList } from "../utils/orderListPriority";
import { paymentTimestamp, recordedPaymentAmount, rollingDemandForecast } from "../utils/businessForecast";

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    todayOrders: 0,
    todayRevenue: 0,
    totalCustomers: 0,
    activeOrders: 0,
    readyForPickup: 0,
    lowStockItems: 0,
  });
  const [recentOrders, setRecentOrders] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [aiInsights, setAiInsights] = useState("");
  const [currentAIModel, setCurrentAIModel] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [chartLoading, setChartLoading] = useState(true);
  const [weeklyData, setWeeklyData] = useState([]);
  const [settings, setSettings] = useState({});
  const [range, setRange] = useState("weekly");
  const [suggestions, setSuggestions] = useState([]);
  const [forecasts, setForecasts] = useState(null);
  const [overviewAlertPage, setOverviewAlertPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [aiUsage, setAiUsage] = useState({ count: 0, limit: 20 });

  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [totalCount, setTotalCount] = useState(0);

  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const isFirstDashboardEffect = useRef(true);

  useEffect(() => {
    // The one-time effect below performs the initial load with AI insights.
    // Skip this effect's first run so the same dashboard queries are not doubled.
    if (isFirstDashboardEffect.current) {
      isFirstDashboardEffect.current = false;
      return;
    }
    loadDashboard(false);
  }, [range, page]);

  useEffect(() => {
    loadDashboard(true); // ✅ run AI only once
  }, []);

  // Realtime: refresh dashboard when orders or inventory change
  const loadDashboardCb = useCallback(() => loadDashboard(false), []);
  useRealtime(["orders", "customers", "inventory_items"], loadDashboardCb);

  function buildChartData(orders, payments, range) {
    const data = [];
    const now = new Date();

    if (range === "weekly") {
      for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(now.getDate() - i);

        const dayOrders = orders.filter(
          (o) => new Date(o.created_at).toDateString() === date.toDateString(),
        );

        data.push({
          label: format(date, "EEE, MMM d"),
          fullDate: format(date, "EEEE, MMMM d, yyyy"),
          orders: dayOrders.length,
          revenue: payments.filter(payment => new Date(paymentTimestamp(payment)).toDateString() === date.toDateString())
            .reduce((sum, payment) => sum + recordedPaymentAmount(payment), 0),
        });
      }
    }
    if (range === "monthly") {
      for (let i = 29; i >= 0; i--) {
        const date = new Date();
        date.setDate(now.getDate() - i);

        const dayOrders = orders.filter(
          (o) => new Date(o.created_at).toDateString() === date.toDateString(),
        );

        data.push({
          label: format(date, "MMM d"),
          fullDate: format(date, "EEEE, MMMM d, yyyy"),
          orders: dayOrders.length,
          revenue: payments.filter(payment => new Date(paymentTimestamp(payment)).toDateString() === date.toDateString())
            .reduce((sum, payment) => sum + recordedPaymentAmount(payment), 0),
        });
      }
    }

    if (range === "yearly") {
      const currentYear = new Date().getFullYear();
      const startYear = currentYear - 4; // 🔥 last 5 years only

      for (let year = startYear; year <= currentYear; year++) {
        const yearOrders = orders.filter(
          (o) => new Date(o.created_at).getFullYear() === year,
        );

        data.push({
          label: String(year),
          orders: yearOrders.length,
          revenue: payments.filter(payment => new Date(paymentTimestamp(payment)).getFullYear() === year)
            .reduce((sum, payment) => sum + recordedPaymentAmount(payment), 0),
        });
      }
    }

    return data;
  }

  async function loadDashboard(runAI = true) {
    if (isInitialLoad) setLoading(true);
    setChartLoading(true);
    setLoadError("");
    setIsInitialLoad(false);
    try {
    const today = startOfToday().toISOString();

    const [
      ordersRes,
      customersRes,
      inventoryRes,
      recentRes,
      usageRes,
      paymentsRes,
    ] = await Promise.all([
      supabase.from("orders").select("*"),
      supabase.from("customers").select("id", { count: "exact", head: true }),
      supabase.from("inventory_items").select("*"),
      supabase
        .from("orders")
        .select("*, customers(name, phone), service_types(name)", {
          count: "exact",
        })
        // ✅ ADD THIS
        .order("status", { ascending: true }) // NOT released first
        .order("created_at", { ascending: true }) // oldest first
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1),
      supabase
        .from("inventory_usage_log")
        .select("*")
        .order("logged_at", { ascending: false })
        .limit(500),
      supabase.from("payments").select("amount, paid_at, payment_date"),
    ]);
    const { data: settingsData } = await supabase
      .from("settings")
      .select("*")
      .single();

    const requestError = ordersRes.error || customersRes.error || inventoryRes.error || recentRes.error || usageRes.error || paymentsRes.error;
    if (requestError) throw requestError;

    setSettings(settingsData || {});

    const orders = ordersRes.data || [];
    const inventory = inventoryRes.data || [];
    const usageLogs = usageRes.data || [];
    const payments = paymentsRes.data || [];
    const reportableOrders = orders.filter((o) => o.status !== "cancelled");
    const todayOrders = reportableOrders.filter((o) => o.created_at >= today);
    const todayRevenue = payments
      .filter(payment => new Date(paymentTimestamp(payment)) >= new Date(today))
      .reduce((sum, payment) => sum + recordedPaymentAmount(payment), 0);
    const activeOrders = orders.filter(
      (o) => !["released", "cancelled"].includes(o.status),
    ).length;
    const readyForPickup = orders.filter((o) => o.status === "ready").length;
    const lowStockItems = inventory.filter(
      (i) => Number(i.current_stock) <= Number(i.minimum_stock),
    ).length;

    setStats({
      todayOrders: todayOrders.length,
      todayRevenue,
      totalCustomers: customersRes.count || 0,
      activeOrders,
      readyForPickup,
      lowStockItems,
    });

    const sorted = [...(recentRes.data || [])].sort(compareOrdersForList);

    setRecentOrders(sorted);

    setTotalCount(recentRes.count || 0);
    // Generate smart suggestions
    const tips = generateSuggestions(
      inventory,
      usageLogs,
      orders,
      readyForPickup,
    );
    setSuggestions(tips);

    // Generate AI forecasts
    const fc = generateForecasts(orders, payments, inventory, usageLogs);
    setForecasts(fc);
    setOverviewAlertPage(0);
    // Charts are ready as soon as the filtered operational data is ready.
    // Do not keep them blocked by the separate Gemini/DSS request below.
    setWeeklyData(buildChartData(orders, payments, range));
    setChartLoading(false);

    // 🔥 GEMINI AI (Decision Support Layer)
    // 🔥 Gemini AI (Decision Support Layer - optimized)
    if (runAI && !aiInsights.length) {
      try {
        setAiLoading(true);
        const reportableOrders = orders.filter((order) => order.status !== "cancelled");
        const dssResult = await generateDecisionSupport({
          metrics: {
            totalRevenue: todayRevenue,
            totalExpenses: 0,
            profit: todayRevenue,
            totalOrders: reportableOrders.length,
            averageOrderValue: reportableOrders.length
              ? todayRevenue / reportableOrders.length
              : 0,
            operationalSignals: [
              `${activeOrders} active orders and ${readyForPickup} orders ready for pickup.`,
              `${lowStockItems} low-stock inventory items.`,
              `Forecast workload today: ${fc.workloadLevel}. ${fc.workloadSummary}.`,
              `Forecast monthly revenue: ₱${fc.predictedMonthlyRevenue.toLocaleString()}.`,
            ],
          },
          trendData: buildChartData(reportableOrders, payments, range),
          forecastData: [{ date: "next-month", predictedRevenue: fc.predictedMonthlyRevenue, predictedOrders: Math.round(fc.avgDailyOrders * 30) }],
          branch: "All branches",
          range,
        });
        const labels = ["Operational Recommendation", "Inventory Recommendation", "Revenue Improvement Idea"];
        const normalizedInsights = (Array.isArray(dssResult.insights) ? dssResult.insights : [])
          .map((insight, index) => `${labels[index] || insight.title || "Recommendation"}: ${insight.description || "No recommendation is available."}`)
          .join("\n");
        setAiInsights(normalizedInsights || "Operational Recommendation: No decision-support recommendation is available for the current data.");
        setCurrentAIModel(dssResult.model || "AI decision support");
      } catch (error) {
        console.error("AI error:", error);
        setAiInsights("Operational Recommendation: The recommendation service could not be reached. Operational dashboard data remains available.");
        setCurrentAIModel("Service unavailable");
      } finally {
        setAiLoading(false);
      }
    }

    } catch (error) {
      setLoadError(error.message || "Unable to load dashboard data.");
    } finally {
      setLoading(false);
      setChartLoading(false);
    }
  }

  function generateForecasts(orders, payments, inventory, usageLogs) {
    const baseline = rollingDemandForecast(orders, payments);

    // --- Restock predictions ---
    const restockAlerts = [];
    inventory.forEach((item) => {
      const itemLogs = usageLogs.filter((l) => l.item_id === item.id);
      if (itemLogs.length >= 2) {
        const sorted = [...itemLogs].sort(
          (a, b) => new Date(a.logged_at) - new Date(b.logged_at),
        );
        const daysDiff = Math.max(
          differenceInDays(
            new Date(sorted[sorted.length - 1].logged_at),
            new Date(sorted[0].logged_at),
          ),
          1,
        );
        const totalUsed = itemLogs.reduce(
          (s, l) => s + Number(l.quantity_used),
          0,
        );
        const dailyUsage = totalUsed / daysDiff;
        if (dailyUsage > 0) {
          const daysLeft = Math.floor(Number(item.current_stock) / dailyUsage);
          if (daysLeft <= 14) {
            const suggestedReorder = Math.ceil(dailyUsage * 30);
            restockAlerts.push({
              name: item.name,
              daysLeft,
              unit: item.unit,
              suggestedReorder,
              currentStock: Number(item.current_stock),
            });
          }
        }
      }
    });
    restockAlerts.sort((a, b) => a.daysLeft - b.daysLeft);

    return {
      ...baseline,
      restockAlerts: restockAlerts.slice(0, 3),
      avgDailyOrders: Math.round(baseline.averageDailyOrders),
    };
  }

  function generateSuggestions(inventory, usageLogs, orders, readyCount) {
    const tips = [];

    // 1. Low stock / out of stock items - suggest buying
    const lowItems = inventory.filter(
      (i) => Number(i.current_stock) <= Number(i.minimum_stock),
    );
    const outOfStock = inventory.filter((i) => Number(i.current_stock) === 0);

    if (outOfStock.length > 0) {
      tips.push({
        type: "critical",
        icon: AlertTriangle,
        title: "Out of Stock!",
        message: `Buy ${outOfStock.map((i) => i.name).join(", ")} immediately — you have zero stock remaining.`,
        action: "Go to Inventory",
        link: "/dashboard/inventory",
      });
    }

    if (lowItems.length > 0 && outOfStock.length !== lowItems.length) {
      const needRestock = lowItems.filter((i) => Number(i.current_stock) > 0);
      if (needRestock.length > 0) {
        tips.push({
          type: "critical",
          icon: ShoppingCart,
          title: "Restock Needed",
          message: `Running low on ${needRestock.map((i) => `${i.name} (${i.current_stock} ${i.unit} left)`).join(", ")}. Consider restocking soon.`,
          action: "Restock Now",
          link: "/dashboard/inventory",
        });
      }
    }

    // 2. Stock prediction - items that will run out within 7 days
    inventory.forEach((item) => {
      const itemLogs = usageLogs.filter((l) => l.item_id === item.id);
      if (itemLogs.length >= 2) {
        const sorted = [...itemLogs].sort(
          (a, b) => new Date(a.logged_at) - new Date(b.logged_at),
        );
        const daysDiff = Math.max(
          differenceInDays(
            new Date(sorted[sorted.length - 1].logged_at),
            new Date(sorted[0].logged_at),
          ),
          1,
        );
        const totalUsed = itemLogs.reduce(
          (s, l) => s + Number(l.quantity_used),
          0,
        );
        const dailyUsage = totalUsed / daysDiff;
        if (dailyUsage > 0) {
          const daysLeft = Math.floor(Number(item.current_stock) / dailyUsage);
          if (
            daysLeft <= 7 &&
            daysLeft > 0 &&
            !lowItems.find((l) => l.id === item.id)
          ) {
            tips.push({
              type: "critical",
              icon: TrendingUp,
              title: `${item.name} Running Out`,
              message: `Based on usage trends, ${item.name} will run out in ~${daysLeft} day${daysLeft !== 1 ? "s" : ""}. Buy more to avoid shortage.`,
              action: "View Predictions",
              link: "/dashboard/inventory",
            });
          }
        }
      }
    });

    // 3. Ready for pickup - notify customers
    if (readyCount > 0) {
      tips.push({
        type: "info",
        icon: Bell,
        title: `${readyCount} Order${readyCount > 1 ? "s" : ""} Ready for Pickup`,
        message: `Send Email notifications to customers about their completed laundry. Don't keep them waiting!`,
        action: "Send Notifications",
        link: "/dashboard/sms",
      });
    }

    // 4. Unpaid orders
    const unpaidOrders = orders.filter(
      (o) => o.payment_status === "unpaid" && o.status !== "cancelled",
    );
    if (unpaidOrders.length > 0) {
      const unpaidTotal = unpaidOrders.reduce(
        (s, o) => s + Number(o.total_price),
        0,
      );
      tips.push({
        type: "warning",
        icon: PhilippinePeso,
        title: `${unpaidOrders.length} Unpaid Order${unpaidOrders.length > 1 ? "s" : ""}`,
        message: `You have ₱${unpaidTotal.toLocaleString()} in outstanding payments. Follow up with customers to collect.`,
        action: "View Orders",
        link: "/dashboard/orders",
      });
    }

    // 5. No inventory set up yet
    if (inventory.length === 0) {
      tips.push({
        type: "info",
        icon: Package,
        title: "Set Up Your Inventory",
        message:
          "Add your supplies like detergent sachets, fabric softener, plastic bags, and hangers to track stock levels and get restock alerts.",
        action: "Add Items",
        link: "/dashboard/inventory",
      });
    }

    // 6. If everything is fine
    if (tips.length === 0) {
      tips.push({
        type: "success",
        icon: CheckCircle2,
        title: "All Good!",
        message:
          "Everything is running smoothly. Inventory is stocked, no pending actions needed.",
        action: null,
        link: null,
      });
    }

    return tips;
  }

  function getStatusColor(status) {
    return `badge badge-${status}`;
  }

  function getEstimatedReady(order) {
    if (!order.estimated_ready_at) return "ETA unavailable";
    return new Date(order.estimated_ready_at).toLocaleString("en-PH", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  }

  if (loading) return <PageLoader label="Loading dashboard…" />;
  if (loadError) return <PageError message={loadError} onRetry={() => loadDashboard(false)} />;

  const restockAlertCount = forecasts?.restockAlerts?.length || 0;
  const activeRestockAlert = restockAlertCount
    ? forecasts.restockAlerts[Math.min(overviewAlertPage, restockAlertCount - 1)]
    : null;

  return (
    <>
      <div className="stats-grid">
        <div className="stat-card blue">
          <div className="stat-icon">
            <ShoppingBag size={22} />
          </div>
          <div className="stat-value">{stats.todayOrders}</div>
          <div className="stat-label">Today's Orders</div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon">
            <PhilippinePeso size={22} />
          </div>
          <div className="stat-value">
            ₱{stats.todayRevenue.toLocaleString()}
          </div>
          <div className="stat-label">Today's Revenue</div>
        </div>
        <div className="stat-card cyan">
          <div className="stat-icon">
            <Users size={22} />
          </div>
          <div className="stat-value">{stats.totalCustomers}</div>
          <div className="stat-label">Total Customers</div>
        </div>
        <div className="stat-card amber">
          <div className="stat-icon">
            <Clock size={22} />
          </div>
          <div className="stat-value">{stats.activeOrders}</div>
          <div className="stat-label">Active Orders</div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon">
            <CheckCircle2 size={22} />
          </div>
          <div className="stat-value">{stats.readyForPickup}</div>
          <div className="stat-label">Ready for Pickup</div>
        </div>
        <div className="stat-card red">
          <div className="stat-icon">
            <AlertTriangle size={22} />
          </div>
          <div className="stat-value">{stats.lowStockItems}</div>
          <div className="stat-label">Low Stock Items</div>
        </div>
      </div>

      {/* Smart Suggestions */}
      {suggestions.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Lightbulb size={18} style={{ color: "#f59e0b" }} />
              Suggestions & Alerts
            </h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {suggestions.map((tip, idx) => {
              const TipIcon = tip.icon;
              const colors = {
                critical: {
                  bg: "#fee2e2",
                  border: "#fecaca",
                  icon: "#991b1b",
                  text: "#991b1b",
                },
                warning: {
                  bg: "#fffbeb",
                  border: "#fde68a",
                  icon: "#d97706",
                  text: "#92400e",
                },
                info: {
                  bg: "#eef8fd",
                  border: "#b3e0f5",
                  icon: "#2EA7E0",
                  text: "#1a7da8",
                },
                success: {
                  bg: "#ecfdf5",
                  border: "#a7f3d0",
                  icon: "#059669",
                  text: "#065f46",
                },
              };
              const c = colors[tip.type] || colors.info;
              return (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "14px 16px",
                    borderRadius: 10,
                    background: c.bg,
                    border: `1px solid ${c.border}`,
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: "white",
                      border: `1px solid ${c.border}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <TipIcon size={18} style={{ color: c.icon }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        color: c.text,
                        marginBottom: 2,
                      }}
                    >
                      {tip.title}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "#4b5563",
                        lineHeight: 1.5,
                      }}
                    >
                      {tip.message}
                    </div>
                  </div>
                  {tip.action && tip.link && (
                    <button
                      className="btn btn-sm"
                      onClick={() => navigate(tip.link)}
                      style={{
                        background: "white",
                        border: `1px solid ${c.border}`,
                        color: c.text,
                        fontWeight: 600,
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      {tip.action} <ArrowRight size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <section className="dashboard-workspace">
        <aside className="dashboard-workspace-sidebar">
        {/* AI Forecasting Overview */}
      {forecasts && (
        <div className="card dashboard-overview-card">
          <div className="card-header dashboard-overview-header">
            <h3 className="dashboard-overview-title">
              <Brain size={18} style={{ color: "#8b5cf6" }} />
              <span>Decision Support<br />Overview</span>
            </h3>
            <span
              className="badge"
              style={{ background: "#f3f0ff", color: "#7c3aed", fontSize: 11 }}
            >
              <Zap size={12} /> Predictions
            </span>
          </div>
          <div className="dashboard-overview-body">
            <div className="dashboard-forecast-summary">
              <div className="dashboard-forecast-metric workload">
                <span>Expected workload today</span>
                <strong>{forecasts.workloadLevel}</strong>
                <small>{forecasts.workloadSummary}</small>
              </div>
              <div className="dashboard-forecast-metric peak">
                <span>Likely peak day</span>
                <strong>{forecasts.peakDay}</strong>
                <small>Plan staffing ahead</small>
              </div>
            </div>

            {/* Predicted Revenue */}
            <div className="forecast-row forecast-revenue overview-revenue">
              <div
                className="forecast-icon-wrap"
                style={{
                  background: "rgba(16,185,129,0.12)",
                  color: "#10b981",
                }}
              >
                <TrendingUp size={20} />
              </div>
              <div className="forecast-content">
                <span className="forecast-label">Predicted revenue</span>
                <strong className="forecast-value" style={{ color: "#10b981" }}>
                  ₱{forecasts.predictedMonthlyRevenue.toLocaleString()}
                </strong>
                <span className="forecast-sublabel">Based on received payments in the last 30 days</span>
                {forecasts.revenueTrend !== 0 && (
                  <span
                    className={`forecast-trend ${forecasts.revenueTrend > 0 ? "up" : "down"}`}
                  >
                    {forecasts.revenueTrend > 0 ? "↑" : "↓"}{" "}
                    {Math.abs(forecasts.revenueTrend)}%
                  </span>
                )}
              </div>
            </div>

            {/* Restock Alerts */}
            {activeRestockAlert && (
              <>
                <div className="forecast-row forecast-restock overview-restock">
                  <div
                    className="forecast-icon-wrap"
                    style={{
                      background: "#fee2e2",
                      color: "#991b1b",
                    }}
                  >
                    <AlertTriangle size={20} />
                  </div>
                  <div className="forecast-content">
                    <span className="forecast-label">Restock alert</span>
                    <span className="forecast-restock-text">
                      <strong>{activeRestockAlert.name}</strong> will run out in{" "}
                      <strong>
                        {activeRestockAlert.daysLeft} day{activeRestockAlert.daysLeft !== 1 ? "s" : ""}
                      </strong>
                    </span>
                    <span className="forecast-sublabel">
                      Reorder ~{activeRestockAlert.suggestedReorder} {activeRestockAlert.unit}
                    </span>
                  </div>
                  <button
                    className="btn btn-sm"
                    onClick={() => navigate("/dashboard/inventory")}
                    style={{ flexShrink: 0, fontSize: 12 }}
                  >
                    Restock <ArrowRight size={13} />
                  </button>
                </div>
                {restockAlertCount > 1 && (
                  <div className="overview-pagination" aria-label="Restock alert pagination">
                    <button
                      type="button"
                      className="overview-pagination-button"
                      onClick={() => setOverviewAlertPage((current) => Math.max(0, current - 1))}
                      disabled={overviewAlertPage === 0}
                    >
                      Previous
                    </button>
                    <span>Alert {overviewAlertPage + 1} of {restockAlertCount}</span>
                    <button
                      type="button"
                      className="overview-pagination-button"
                      onClick={() => setOverviewAlertPage((current) => Math.min(restockAlertCount - 1, current + 1))}
                      disabled={overviewAlertPage >= restockAlertCount - 1}
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
        </aside>
        <div className="dashboard-workspace-content">
      {(aiLoading || aiInsights.length > 0) && (
        <section className="dashboard-ai-card">
          <header className="dashboard-ai-header">
            <div className="dashboard-ai-heading">
              <span className="dashboard-ai-brain"><Brain size={20} /></span>
              <div><h3>AI Decision Support</h3><p>Recommendations based on the current operational snapshot</p></div>
            </div>
            <span className="dashboard-ai-model">{currentAIModel || "Preparing analysis"}</span>
          </header>

          {/* CONTENT */}
          {aiLoading ? (
            // 🔥 LOADING SKELETON
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    height: 60,
                    borderRadius: 12,
                    background:
                      "linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%)",
                    backgroundSize: "200% 100%",
                    animation: "shimmer 1.5s infinite",
                  }}
                />
              ))}
            </div>
          ) : (
            // 🔥 YOUR EXISTING AI CONTENT
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {aiInsights
                .split(
                  /(?=Operational Recommendation:|Inventory Recommendation:|Revenue Improvement Idea:)/,
                )
                .map((line, i) => {
                  if (!line.trim()) return null;

                  const clean = line.replace(/\*\*/g, "").trim();

                  let icon = Lightbulb;
                  let color = "#8b5cf6";
                  let bg = "#faf5ff";

                  if (clean.toLowerCase().includes("operational")) {
                    icon = Zap;
                    color = "#3b82f6";
                    bg = "#eff6ff";
                  } else if (clean.toLowerCase().includes("inventory")) {
                    icon = Package;
                    color = "#f59e0b";
                    bg = "#fffbeb";
                  } else if (clean.toLowerCase().includes("revenue")) {
                    icon = TrendingUp;
                    color = "#10b981";
                    bg = "#ecfdf5";
                  }

                  const Icon = icon;

                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        gap: 12,
                        padding: "14px 16px",
                        borderRadius: 12,
                        background: bg,
                        border: "1px solid rgba(0,0,0,0.05)",
                      }}
                    >
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          background: "white",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon size={18} style={{ color }} />
                      </div>

                      <div>
                        <div style={{ fontWeight: 600, color }}>
                          {clean.split(":")[0]}
                        </div>
                        <div style={{ fontSize: 13.5, color: "#374151" }}>
                          {clean.split(":").slice(1).join(":")}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </section>
      )}
      <div style={{ marginBottom: 10 }}>
        {["weekly", "monthly", "yearly"].map((r) => (
          <button
            key={r}
            className={`btn btn-sm ${range === r ? "btn-primary" : ""}`}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
      </div>

      <div className="charts-grid">
        {chartLoading ? (
          ["orders", "revenue"].map((chart) => (
            <div className="card dashboard-chart-loading" key={chart}>
              <div className="dashboard-chart-loading-header"><span className="dashboard-chart-loading-title" /><span className="dashboard-chart-loading-chip" /></div>
              <div className="dashboard-chart-loading-body">
                <span className="dashboard-chart-axis y" />
                <div className="dashboard-chart-bars">{[38, 62, 48, 78, 55, 86, 68].map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}</div>
                <span className="dashboard-chart-axis x" />
              </div>
              <p>Updating {range} chart…</p>
            </div>
          ))
        ) : (
          <>
        <div className="card">
          <div className="card-header">
            <h3>{range.charAt(0).toUpperCase() + range.slice(1)} Orders</h3>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={weeklyData}>
              <XAxis
                dataKey="label"
                stroke="#64748b"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#64748b"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                labelFormatter={(label, payload) => payload?.[0]?.payload?.fullDate || label}
                contentStyle={{
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  color: "#111827",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
                  fontSize: 13,
                }}
              />
              <Bar dataKey="orders" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>
              {range.charAt(0).toUpperCase() + range.slice(1)} Revenue Trend
            </h3>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={weeklyData}>
              <defs>
                <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="label"
                stroke="#9ca3af"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#9ca3af"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                labelFormatter={(label, payload) => payload?.[0]?.payload?.fullDate || label}
                contentStyle={{
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  color: "#111827",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
                  fontSize: 13,
                }}
                formatter={(value) => [`₱${value.toLocaleString()}`, "Revenue"]}
              />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="#10b981"
                fill="url(#revenueGrad)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Recent Orders</h3>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Order #</th>
                <th>Customer</th>

                <th>Status</th>
                <th>Estimated Ready</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {recentOrders.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{
                      textAlign: "center",
                      padding: 40,
                      color: "var(--text-muted)",
                    }}
                  >
                    No orders yet
                  </td>
                </tr>
              ) : (
                recentOrders.map((order) => (
                  <tr key={order.id}>
                    <td
                      style={{ fontWeight: 600, color: "var(--text-primary)" }}
                    >
                      {order.order_number}
                    </td>
                    <td>{order.customers?.name || "Walk-in"}</td>

                    <td>
                      <span className={getStatusColor(order.status)}>
                        {order.status.replace("_", " ")}
                      </span>
                    </td>
                    <td>
                      {order.status === "released" ||
                      order.status === "cancelled" ? (
                        "—"
                      ) : (
                        <span
                          style={{
                            color: "var(--primary-light)",
                            fontWeight: 600,
                          }}
                        >
                          <span>
                            {getEstimatedReady(order)}
                          </span>
                        </span>
                      )}
                    </td>
                    <td
                      style={{ fontWeight: 600, color: "var(--text-primary)" }}
                    >
                      ₱{Number(order.total_price).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div style={{ marginTop: 14, textAlign: "center" }}>
            {/* PAGINATION BUTTONS */}
            <div
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
                style={{
                  opacity: page === 0 ? 0.4 : 1,
                  padding: "6px 10px",
                }}
              >
                «
              </button>

              {/* PREVIOUS */}
              <button
                className="btn btn-sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(p - 1, 0))}
                style={{
                  opacity: page === 0 ? 0.4 : 1,
                  padding: "6px 10px",
                }}
              >
                ‹
              </button>

              {/* PAGE NUMBERS */}
              {(() => {
                const pages = [];

                if (totalPages === 0) return null;

                // Always show max 3 pages
                let start = Math.max(0, page - 1);
                let end = Math.min(totalPages, start + 3);

                // Adjust if near end
                if (end - start < 3) {
                  start = Math.max(0, end - 3);
                }

                for (let i = start; i < end; i++) {
                  const isActive = i === page;

                  pages.push(
                    <button
                      key={i}
                      onClick={() => setPage(i)}
                      style={{
                        minWidth: 36,
                        height: 36,
                        borderRadius: 8,
                        border: isActive
                          ? "1px solid #64748b"
                          : "1px solid transparent",
                        background: isActive ? "#1e293b" : "transparent",
                        color: isActive ? "#fff" : "#94a3b8",
                        fontWeight: 600,
                        transition: "all 0.2s ease",
                        cursor: "pointer",
                      }}
                    >
                      {i + 1}
                    </button>,
                  );
                }

                return pages;
              })()}
              {/* NEXT */}
              <button
                className="btn btn-sm"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => (p + 1 < totalPages ? p + 1 : p))}
                style={{
                  opacity: page + 1 >= totalPages ? 0.4 : 1,
                  padding: "6px 10px",
                }}
              >
                ›
              </button>

              {/* LAST */}
              <button
                className="btn btn-sm"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage(totalPages - 1)}
                style={{
                  opacity: page + 1 >= totalPages ? 0.4 : 1,
                  padding: "6px 10px",
                }}
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
        </div>
      </div>
        </div>
      </section>
    </>
  );
}
