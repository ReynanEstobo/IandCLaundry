import { format } from "date-fns";
import {
  Building2,
  Download,
  DollarSign,
  Lightbulb,
  Percent,
  ShoppingBag,
  Printer,
  RefreshCw,
  TrendingUp,
  Users,
  Timer,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { supabase } from "../lib/supabase";
import { useRealtime } from "../lib/useRealtime";
import { generateAiForecast, generateDecisionSupport } from "../services/geminiService";
import { LoadingVisual, PageError, PageLoader } from "../components/AsyncState";
import LoadingButton from '../components/LoadingButton'
import { analyticsPeriod, chartTooltipDate, dailyChartLabel, paymentChartData } from '../utils/chartDates'
import { paymentTimestamp, recordedPaymentAmount } from '../utils/businessForecast'

// ─── Custom tooltip ────────────────────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: "10px 14px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
        fontSize: 13,
        color: "#111827",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{chartTooltipDate(label, payload)}</div>

      {payload.map((p, i) => (
        <div
          key={i}
          style={{
            color: p.color,
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: p.color,
              display: "inline-block",
            }}
          />

          <span style={{ color: "#6b7280", textTransform: "capitalize" }}>
            {p.name}:
          </span>

          <span style={{ fontWeight: 600 }}>
            ₱{Number(p.value).toLocaleString()}
          </span>

          {p.payload?.isPrediction && (
            <span
              style={{
                fontSize: 10,
                background: "#f0fdf4",
                color: "#10b981",
                borderRadius: 4,
                padding: "1px 5px",
                fontWeight: 600,
              }}
            >
              FORECAST
            </span>
          )}
        </div>
      ))}
    </div>
  );
};

