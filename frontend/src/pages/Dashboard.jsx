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
  Loader2,
  Package,
  Radio,
  ShoppingBag,
  ShoppingCart,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useRealtime } from "../lib/useRealtime";
import { generateDecisionSupport } from "../services/geminiService";
import { PageError, PageLoader } from "../components/AsyncState";
import DashboardCharts from "../components/DashboardCharts";
import { compareOrdersForList } from "../utils/orderListPriority";
import { paymentTimestamp, recordedPaymentAmount, rollingDemandForecast } from "../utils/businessForecast";
import { inventoryRunOutLabel, predictInventoryDaysLeft, suggestInventoryReorderQuantity } from "../utils/inventoryForecast";

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
  const [recentLoading, setRecentLoading] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [aiUsage, setAiUsage] = useState({ count: 0, limit: 20 });

  const [totalCount, setTotalCount] = useState(0);

  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasLoadedDashboard = useRef(false);
  const isFirstRangeEffect = useRef(true);
  const isFirstPageEffect = useRef(true);

  useEffect(() => {
    if (isFirstRangeEffect.current) {
      isFirstRangeEffect.current = false;
      return;
    }
    loadDashboard(false, "charts");
  }, [range]);

  useEffect(() => {
    if (isFirstPageEffect.current) {
      isFirstPageEffect.current = false;
      return;
    }
    loadDashboard(false, "recent");
  }, [page]);

  useEffect(() => {
    loadDashboard(true, "initial"); // run AI only once
  }, []);

  // Stream every data source used by the dashboard. useRealtime debounces
  // related transaction events and retains a quiet polling fallback.
  const loadDashboardCb = useCallback(() => loadDashboard(false, "background"), [range, page]);
  useRealtime([
    "orders",
    "order_items",
    "customers",
    "payments",
    "inventory_items",
    "inventory_usage_log",
    "inventory_restocks",
    "service_inventory_requirements",
  ], loadDashboardCb);

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

  async function loadDashboard(runAI = true, scope = "background") {
    const firstLoad = !hasLoadedDashboard.current;
    if (firstLoad || scope === "initial") {
      setLoading(true);
      setChartLoading(true);
      setLoadError("");
    } else if (scope === "charts") {
      setChartLoading(true);
    } else if (scope === "recent") {
      setRecentLoading(true);
    } else {
      setBackgroundRefreshing(true);
    }
    setRefreshError("");
    try {
    const today = startOfToday().toISOString();

    const [
      ordersRes,
      customersRes,
      inventoryRes,
      recentRes,
      usageRes,
      paymentsRes,
      expensesRes,
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
      supabase.from("expenses").select("amount, expense_date"),
    ]);
    const { data: settingsData } = await supabase
      .from("settings")
      .select("*")
      .single();

    const requestError = ordersRes.error || customersRes.error || inventoryRes.error || recentRes.error || usageRes.error || paymentsRes.error || expensesRes.error;
    if (requestError) throw requestError;

    setSettings(settingsData || {});

    const orders = ordersRes.data || [];
    const inventory = inventoryRes.data || [];
    const usageLogs = usageRes.data || [];
    const payments = paymentsRes.data || [];
    const expenses = expensesRes.data || [];
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
    setOverviewAlertPage((current) => Math.min(current, Math.max(0, fc.restockAlerts.length - 1)));
    // Charts are ready as soon as the filtered operational data is ready.
    // Do not keep them blocked by the separate Gemini/DSS request below.
    setWeeklyData(buildChartData(orders, payments, range));
    hasLoadedDashboard.current = true;
    setLoading(false);
    if (firstLoad || scope === "initial" || scope === "charts") setChartLoading(false);

    // 🔥 GEMINI AI (Decision Support Layer)
    // 🔥 Gemini AI (Decision Support Layer - optimized)
    if (runAI && !aiInsights.length) {
      try {
        setAiLoading(true);
        const reportableOrders = orders.filter((order) => order.status !== "cancelled");
        const trendData = buildChartData(reportableOrders, payments, range);
        const periodRevenue = trendData.reduce((sum, point) => sum + Number(point.revenue || 0), 0);
        const periodOrders = trendData.reduce((sum, point) => sum + Number(point.orders || 0), 0);
        const now = new Date();
        const periodStart = new Date(now);
        if (range === "weekly") periodStart.setDate(now.getDate() - 6);
        else if (range === "monthly") periodStart.setDate(now.getDate() - 29);
        else periodStart.setFullYear(now.getFullYear() - 4, 0, 1);
        periodStart.setHours(0, 0, 0, 0);
        const periodExpenses = expenses
          .filter((expense) => new Date(`${expense.expense_date}T00:00:00`) >= periodStart)
          .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
        const dssResult = await generateDecisionSupport({
          metrics: {
            totalRevenue: periodRevenue,
            totalExpenses: periodExpenses,
            profit: periodRevenue - periodExpenses,
            totalOrders: periodOrders,
            averageOrderValue: periodOrders
              ? periodRevenue / periodOrders
              : 0,
            operationalSignals: [
              `${activeOrders} active orders and ${readyForPickup} orders ready for pickup.`,
              `${lowStockItems} low-stock inventory items.`,
              `Forecast workload today: ${fc.workloadLevel}. ${fc.workloadSummary}.`,
              `Forecast monthly revenue: ₱${fc.predictedMonthlyRevenue.toLocaleString()}.`,
            ],
          },
          trendData,
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
      const message = error.message || "Unable to load dashboard data.";
      if (firstLoad) setLoadError(message);
      else setRefreshError(message);
    } finally {
      setLoading(false);
      if (firstLoad || scope === "initial" || scope === "charts") setChartLoading(false);
      if (scope === "recent") setRecentLoading(false);
      if (scope === "background") setBackgroundRefreshing(false);
    }
  }

  function generateForecasts(orders, payments, inventory, usageLogs) {
    const baseline = rollingDemandForecast(orders, payments);

    // --- Restock predictions ---
    const restockAlerts = [];
    inventory
      .filter((item) => Number(item.current_stock) <= Number(item.minimum_stock))
      .forEach((item) => {
      const itemLogs = usageLogs.filter((l) => l.item_id === item.id);
      restockAlerts.push({
        name: item.name,
        daysLeft: predictInventoryDaysLeft(item, itemLogs),
        unit: item.unit,
        suggestedReorder: suggestInventoryReorderQuantity(item, itemLogs),
        currentStock: Number(item.current_stock),
      });
    });
    restockAlerts.sort((a, b) => (a.daysLeft ?? Number.POSITIVE_INFINITY) - (b.daysLeft ?? Number.POSITIVE_INFINITY));

    return {
      ...baseline,
      restockAlerts,
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

  if (loading && !hasLoadedDashboard.current) return <PageLoader label="Loading dashboard…" />;
  if (loadError && !hasLoadedDashboard.current) return <PageError message={loadError} onRetry={() => loadDashboard(false, "initial")} />;

  const restockAlertCount = forecasts?.restockAlerts?.length || 0;
  const activeRestockAlert = restockAlertCount
    ? forecasts.restockAlerts[Math.min(overviewAlertPage, restockAlertCount - 1)]
    : null;

  return (
    <section className="staff-dashboard admin-dashboard">
      <div className="staff-dashboard-heading">
        <div>
          <p className="staff-dashboard-kicker">Business operations</p>
          <h2>Management overview</h2>
          <p>Monitor orders, revenue, customers, and inventory across all branches.</p>
        </div>
        <span className="live-update-indicator" role="status" aria-live="polite">
          {backgroundRefreshing
            ? <><Loader2 size={14} className="button-spinner" aria-hidden="true" /> Syncing updates…</>
            : <><Radio size={14} aria-hidden="true" /> All branches · Live updates</>}
        </span>
      </div>
      {refreshError && (
        <div className="dashboard-refresh-error" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>Dashboard refresh failed. Existing information is still shown.</span>
          <button type="button" onClick={() => loadDashboard(false, "background")}>Try again</button>
        </div>
      )}
      <div className="stats-grid staff-dashboard-stats admin-dashboard-stats">
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
              const tone = ["critical", "warning", "info", "success"].includes(tip.type) ? tip.type : "info";
              return (
                <div
                  key={idx}
                  className={`dashboard-suggestion dashboard-suggestion-${tone}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "14px 16px",
                    borderRadius: 10,
                  }}
                >
                  <div
                    className="dashboard-suggestion-icon"
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <TipIcon size={18} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="dashboard-suggestion-title"
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        marginBottom: 2,
                      }}
                    >
                      {tip.title}
                    </div>
                    <div
                      className="dashboard-suggestion-message"
                      style={{
                        fontSize: 13,
                        lineHeight: 1.5,
                      }}
                    >
                      {tip.message}
                    </div>
                  </div>
                  {tip.action && tip.link && (
                    <button
                      className="btn btn-sm dashboard-suggestion-action"
                      onClick={() => navigate(tip.link)}
                      style={{
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
        <div className="staff-dss-overview admin-dss-overview" aria-label="All-branch decision support overview">
          <div className="staff-dss-header">
            <div>
              <span className="staff-dss-eyebrow"><Brain size={15} /> DSS overview</span>
              <h3>Decision Support</h3>
              <p>Read-only forecast across all branches.</p>
            </div>
            <span className="staff-dss-badge">
              <Zap size={12} /> AI-assisted
            </span>
          </div>
          <div className="dashboard-overview-body admin-dss-body">
            <div className="staff-dss-metrics">
              <div className="staff-dss-metric workload">
                <span>Expected workload today</span>
                <strong>{forecasts.workloadLevel}</strong>
                <small>{forecasts.workloadSummary}</small>
              </div>
              <div className="staff-dss-metric peak">
                <span>Likely peak day</span>
                <strong>{forecasts.peakDay}</strong>
                <small>Plan staffing ahead</small>
              </div>
            </div>

            {/* Predicted Revenue */}
            <div className="staff-dss-revenue admin-dss-revenue">
              <div
                className="staff-dss-icon"
              >
                <TrendingUp size={20} />
              </div>
              <div>
                <span>Predicted revenue</span>
                <strong>
                  ₱{forecasts.predictedMonthlyRevenue.toLocaleString()}
                </strong>
                <small>Based on received payments in the last 30 days</small>
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
                <div className="staff-dss-alert-group admin-dss-alert-group">
                  <div className="staff-dss-alert-summary">
                    <AlertTriangle size={17} />
                    <strong>{restockAlertCount} low-stock item{restockAlertCount === 1 ? "" : "s"} need attention</strong>
                  </div>
                  <div className="staff-dss-alert admin-dss-alert">
                    <span className="staff-dss-alert-dot" aria-hidden="true" />
                    <div>
                      <strong>{activeRestockAlert.name}</strong>
                      <span>
                        {inventoryRunOutLabel(activeRestockAlert.daysLeft)}
                      </span>
                      <span className="staff-dss-forecast">
                        Suggested reorder: ~{activeRestockAlert.suggestedReorder} {activeRestockAlert.unit}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm admin-dss-restock-button"
                      onClick={() => navigate("/dashboard/inventory")}
                      aria-label={`Restock ${activeRestockAlert.name}`}
                    >
                      Restock <ArrowRight size={13} />
                    </button>
                  </div>
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
                  className="dashboard-ai-skeleton"
                  style={{
                    height: 60,
                    borderRadius: 12,
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
                  let tone = "general";

                  if (clean.toLowerCase().includes("operational")) {
                    icon = Zap;
                    tone = "operational";
                  } else if (clean.toLowerCase().includes("inventory")) {
                    icon = Package;
                    tone = "inventory";
                  } else if (clean.toLowerCase().includes("revenue")) {
                    icon = TrendingUp;
                    tone = "revenue";
                  }

                  const Icon = icon;

                  return (
                    <div
                      key={i}
                      className={`dashboard-ai-insight dashboard-ai-insight-${tone}`}
                      style={{
                        display: "flex",
                        gap: 12,
                        padding: "14px 16px",
                        borderRadius: 12,
                      }}
                    >
                      <div
                        className="dashboard-ai-insight-icon"
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon size={18} />
                      </div>

                      <div>
                        <div className="dashboard-ai-insight-title">
                          {clean.split(":")[0]}
                        </div>
                        <div className="dashboard-ai-insight-copy" style={{ fontSize: 13.5 }}>
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
      <DashboardCharts data={weeklyData} range={range} onRangeChange={setRange} loading={chartLoading} />

      <div className="card dashboard-recent-orders">
        <div className="card-header">
          <h3>Recent Orders</h3>
          {recentLoading && (
            <span className="dashboard-section-loading" role="status" aria-live="polite">
              <Loader2 size={14} className="button-spinner" aria-hidden="true" /> Updating orders…
            </span>
          )}
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
                disabled={page === 0 || recentLoading}
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
                disabled={page === 0 || recentLoading}
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
                      disabled={recentLoading}
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
                disabled={page + 1 >= totalPages || recentLoading}
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
                disabled={page + 1 >= totalPages || recentLoading}
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
    </section>
  );
}