// ─── Sub-filter pill group ─────────────────────────────────────────────────────
function SubFilter({ value, onChange, options }) {
  return (
    <div className="analytics-period-filter">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`analytics-period-option${value === opt.value ? " active" : ""}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function OperationalList({ icon, title, accent, empty, items }) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid #f1f5f9", color: accent }}>
        {icon}
        <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 750 }}>{title}</span>
      </div>
      <div style={{ padding: "6px 14px 10px" }}>
        {items.length ? items.map((item, index) => (
          <div key={item} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "9px 0", borderBottom: index + 1 === items.length ? "none" : "1px solid #f1f5f9", fontSize: 13, color: "var(--text-secondary)" }}>
            <span style={{ flex: "0 0 auto", width: 20, height: 20, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, color: accent, background: `${accent}14` }}>{index + 1}</span>
            <span style={{ lineHeight: 1.45 }}>{item}</span>
          </div>
        )) : <div style={{ padding: "12px 0", fontSize: 13, color: "var(--text-muted)" }}>{empty}</div>}
      </div>
    </div>
  );
}

export default function Analytics() {
  const [range, setRange] = useState("weekly");

  const [selectedBranch, setSelectedBranch] = useState("all");

  const [customRange, setCustomRange] = useState({
    start: null,
    end: null,
  });

  const [orders, setOrders] = useState([]);
  const [payments, setPayments] = useState([]);
  const [expenses, setExpenses] = useState([]);

  const [forecastData, setForecastData] = useState([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [hasLoadedAnalytics, setHasLoadedAnalytics] = useState(false);
  const [filterError, setFilterError] = useState("");

  const [stats, setStats] = useState({});
  const [operationalSummary, setOperationalSummary] = useState({
    topServices: [], topBranches: [], staffPerformance: [], lowStockItems: [], repeatCustomers: 0, completedOrders: 0, averageTurnaroundHours: null,
  });

  const [forecastLoading, setForecastLoading] = useState(false);

  const [forecastModel, setForecastModel] = useState("");
  const [forecastAiMeta, setForecastAiMeta] = useState({ source: "pending", savedAt: null, isCached: false });

  const [aiInsights, setAiInsights] = useState([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [insightAiMeta, setInsightAiMeta] = useState({ source: "pending", savedAt: null, isCached: false });
  const [manualAiRefresh, setManualAiRefresh] = useState(false);

  useEffect(() => {
    const hasStartDate = Boolean(customRange.start);
    const hasEndDate = Boolean(customRange.end);

    // Do not replace the existing report while a customer is still choosing a
    // date range. Only fetch after both dates form a valid range.
    if (hasStartDate !== hasEndDate) {
      setFilterError("Choose both a start date and an end date to apply the date filter.");
      return;
    }

    if (hasStartDate && customRange.start > customRange.end) {
      setFilterError("The start date must be on or before the end date.");
      return;
    }

    setFilterError("");
    loadAnalytics(hasLoadedAnalytics);
  }, [range, customRange.start, customRange.end, selectedBranch]);

  useRealtime(["orders", "expenses"], () => {
    loadAnalytics(true);
  });
  useEffect(() => {
    if (aiLoading || manualAiRefresh) return;

    if (descriptiveData.length > 0 && forecastData.length > 0) {
      generateAIInsights(orders, expenses);
    }
  }, [forecastData, selectedBranch, range, operationalSummary, manualAiRefresh]);

  async function loadAnalytics(background = false) {
    const keepCurrentReport = background || hasLoadedAnalytics;
    if (!keepCurrentReport) {
      setLoading(true);
      setLoadError("");
      setForecastAiMeta({ source: "pending", savedAt: null, isCached: false });
      setInsightAiMeta({ source: "pending", savedAt: null, isCached: false });
      setAiInsights([]);
    }
    try {

    const period = analyticsPeriod(range, customRange);
    if (period.start > period.end) throw new Error('Start date must be before the end date.');
    const startDate = period.start.toISOString();
    const endDate = period.end.toISOString();

    let orderQuery = supabase
      .from("orders")
      .select("*, service_types(name)")
      .gte("created_at", startDate)
      .lte("created_at", endDate)
      .order("created_at", { ascending: true });

    let expenseQuery = supabase
      .from("expenses")
      .select("*")
      .gte("expense_date", format(new Date(startDate), "yyyy-MM-dd"))
      .lte("expense_date", format(new Date(endDate), "yyyy-MM-dd"));

    let paymentQuery = supabase
      .from("payments")
      .select("amount, paid_at, payment_date, order_id, branch, branch_id, orders!inner(id, status, branch, branch_id, service_types(name))")
      .gte("paid_at", startDate)
      .lte("paid_at", endDate)
      .order("paid_at", { ascending: true });

    if (selectedBranch !== "all") {
      orderQuery = orderQuery.eq("branch", selectedBranch);
      expenseQuery = expenseQuery.eq("branch", selectedBranch);
      paymentQuery = paymentQuery.eq("branch", selectedBranch);
    }

    let inventoryQuery = supabase.from("inventory_items").select("*");
    if (selectedBranch !== "all") inventoryQuery = inventoryQuery.eq("branch", selectedBranch);
    const [ordersRes, expensesRes, staffRes, inventoryRes, paymentsRes] = await Promise.all([
      orderQuery,
      expenseQuery,
      supabase.from("staff").select("id, full_name"),
      inventoryQuery,
      paymentQuery,
    ]);
    const requestError = ordersRes.error || expensesRes.error || staffRes.error || inventoryRes.error || paymentsRes.error;
    if (requestError) throw requestError;

    const orderData = (ordersRes.data || []).filter((order) => order.status !== "cancelled");
    const paymentData = (paymentsRes.data || []).filter((payment) => payment.orders?.status !== 'cancelled' && recordedPaymentAmount(payment) > 0);
    const expenseData = expensesRes.data || [];
    const staffById = new Map((staffRes.data || []).map((staff) => [staff.id, staff.full_name || "Unassigned staff"]));
    const inventoryData = inventoryRes.data || [];

    setOrders(orderData);
    setPayments(paymentData);
    setExpenses(expenseData);

    // Revenue is cash actually recorded against the order, including partial
    // payments, rather than only the price of fully paid orders.
    const totalRevenue = paymentData.reduce((sum, payment) => sum + recordedPaymentAmount(payment), 0);

    const totalExpenses = expenseData.reduce((s, e) => s + Number(e.amount), 0);

    const profit = totalRevenue - totalExpenses;

    const avgOrderValue =
      orderData.length > 0 ? totalRevenue / orderData.length : 0;

    setStats({
      totalRevenue,
      totalExpenses,
      profit,
      avgOrderValue,
      totalOrders: orderData.length,
    });

    const serviceTotals = new Map();
    const customerVisits = new Map();
    const branchTotals = new Map();
    const staffTotals = new Map();
    let completedOrders = 0;
    let turnaroundTotalHours = 0;
    paymentData.forEach((payment) => {
      const order = payment.orders || {};
      const amount = recordedPaymentAmount(payment);
      const serviceName = order.service_types?.name || "Unspecified service";
      const current = serviceTotals.get(serviceName) || { name: serviceName, orders: 0, revenue: 0 };
      current.orders += 1;
      current.revenue += amount;
      serviceTotals.set(serviceName, current);
      const branchRecord = branchTotals.get(order.branch || "Unassigned") || { name: order.branch || "Unassigned", orders: 0, revenue: 0 };
      branchRecord.orders += 1;
      branchRecord.revenue += amount;
      branchTotals.set(branchRecord.name, branchRecord);
    });
    orderData.forEach((order) => {
      if (order.customer_id) customerVisits.set(order.customer_id, (customerVisits.get(order.customer_id) || 0) + 1);
      const staffId = order.completed_by_staff_id || order.created_by_staff_id;
      if (staffId) {
        const staffRecord = staffTotals.get(staffId) || { name: staffById.get(staffId) || "Unassigned staff", completed: 0, created: 0 };
        staffRecord.created += 1;
        if (order.status === "released") staffRecord.completed += 1;
        staffTotals.set(staffId, staffRecord);
      }
      if (order.status === "released") {
        completedOrders += 1;
        if (order.created_at && order.updated_at) turnaroundTotalHours += Math.max(0, (new Date(order.updated_at) - new Date(order.created_at)) / 3600000);
      }
    });
    setOperationalSummary({
      topServices: [...serviceTotals.values()].sort((a, b) => b.revenue - a.revenue || b.orders - a.orders).slice(0, 3),
      topBranches: [...branchTotals.values()].sort((a, b) => b.revenue - a.revenue || b.orders - a.orders).slice(0, 3),
      staffPerformance: [...staffTotals.values()].sort((a, b) => b.completed - a.completed || b.created - a.created).slice(0, 3),
      lowStockItems: inventoryData.filter((item) => Number(item.current_stock) <= Number(item.minimum_stock)).slice(0, 5),
      repeatCustomers: [...customerVisits.values()].filter((visits) => visits > 1).length,
      completedOrders,
      averageTurnaroundHours: completedOrders ? turnaroundTotalHours / completedOrders : null,
    });

    generateForecast(paymentData);
    setHasLoadedAnalytics(true);

    } catch (error) {
      if (!keepCurrentReport) {
        setLoadError(error.message || "Unable to load analytics data.");
      } else {
        console.error("Analytics refresh failed:", error);
        setFilterError("Unable to refresh the report. Your previous results are still shown.");
      }
    } finally {
      if (!keepCurrentReport) setLoading(false);
    }
  }


  function buildDailyHistory(paymentData) {
    const totals = new Map();
    paymentData.forEach((payment) => {
      const date = format(new Date(paymentTimestamp(payment)), "yyyy-MM-dd");
      const day = totals.get(date) || { date, revenue: 0, orders: 0, paidOrders: 0 };
      day.orders += 1;
      if (recordedPaymentAmount(payment) > 0) {
        day.revenue += recordedPaymentAmount(payment);
        day.paidOrders += 1;
      }
      totals.set(date, day);
    });

    return [...totals.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  async function generateForecast(paymentData, { forceRefresh = false } = {}) {
    try {
      setForecastLoading(true);

      // ─────────────────────────────────────
      // GET HISTORICAL REVENUE
      // ─────────────────────────────────────
      const historicalRevenue = [];

      paymentData.forEach((payment) => {
        historicalRevenue.push(recordedPaymentAmount(payment));
      });

      // ─────────────────────────────────────
      // COMPUTE MOVING AVERAGE
      // ─────────────────────────────────────
      const dailyHistory = buildDailyHistory(paymentData);
      const averageRevenue =
        dailyHistory.length > 0
          ? dailyHistory.reduce((sum, day) => sum + day.revenue, 0) /
            dailyHistory.length
          : 0;

      const today = new Date();

      let forecastLength = 7;

      // ─────────────────────────────────────
      // FORECAST LENGTH
      // ─────────────────────────────────────
      if (range === "weekly") {
        forecastLength = 7;
      } else if (range === "monthly") {
        forecastLength = 30;
      } else {
        forecastLength = 5;
      }

      // ─────────────────────────────────────
      // GENERATE FUTURE FORECAST
      // ─────────────────────────────────────
      const futureForecast = [];

      for (let i = 0; i < forecastLength; i++) {
        const futureDate = new Date(today);

        // WEEKLY FORECAST
        if (range === "weekly") {
          futureDate.setDate(today.getDate() + i);
        }

        // MONTHLY FORECAST
        else if (range === "monthly") {
          futureDate.setDate(today.getDate() + i);
        }

        // YEARLY FORECAST
        else {
          futureDate.setFullYear(today.getFullYear() + i);
        }

        // ─────────────────────────────────
        // SIMPLE TREND GROWTH
        // ─────────────────────────────────
        const growthRate =
          range === "weekly" ? 0.01 : range === "monthly" ? 0.025 : 0.08;

        const fluctuation = 0;

        const predictedRevenue = Math.round(
          averageRevenue * (1 + i * growthRate + fluctuation),
        );

        // ─────────────────────────────────
        // LABEL FORMAT
        // ─────────────────────────────────
        let label = "";

        // WEEKLY
        if (range === "weekly") {
          label = dailyChartLabel(futureDate);
        }

        // MONTHLY
        else if (range === "monthly") {
          label = format(futureDate, "MMM dd");
        }

        // YEARLY
        else {
          label = format(futureDate, "yyyy");
        }

        futureForecast.push({
          date: label,
          forecastDate: format(futureDate, "yyyy-MM-dd"),
          predicted: predictedRevenue,
          isPrediction: true,
        });
      }

      // ─────────────────────────────────────
      // SAVE FORECAST
      // ─────────────────────────────────────
      setForecastData(futureForecast);

      setForecastModel("Trend baseline (AI loading)");

      // Reuse a recent result when the branch, range, history, and forecast
      // horizon are unchanged. This avoids charging a Gemini request each time
      // the Analytics page is opened.
      const forecastVersion = `${dailyHistory.map((day) => `${day.date}:${day.revenue}:${day.orders}`).join("|")}_${futureForecast.map((item) => item.forecastDate).join("|")}`;
      // v2 intentionally ignores prior cached labels from before the
      // resilient forecast response format was introduced.
      const forecastCacheKey = `ai_forecast_v3_${selectedBranch}_${range}_${forecastVersion}`;
      const cachedForecast = localStorage.getItem(forecastCacheKey);
      const cachedForecastTime = localStorage.getItem(`${forecastCacheKey}_time`);
      const SIX_HOURS = 6 * 60 * 60 * 1000;

      if (
        !forceRefresh &&
        cachedForecast &&
        cachedForecastTime &&
        Date.now() - Number(cachedForecastTime) < SIX_HOURS
      ) {
        try {
          const parsedCache = JSON.parse(cachedForecast);
          if (Array.isArray(parsedCache.data) && parsedCache.data.length) {
            setForecastData(parsedCache.data);
            setForecastModel(parsedCache.model || "Gemini-assisted forecast (cached)");
            setForecastAiMeta({
              source: parsedCache.source || (parsedCache.model?.includes("Gemini") ? "gemini" : "baseline"),
              savedAt: Number(cachedForecastTime),
              isCached: true,
            });
            return parsedCache.data;
          }
        } catch {
          localStorage.removeItem(forecastCacheKey);
          localStorage.removeItem(`${forecastCacheKey}_time`);
        }
      }

      try {
        const aiForecast = await generateAiForecast({
          history: dailyHistory,
          forecastDates: futureForecast.map((item) => item.forecastDate),
          branch: selectedBranch,
          range,
        });
        const normalizedForecast = aiForecast.predictions.map((prediction) => ({
            date:
              range === "yearly"
                ? format(new Date(prediction.date), "yyyy")
                : range === "monthly"
                  ? format(new Date(prediction.date), "MMM dd")
                  : dailyChartLabel(prediction.date),
            forecastDate: prediction.date,
            predicted: prediction.predictedRevenue,
            predictedOrders: prediction.predictedOrders,
            confidence: prediction.confidence,
            isPrediction: true,
          }));
        const modelLabel = aiForecast.method || `Gemini-assisted forecast (${aiForecast.model})`;
        const savedAt = Date.now();
        const source = aiForecast.isFallback ? "baseline" : "gemini";
        setForecastData(normalizedForecast);
        setForecastModel(modelLabel);
        setForecastAiMeta({ source, savedAt, isCached: false });
        localStorage.setItem(
          forecastCacheKey,
          JSON.stringify({ data: normalizedForecast, model: modelLabel, source }),
        );
        localStorage.setItem(`${forecastCacheKey}_time`, savedAt.toString());
        if (aiForecast.insights?.length) setAiInsights(aiForecast.insights);
        return normalizedForecast;
      } catch (aiError) {
        console.warn("Forecast service failed; keeping the local trend baseline.", aiError.message);
        setForecastAiMeta({ source: "baseline", savedAt: null, isCached: false });
        setForecastModel("Local trend baseline · low confidence");
        return futureForecast;
      }
    } catch (err) {
      console.error(err);

      setForecastData([]);
    } finally {
      setForecastLoading(false);
    }
  }
  async function generateAIInsights(orderData, expenseData, { forceRefresh = false, forecastOverride = null } = {}) {
    try {
      setAiLoading(true);

      const analyticsVersion = `${orderData.length}-${expenseData.length}-${stats.totalRevenue || 0}-${stats.totalExpenses || 0}-${forecastData.map((item) => item.predicted).join(",")}`;
      const cacheKey = `ai_insights_v2_${selectedBranch}_${range}_${analyticsVersion}`;

      const cached = localStorage.getItem(cacheKey);

      const lastRequest = localStorage.getItem(`${cacheKey}_time`);

      const SIX_HOURS = 6 * 60 * 60 * 1000;

      // USE CACHE
      if (
        !forceRefresh &&
        cached &&
        lastRequest &&
        Date.now() - Number(lastRequest) < SIX_HOURS
      ) {
        const parsedCache = JSON.parse(cached);
        const cachedInsights = Array.isArray(parsedCache) ? parsedCache : parsedCache.insights;
        if (!Array.isArray(cachedInsights)) throw new Error("Invalid cached AI insights");
        setAiInsights(cachedInsights);
        setInsightAiMeta({
          source: parsedCache.source || "gemini",
          savedAt: Number(lastRequest),
          isCached: true,
        });

        setAiLoading(false);

        return;
      }

      const chartData = descriptiveData;

      const revenue = stats.totalRevenue || 0;

      const expenses = stats.totalExpenses || 0;

      const profit = stats.profit || 0;

      const dssResult = await generateDecisionSupport({
        metrics: {
          totalRevenue: revenue,
          totalExpenses: expenses,
          profit,
          totalOrders: orderData.length,
          averageOrderValue: stats.avgOrderValue || 0,
          operationalSignals: [
            ...operationalSummary.topServices.map((service) => `Service ${service.name}: ${service.orders} orders, ₱${service.revenue.toLocaleString()} received.`),
            ...operationalSummary.topBranches.map((branchMetric) => `Branch ${branchMetric.name}: ${branchMetric.orders} orders, ₱${branchMetric.revenue.toLocaleString()} received.`),
            ...operationalSummary.staffPerformance.map((staff) => `${staff.name}: ${staff.completed} released, ${staff.created} created orders.`),
            ...operationalSummary.lowStockItems.map((item) => `Low stock: ${item.name} has ${item.current_stock} ${item.unit} left at ${item.branch || "the selected branch"}.`),
            `Repeat customers in the selected scope: ${operationalSummary.repeatCustomers}.`,
            `Released orders: ${operationalSummary.completedOrders}.`,
            operationalSummary.averageTurnaroundHours == null ? "Turnaround time is not yet available." : `Average released-order turnaround: ${operationalSummary.averageTurnaroundHours.toFixed(1)} hours.`,
          ],
        },
        trendData: chartData,
        forecastData: forecastOverride || forecastData,
        branch: selectedBranch,
        range,
      });

      const savedAt = Date.now();
      const source = dssResult.isFallback ? "baseline" : "gemini";
      setAiInsights(dssResult.insights);
      setInsightAiMeta({ source, savedAt, isCached: false });
      localStorage.setItem(cacheKey, JSON.stringify({ insights: dssResult.insights, source }));
      localStorage.setItem(`${cacheKey}_time`, savedAt.toString());
      return;

      /* Legacy free-form DSS prompt retained only as a reference.
      const aiResult = await askGemini(`
You are an AI-Based Decision Support System for I&C Laundry.

Analyze the ACTUAL analytics trends below.

Revenue Summary:
₱${revenue}

Expense Summary:
₱${expenses}

Profit:
₱${profit}

Trend Data:
${JSON.stringify(chartData)}

Forecast Data:
${JSON.stringify(forecastData)}

Branch:
${selectedBranch}

Return ONLY valid JSON.

{
  "insights": [
    {
      "title": "Revenue Trend",
      "description": "..."
    }
  ]
}

Rules:
- Analyze actual graph trends
- Mention increases or decreases
- Mention if expenses are high
- Mention forecast behavior
- Mention financial recommendations
- Maximum 2 sentences
- Keep insights realistic
- Avoid generic responses
- No markdown
`);

      const cleaned = aiResult.text
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();

      const parsed = JSON.parse(cleaned);

      setAiInsights(parsed.insights || []);
      localStorage.setItem(cacheKey, JSON.stringify(parsed.insights || []));

      localStorage.setItem(`${cacheKey}_time`, Date.now().toString());
      */
    } catch (err) {
      console.error(err);

      setInsightAiMeta({ source: "baseline", savedAt: null, isCached: false });

      setAiInsights([
        {
          title: "Revenue Trend",
          description:
            "Revenue performance remains stable based on the selected analytics range.",
        },
        {
          title: "Expense Monitoring",
          description:
            "Operational expenses should continue to be monitored to maintain profitability.",
        },
        {
          title: "Forecast Observation",
          description:
            "Revenue forecasting indicates steady financial performance in upcoming periods.",
        },
      ]);
    } finally {
      setAiLoading(false);
    }
  }

  const descriptiveData = paymentChartData(payments, expenses, range, customRange);

  const formatAiCacheTime = (timestamp) => timestamp
    ? new Date(timestamp).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })
    : "Not cached";
  const describeAiSource = (meta) => {
    if (meta.source === "gemini") return meta.isCached ? "Gemini AI result (cached)" : "Generated by Gemini AI";
    if (meta.source === "baseline") return "Local baseline (Gemini unavailable)";
    return "Preparing AI output";
  };

  async function regenerateAiOutputs() {
    if (manualAiRefresh || forecastLoading || aiLoading) return;
    setManualAiRefresh(true);
    try {
      const freshForecast = await generateForecast(orders, { forceRefresh: true });
      await generateAIInsights(orders, expenses, {
        forceRefresh: true,
        forecastOverride: freshForecast || forecastData,
      });
    } finally {
      setManualAiRefresh(false);
    }
  }

  const reportScope = selectedBranch === "all" ? "All branches" : selectedBranch;
  const reportPeriod = customRange.start && customRange.end
    ? `${customRange.start} to ${customRange.end}`
    : `${range.charAt(0).toUpperCase()}${range.slice(1)} view`;
  const peso = (value) => `₱${(Number(value) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const hasCustomRange = Boolean(customRange.start || customRange.end);
  const updateCustomRange = (field, value) => {
    setCustomRange((previous) => ({ ...previous, [field]: value || null }));
  };
  const clearCustomRange = () => {
    setFilterError("");
    setCustomRange({ start: null, end: null });
  };
  const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const html = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  function downloadReportCsv() {
    const rows = [
      ["I&C Laundry Cash Collection & Analytics Report"],
      ["Scope", reportScope],
      ["Reporting period", reportPeriod],
      ["Generated", new Date().toLocaleString("en-PH")],
      ["Revenue basis", "Cash received is recognized on the payment collection date (paid_at)."],
      ["Historical data note", "Backfilled payments use the best available historical order timestamp."],
      [],
      ["Summary"],
      ["Cash Received (PHP)", stats.totalRevenue || 0],
      ["Recorded Expenses (PHP)", stats.totalExpenses || 0],
      ["Net Cash Position (PHP)", stats.profit || 0],
      ["Orders Created", stats.totalOrders || 0],
      ["Payment Entries", payments.length],
      [],
      ["Cash Received & Expense Trend"],
      ["Period", "Cash Received (PHP)", "Expenses (PHP)"],
      ...descriptiveData.map((item) => [item.date, item.revenue || 0, item.expenses || 0]),
      [],
      ["Cash-Receipt Forecast"],
      ["Forecast Date", "Predicted Cash Received (PHP)", "Predicted Orders", "Confidence"],
      ...forecastData.map((item) => [item.forecastDate || item.date, item.predicted || 0, item.predictedOrders || 0, item.confidence || "low"]),
      [],
      ["Services by Cash Received"],
      ["Service", "Payment Entries", "Cash Received (PHP)"],
      ...operationalSummary.topServices.map((item) => [item.name, item.orders, item.revenue]),
      [],
      ["Branches by Cash Received"],
      ["Branch", "Payment Entries", "Cash Received (PHP)"],
      ...operationalSummary.topBranches.map((item) => [item.name, item.orders, item.revenue]),
      [],
      ["Decision Support Insights"],
      ...aiInsights.map((item) => [item.title, item.description]),
    ];
    const blob = new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ic-laundry-analytics-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function printReport() {
    // `noopener` in the feature string can make window.open return null in
    // Chromium, which prevented the report from ever being written.
    const popup = window.open("", "_blank");
    if (!popup) return window.alert("Allow pop-ups to print or save this report as PDF.");
    popup.opener = null;
    const insightMarkup = aiInsights.length
      ? aiInsights.map((item) => `<li><strong>${html(item.title)}:</strong> ${html(item.description)}</li>`).join("")
      : "<li>No decision-support insights are available for this scope.</li>";
    const trendRows = descriptiveData.map((item) => `<tr><td>${html(item.date)}</td><td class=\"money\">${peso(item.revenue)}</td><td class=\"money\">${peso(item.expenses)}</td></tr>`).join("") || "<tr><td colspan=\"3\">No cash-collection or expense data for this period.</td></tr>";
    const forecastRows = forecastData.map((item) => `<tr><td>${html(item.forecastDate || item.date)}</td><td class=\"money\">${peso(item.predicted)}</td><td>${Number(item.predictedOrders) || 0}</td><td>${html(item.confidence || "low")}</td></tr>`).join("") || "<tr><td colspan=\"4\">No forecast is available for this scope.</td></tr>";
    const serviceRows = operationalSummary.topServices.map((item) => `<tr><td>${html(item.name)}</td><td>${item.orders}</td><td class=\"money\">${peso(item.revenue)}</td></tr>`).join("") || "<tr><td colspan=\"3\">No service payment data</td></tr>";
    const branchRows = operationalSummary.topBranches.map((item) => `<tr><td>${html(item.name)}</td><td>${item.orders}</td><td class=\"money\">${peso(item.revenue)}</td></tr>`).join("") || "<tr><td colspan=\"3\">No branch payment data</td></tr>";
    popup.document.write(`<!doctype html>
      <html><head><title>I&C Laundry Cash Collection & Analytics Report</title>
      <style>
        @page{margin:12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#172033;line-height:1.45;margin:0;padding:28px;background:#fff}.header{border-bottom:3px solid #0f9ccf;padding-bottom:16px}.eyebrow{color:#087dac;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0 0 4px}h1{color:#10243e;font-size:25px;margin:0}.meta{color:#667085;font-size:12px;margin:9px 0 0}.basis{background:#edf8fc;border-left:4px solid #0f9ccf;border-radius:6px;color:#31536c;font-size:12px;margin:18px 0;padding:10px 12px}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:9px;margin:18px 0}.card{border:1px solid #dbe3ec;border-radius:8px;padding:11px;min-height:77px}.label{color:#667085;font-size:11px;font-weight:700;text-transform:uppercase}.value{font-size:17px;font-weight:700;margin-top:8px;color:#10243e}h2{border-bottom:1px solid #dbe3ec;color:#10243e;font-size:15px;margin:25px 0 9px;padding-bottom:6px}table{border-collapse:collapse;width:100%;margin:0 0 16px}th,td{border:1px solid #dbe3ec;padding:7px 8px;text-align:left;font-size:11px;vertical-align:top}th{background:#eaf6fb;color:#174765;font-weight:700}.money{text-align:right;white-space:nowrap}li{font-size:12px;margin:7px 0}.footer{border-top:1px solid #dbe3ec;color:#667085;font-size:10px;margin-top:22px;padding-top:10px}@media print{body{padding:0}.card,table{break-inside:avoid}h2{break-after:avoid}}
      </style></head><body>
      <header class=\"header\"><p class=\"eyebrow\">Payment-ledger report</p><h1>I&C Laundry Cash Collection &amp; Analytics Report</h1><p class=\"meta\"><strong>Scope:</strong> ${html(reportScope)} &nbsp;|&nbsp; <strong>Reporting period:</strong> ${html(reportPeriod)}<br><strong>Generated:</strong> ${html(new Date().toLocaleString("en-PH"))}</p></header>
      <p class=\"basis\"><strong>Financial basis:</strong> Cash received is recognized on the payment collection date (<code>paid_at</code>). Historical backfill rows use the best available order timestamp. Expenses are reported on their recorded expense date.</p>
      <section class=\"cards\"><div class=\"card\"><div class=\"label\">Cash received</div><div class=\"value\">${peso(stats.totalRevenue)}</div></div><div class=\"card\"><div class=\"label\">Recorded expenses</div><div class=\"value\">${peso(stats.totalExpenses)}</div></div><div class=\"card\"><div class=\"label\">Net cash position</div><div class=\"value\">${peso(stats.profit)}</div></div><div class=\"card\"><div class=\"label\">Orders created</div><div class=\"value\">${stats.totalOrders || 0}</div></div><div class=\"card\"><div class=\"label\">Payment entries</div><div class=\"value\">${payments.length}</div></div></section>
      <h2>Cash Received &amp; Expense Trend</h2><table><thead><tr><th>Period</th><th>Cash Received</th><th>Expenses</th></tr></thead><tbody>${trendRows}</tbody></table>
      <h2>Cash-Receipt Forecast</h2><table><thead><tr><th>Forecast date</th><th>Predicted cash received</th><th>Predicted orders</th><th>Confidence</th></tr></thead><tbody>${forecastRows}</tbody></table>
      <h2>Services by Cash Received</h2><table><thead><tr><th>Service</th><th>Payment entries</th><th>Cash received</th></tr></thead><tbody>${serviceRows}</tbody></table>
      <h2>Branches by Cash Received</h2><table><thead><tr><th>Branch</th><th>Payment entries</th><th>Cash received</th></tr></thead><tbody>${branchRows}</tbody></table>
      <h2>AI-Assisted Decision Support</h2><ul>${insightMarkup}</ul><p class=\"footer\">Forecast method: ${html(forecastModel || "Not available")}. Forecasts are decision-support estimates and should be reviewed alongside current branch operations.</p>
      </body></html>`);
    popup.document.close();
    popup.focus();
    window.setTimeout(() => popup.print(), 250);
  }

  if (loading) return <PageLoader label="Preparing analytics…" />;
  if (loadError) return <PageError message={loadError} onRetry={() => loadAnalytics(false)} />;

  return (
    <>
      {/* FILTERS */}
      <div className="analytics-filter-toolbar">
        {/* DATE FILTER */}
        <div className="analytics-date-filter">
          <input
            type="date"
            value={customRange.start || ""}
            aria-label="Start date"
            aria-invalid={Boolean(filterError)}
            className="analytics-date-input"
            onChange={(e) => updateCustomRange("start", e.target.value)}
          />

          <span className="analytics-date-divider">→</span>

          <input
            type="date"
            value={customRange.end || ""}
            aria-label="End date"
            aria-invalid={Boolean(filterError)}
            className="analytics-date-input"
            onChange={(e) => updateCustomRange("end", e.target.value)}
          />
          {hasCustomRange && (
            <button
              type="button"
              onClick={clearCustomRange}
              className="btn-icon"
              aria-label="Clear date range"
              title="Clear date range"
              style={{ flex: "0 0 auto", color: "var(--text-secondary)" }}
            >
              <X size={17} />
            </button>
          )}
          {filterError && (
            <p
              role="alert"
              aria-live="polite"
              className="analytics-filter-error"
            >
              {filterError}
            </p>
          )}
        </div>

        {/* BRANCH FILTER */}
        <select
          value={selectedBranch}
          onChange={(e) => setSelectedBranch(e.target.value)}
          className="analytics-branch-filter"
        >
          <option value="all">All Branches</option>
          <option value="Main - Brgy 7">Main - Brgy 7</option>
          <option value="2nd Branch - Brgy Calzada">
            2nd Branch - Brgy Calzada
          </option>
          <option value="3rd Branch - Nasugbu">3rd Branch - Nasugbu</option>
        </select>

        <SubFilter
          value={range}
          onChange={setRange}
          options={[
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly" },
            { value: "yearly", label: "Yearly" },
          ]}
        />

        <div className="analytics-report-actions">
          <button type="button" onClick={downloadReportCsv} className="analytics-report-button">
            <Download size={16} /> Export CSV
          </button>
          <button type="button" onClick={printReport} className="analytics-report-button primary">
            <Printer size={16} /> Print / PDF
          </button>
        </div>
      </div>

      {/* STATS */}
      <div className="stats-grid">
        <div className="stat-card green">
          <div className="stat-icon">
            <DollarSign size={22} />
          </div>

          <div className="stat-value">
            ₱{stats.totalRevenue?.toLocaleString()}
          </div>

          <div className="stat-label">Cash Received</div>
        </div>

        <div className="stat-card red">
          <div className="stat-icon">
            <Wallet size={22} />
          </div>

          <div className="stat-value">
            ₱{stats.totalExpenses?.toLocaleString()}
          </div>

          <div className="stat-label">Total Expenses</div>
        </div>

        <div className="stat-card cyan">
          <div className="stat-icon">
            <Percent size={22} />
          </div>

          <div className="stat-value">₱{stats.profit?.toLocaleString()}</div>

          <div className="stat-label">Net Profit</div>
        </div>

        <div className="stat-card blue">
          <div className="stat-icon">
            <ShoppingBag size={22} />
          </div>

          <div className="stat-value">{stats.totalOrders}</div>

          <div className="stat-label">Total Orders</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24, padding: 24 }}>
        <div className="card-header" style={{ marginBottom: 20, alignItems: "flex-start" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5 }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, display: "grid", placeItems: "center", color: "#fff", background: "linear-gradient(135deg, #0ea5e9, #2563eb)" }}>
                <TrendingUp size={18} />
              </div>
              <h3 style={{ margin: 0 }}>Operational Performance</h3>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Service demand, client retention, and branch productivity for the selected scope.</p>
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#2563eb", background: "#eff6ff", borderRadius: 999, padding: "6px 10px" }}>Live operational summary</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 18 }}>
          {[
            { label: "Repeat Customers", value: operationalSummary.repeatCustomers, icon: Users, color: "#0ea5e9", bg: "#e0f2fe" },
            { label: "Released Orders", value: operationalSummary.completedOrders, icon: ShoppingBag, color: "#10b981", bg: "#dcfce7" },
            { label: "Average Turnaround", value: operationalSummary.averageTurnaroundHours == null ? "—" : `${operationalSummary.averageTurnaroundHours.toFixed(1)}h`, icon: Timer, color: "#8b5cf6", bg: "#f3e8ff" },
          ].map((metric) => {
            const Icon = metric.icon;
            return <div key={metric.label} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, display: "grid", placeItems: "center", color: metric.color, background: metric.bg, marginBottom: 12 }}><Icon size={17} /></div>
              <div style={{ fontSize: 24, lineHeight: 1, fontWeight: 750, color: "var(--text-primary)", marginBottom: 7 }}>{metric.value}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>{metric.label}</div>
            </div>;
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(245px, 1fr))", gap: 14 }}>
          <OperationalList icon={<TrendingUp size={17} />} title="High-Performing Services" accent="#8b5cf6" empty="No service data yet" items={operationalSummary.topServices.map((service) => `${service.name} · ${service.orders} orders · ₱${service.revenue.toLocaleString()}`)} />
          <OperationalList icon={<Building2 size={17} />} title="Top Branches" accent="#0ea5e9" empty="No branch data yet" items={operationalSummary.topBranches.map((branchMetric) => `${branchMetric.name} · ${branchMetric.orders} orders · ₱${branchMetric.revenue.toLocaleString()}`)} />
          <OperationalList icon={<Users size={17} />} title="Staff Productivity" accent="#10b981" empty="No staff activity yet" items={operationalSummary.staffPerformance.map((staff) => `${staff.name} · ${staff.completed} released / ${staff.created} handled`)} />
        </div>
      </div>

      {/* AI OUTPUT STATUS */}
      <section className="analytics-ai-provenance" aria-label="AI analytics output status">
        <div className="analytics-ai-provenance-icon"><Lightbulb size={19} /></div>
        <div className="analytics-ai-provenance-copy">
          <strong>AI-assisted analytics outputs</strong>
          <span>Forecast: {describeAiSource(forecastAiMeta)} · Last cached: {formatAiCacheTime(forecastAiMeta.savedAt)}</span>
          <span>Decision support: {describeAiSource(insightAiMeta)} · Last cached: {formatAiCacheTime(insightAiMeta.savedAt)}</span>
        </div>
        <LoadingButton
          type="button"
          className="analytics-ai-regenerate"
          onClick={regenerateAiOutputs}
          disabled={manualAiRefresh || forecastLoading || aiLoading || loading}
          loading={manualAiRefresh}
          loadingLabel="Regenerating..."
        >
          <RefreshCw size={15} className={manualAiRefresh ? "analytics-ai-refreshing" : ""} />
          {manualAiRefresh ? "Regenerating…" : "Regenerate AI outputs"}
        </LoadingButton>
      </section>

      {/* CHARTS */}
      <div className="charts-grid">
        {/* REVENUE EXPENSE */}
        <div className="card">
          <div className="card-header">
            <h3>Cash Received & Expense Trend</h3>

            <p
              style={{
                fontSize: 12,
                color: "#6b7280",
              }}
            >
              Descriptive Analytics
            </p>
          </div>

          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={descriptiveData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#f3f4f6"
                vertical={false}
              />

              <XAxis dataKey="date" minTickGap={24} tick={{ fontSize: 11 }} interval="preserveStartEnd" />

              <YAxis />

              <Tooltip content={<CustomTooltip />} />

              <Legend />

              <Area
                type="monotone"
                dataKey="revenue"
                stroke="#10b981"
                fill="#10b981"
                fillOpacity={0.2}
              />

              <Area
                type="monotone"
                dataKey="expenses"
                stroke="#ef4444"
                fill="#ef4444"
                fillOpacity={0.2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* FORECAST */}
        <div className="card">
          <div className="card-header">
            <h3>Revenue Forecasting</h3>

            <p
              style={{
                fontSize: 12,
                color: "#6b7280",
                maxWidth: 260,
                textAlign: "right",
                lineHeight: 1.35,
                margin: 0,
              }}
            >
              Predictive Analytics · {forecastModel}
            </p>
          </div>

          {forecastLoading ? (
            <div
              style={{
                height: 280,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                color: "#6b7280",
              }}
            >
              <LoadingVisual label="Generating AI revenue forecast…" compact />
              <strong style={{ color: "#5b21b6" }}>
                Generating AI revenue forecast
              </strong>
              <span style={{ fontSize: 13 }}>
                Analyzing historical revenue and laundry demand in PHP…
              </span>
            </div>
          ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={forecastData.map(point => ({ ...point, date: point.forecastDate && range !== 'yearly' ? dailyChartLabel(point.forecastDate) : point.date }))}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#f3f4f6"
                vertical={false}
              />

              <XAxis dataKey="date" minTickGap={24} tick={{ fontSize: 11 }} interval="preserveStartEnd" />

              <YAxis />

              <Tooltip content={<CustomTooltip />} />

              <Legend />

              <Bar dataKey="predicted" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          )}
        </div>

        {/* AI DSS */}
        <div
          className="card"
          style={{
            gridColumn: "1 / -1",
            border: "1px solid #ddd6fe",
            background: "linear-gradient(135deg,#faf5ff,#ffffff)",
          }}
        >
          <div className="card-header">
            <h3
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Lightbulb size={18} style={{ color: "#7c3aed" }} />
              AI-Based DSS Insights
            </h3>

            <span
              style={{
                background: "#ede9fe",
                color: "#7c3aed",
                padding: "5px 10px",
                borderRadius: 8,
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              AI-Based Operational & Financial Recommendations
            </span>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {aiLoading && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  color: "#6d28d9",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <div
                  className="spinner"
                  style={{ width: 20, height: 20, borderWidth: 2 }}
                />
                AI is analyzing PHP revenue, demand, and operations…
              </div>
            )}
            {aiLoading
              ? [...Array(3)].map((_, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      gap: 14,
                      padding: "16px",
                      borderRadius: 14,
                      background: "#faf5ff",
                      border: "1px solid rgba(0,0,0,0.05)",
                      animation: "pulse 1.5s infinite",
                    }}
                  >
                    {/* ICON SKELETON */}
                    <div
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 12,
                        background: "#e5e7eb",
                        flexShrink: 0,
                      }}
                    />

                    {/* TEXT SKELETON */}
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          height: 14,
                          width: "35%",
                          background: "#e5e7eb",
                          borderRadius: 6,
                          marginBottom: 10,
                        }}
                      />

                      <div
                        style={{
                          height: 12,
                          width: "100%",
                          background: "#e5e7eb",
                          borderRadius: 6,
                          marginBottom: 8,
                        }}
                      />

                      <div
                        style={{
                          height: 12,
                          width: "80%",
                          background: "#e5e7eb",
                          borderRadius: 6,
                        }}
                      />
                    </div>
                  </div>
                ))
              : aiInsights.map((item, i) => {
                  let Icon = TrendingUp;
                  let color = "#8b5cf6";
                  let bg = "#faf5ff";

                  if (item.title.toLowerCase().includes("revenue")) {
                    Icon = DollarSign;
                    color = "#10b981";
                    bg = "#ecfdf5";
                  }

                  if (item.title.toLowerCase().includes("expense")) {
                    Icon = Wallet;
                    color = "#ef4444";
                    bg = "#fef2f2";
                  }

                  if (item.title.toLowerCase().includes("branch")) {
                    Icon = Building2;
                    color = "#3b82f6";
                    bg = "#eff6ff";
                  }

                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        gap: 14,
                        padding: "16px",
                        borderRadius: 14,
                        background: bg,
                        border: "1px solid rgba(0,0,0,0.05)",
                      }}
                    >
                      <div
                        style={{
                          width: 42,
                          height: 42,
                          borderRadius: 12,
                          background: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <Icon size={20} style={{ color }} />
                      </div>

                      <div>
                        <div
                          style={{
                            fontWeight: 700,
                            marginBottom: 4,
                            color,
                          }}
                        >
                          {item.title}
                        </div>

                        <div
                          style={{
                            fontSize: 13.5,
                            color: "#374151",
                            lineHeight: 1.6,
                          }}
                        >
                          {item.description}
                        </div>
                      </div>
                    </div>
                  );
                })}
          </div>
        </div>
      </div>
    </>
  );
}
