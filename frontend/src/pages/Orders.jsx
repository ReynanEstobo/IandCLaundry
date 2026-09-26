import { format } from "date-fns";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Edit2,
  LayoutGrid,
  List,
  Loader2,
  Mail,
  Minus,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
  User,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { supabase } from "../lib/supabase";
import { useRealtime } from "../lib/useRealtime";
import { sendEmail, sendSms } from "../services/api/notificationApi";
import { cancelBranchOrder, collectBranchOrderPayment, createBranchOrder, getVisibleCustomers, lookupCustomerByPhone, settleAndReleaseBranchOrder, transitionBranchOrder } from "../services/api/operationsApi";
import { useAuth } from "../context/AuthContext";
import { PageError, PageLoader } from "../components/AsyncState";
import LoadingButton from "../components/LoadingButton";
import { compareOrdersForList } from "../utils/orderListPriority";
import { isValidPhilippineMobile } from "../utils/validation";

const PROCESS_FLOW = [
  "received",
  "on_process",
  "ready",
];
const STATUS_FILTERS = ["all", ...PROCESS_FLOW, "released", "cancelled"];
const STATUS_LABELS = {
  received: "Received",
  on_process: "On Process",
  ready: "Ready for pick-up",
  released: "Released",
  cancelled: "Cancelled",
};
const STATUS_ICONS = {
  received: "\uD83D\uDCE5",
  on_process: "\u2699\uFE0F",
  ready: "\u2705",
  released: "\uD83D\uDCE6",
  cancelled: "\u274C",
};

const BRANCHES = [
  "Main - Brgy 7",
  "2nd Branch - Brgy Calzada",
  "3rd Branch - Nasugbu",
];

function formatOrderEta(order) {
  if (!order?.estimated_ready_at) return "ETA unavailable";
  return new Date(order.estimated_ready_at).toLocaleString("en-PH", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function isOrderOverdue(order) {
  return ["received", "on_process"].includes(order?.status)
    && Boolean(order?.estimated_ready_at)
    && new Date(order.estimated_ready_at).getTime() < Date.now();
}

async function sendReadyEmail(order, customerName, customerEmail) {
  if (!customerEmail) return;
  try {
    const res = await sendEmail({
        to: customerEmail,
        subject: `Your Laundry is Ready for Pickup! (Tracking #: ${order.order_number})`,
        body: `Hi ${customerName || "Customer"},\n\nGreat news! Your laundry is now ready for pickup at I&C Laundry.\n\nTracking Number: ${order.order_number}\n\nPlease pick it up at your earliest convenience during our business hours.\n\nThank you for choosing I&C Laundry!\n\n-- I&C Laundry Team`,
    });
    if (res.success) {
      toast.success(`Email notification sent to ${customerEmail}`);
    }
  } catch {
    // Silently fail - email is best-effort (won't work in local dev, only on Netlify)
  }
}

async function sendOrderSMS(
  phone,
  orderNumber,
  customerName,
  serviceName,
  weightKg,
  totalPrice,
  estimatedReadyAt,
) {
  if (!phone) return;
  try {
    const etaText = estimatedReadyAt
      ? new Date(estimatedReadyAt).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "to be confirmed";

    const message = `Hi ${customerName || "Customer"}! Your laundry order has been received.\n\nTracking #: ${orderNumber}\nService: ${serviceName}\nWeight: ${weightKg}kg\nTotal: P${totalPrice.toLocaleString()}\nEstimated ready for pickup: ${etaText}\n\nTrack your order at our website using your tracking number.\n\nWe'll notify you when it's ready. Thank you! - I&C Laundry`;

    await sendSms({ phone, message });
  } catch {
    // Silently fail - SMS is best-effort
  }
}

async function sendReadySMS(phone, orderNumber, customerName) {
  if (!phone) return;
  try {
    const message = `Hi ${customerName || "Customer"}! Your laundry (Tracking #: ${orderNumber}) is now READY for pickup. Please visit I&C Laundry at your earliest convenience. Thank you!`;

    await sendSms({ phone, message });
  } catch {
    // Silently fail
  }
}

async function sendOrderReceivedEmail(
  orderNumber,
  customerName,
  customerEmail,
  serviceName,
  weightKg,
  totalPrice,
  estimatedReadyAt,
) {
  if (!customerEmail) return;
  try {
    const completionText = estimatedReadyAt
      ? new Date(estimatedReadyAt).toLocaleString("en-PH", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "to be confirmed";

    const res = await sendEmail({
        to: customerEmail,
        subject: `Order Received! (Tracking #: ${orderNumber})`,
        body: `Hi ${customerName || "Customer"},\n\nThank you for choosing I&C Laundry! Your garment has been received.\n\nOrder Details:\n- Tracking Number: ${orderNumber}\n- Service: ${serviceName}\n- Weight: ${weightKg} kg\n- Total: P${totalPrice.toLocaleString()}\n\nEstimated ready-for-pickup time: ${completionText}\n\nYou can track your order anytime on our website using your tracking number. We'll notify you once it is ready for pickup.\n\nThank you!\n\n-- I&C Laundry Team`,
    });
    if (res.success) {
      toast.success(`Order confirmation email sent to ${customerEmail}`);
    }
  } catch {
    // Silently fail - email is best-effort
  }
}

export default function Orders() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showAdditionalPaymentModal, setShowAdditionalPaymentModal] = useState(false);
  const [additionalPayment, setAdditionalPayment] = useState({ amount: "", paymentMethod: "cash" });
  const [recordingPayment, setRecordingPayment] = useState(false);
  const [cancellingOrder, setCancellingOrder] = useState(null);
  const [cancellationReason, setCancellationReason] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [orders, setOrders] = useState([]);
  const [allOrders, setAllOrders] = useState([]);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;
  const [totalCount, setTotalCount] = useState(0);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const [customers, setCustomers] = useState([]);
  const [serviceTypes, setServiceTypes] = useState([]);
  const [soapItems, setSoapItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState("all");

  const [searchInput, setSearchInput] = useState("");
  const [settings, setSettings] = useState({});
  const [viewMode, setViewMode] = useState("table");
  const [dragOrder, setDragOrder] = useState(null);
  const [updatingOrderId, setUpdatingOrderId] = useState(null);
  const [correctionOrder, setCorrectionOrder] = useState(null);
  const [correctionTarget, setCorrectionTarget] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [tableLoading, setTableLoading] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const hasLoadedOrders = useRef(false);
  const paginationRefresh = useRef(false);

  useEffect(() => {
    if (settings?.defaultview) {
      setViewMode(settings.defaultview);
    }
  }, [settings]);

  const mappedSettings = {
    bundleKg: settings.bundlekg,
    bundlePrice: settings.bundleprice,
    addonPrice: settings.addonprice,
  };
  const BUNDLE_KG = Number(mappedSettings.bundleKg) || 8;
  const BUNDLE_PRICE = Number(mappedSettings.bundlePrice) || 200;
  const SOAP_PRICE = Number(mappedSettings.addonPrice) || 15;
  const EXCESS_KG_PRICE = Number(settings.excesskgprice) || 30;

  const [form, setForm] = useState({
    customer_id: "",
    customer_phone: "",
    customer_name: "",
    customer_email: "",
    service_type_id: "",
    weight_kg: "",
    notes: "",
    payment_method: "cash",
    payment_status: "unpaid",
    amount_paid: "",
    branch: "Main - Brgy 7",
    addons: {},
  });
  // Staff data is already branch-scoped by the backend. Admins may create an
  // order for any branch, so their add-on list is narrowed immediately when
  // the branch selection changes.
  const branchInventoryItems = isAdmin
    ? soapItems.filter((item) => item.branch === form.branch)
    : soapItems;

  const [phoneMatch, setPhoneMatch] = useState(null); // null = not searched, object = found, false = not found
  const [loyaltyPreview, setLoyaltyPreview] = useState(null);

  function calcPrice(weight, addons) {
    if (!weight || weight <= 0) return 0;

    // 🔥 BASE PRICE
    let laundryPrice = BUNDLE_PRICE;

    // 🔥 EXCESS KG AFTER 8KG
    if (weight > BUNDLE_KG) {
      const excessKg = Math.ceil(weight - BUNDLE_KG);

      laundryPrice += excessKg * EXCESS_KG_PRICE;
    }

    // 🔥 ADD-ONS
    const totalAddonUnits = Object.values(addons || {}).reduce(
      (sum, qty) => sum + qty,
      0,
    );

    return laundryPrice + totalAddonUnits * SOAP_PRICE;
  }

  function loyaltyPrice(rawTotal, reward) {
    if (!reward) return rawTotal;
    if (reward.reward_type === "percentage_discount") {
      return Math.max(0, rawTotal * (100 - Number(reward.discount_percent || 0)) / 100);
    }
    // A free-load claim covers the standard base service only. Extra weight
    // and selected add-ons remain part of the order total.
    return Math.max(0, rawTotal - BUNDLE_PRICE);
  }

  function updateAddon(itemId, delta) {
    setForm((f) => {
      const addons = { ...f.addons };
      const newQty = (addons[itemId] || 0) + delta;
      if (newQty <= 0) {
        delete addons[itemId];
      } else {
        addons[itemId] = newQty;
      }
      return { ...f, addons };
    });
  }

  const loadData = useCallback(async (background = false, tableOnly = false) => {
    if (!background) {
      setLoading(true);
      setLoadError("");
    }

    // 👇 ADD THIS BLOCK
    if (tableOnly) setTableLoading(true);

    let ordersQuery = supabase
      .from("orders")
      .select("*, customers(name, phone, email)", { count: "exact" });

    if (filter !== "all") {
      ordersQuery = ordersQuery.eq("status", filter);
    }

    // Fetch the filtered queue before slicing it. Sorting only a database page
    // caused older records to fill page one and pushed today's new order behind
    // released/cancelled entries.
    ordersQuery = ordersQuery.order("created_at", { ascending: false });

    // 👇 KEEP THIS (but replace first item)
    try {
    const [ordersRes, custRes, soapRes, servicesRes] = await Promise.all([
      ordersQuery,
      getVisibleCustomers(),
      supabase
        .from("inventory_items")
        .select("*, inventory_categories(name)")
        .order("name"),
      supabase.from("service_types").select("*").eq("is_active", true).order("name"),
    ]);

    // 🔥 fetch ALL orders for search (no pagination)
    const { data: allData } = await supabase
      .from("orders")
      .select("*, customers(name, phone, email)")
      .order("created_at", { ascending: false });

    const error = ordersRes.error || custRes.error || soapRes.error || servicesRes.error;
    if (error) throw error;

    const sortedVisible = [...(ordersRes.data || [])].sort(compareOrdersForList);
    const sortedAll = [...(allData || [])].sort(compareOrdersForList);
    setAllOrders(sortedAll);
    setOrders(sortedVisible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
    setTotalCount(sortedVisible.length);
    setCustomers(custRes.data || []);
    setSoapItems(soapRes.data || []);
    setServiceTypes(servicesRes.data || []);
    } catch (error) {
      if (!background) setLoadError(error.message || "Unable to load order data.");
      else console.error("Background order refresh failed:", error);
    } finally {
      if (!background) setLoading(false);
      if (tableOnly) setTableLoading(false);
    }
  }, [page, filter]); // ✅ ADD THIS

  useEffect(() => {
    const isInitialLoad = !hasLoadedOrders.current;
    const isPaginationRefresh = paginationRefresh.current;
    hasLoadedOrders.current = true;
    paginationRefresh.current = false;
    loadData(!isInitialLoad, isPaginationRefresh);
  }, [loadData]); // ✅ FIXED // ✅ ADD page

  useEffect(() => {
    setPage(0);
  }, [filter]);

  // Realtime: refresh when orders, customers, or inventory change
  useRealtime(["orders", "customers", "inventory_items"], () => loadData(true));
  useEffect(() => {
    async function loadSettings() {
      const { data, error } = await supabase
        .from("settings")
        .select("*")
        .single();

      if (!error && data) {
        setSettings(data);
      }
    }

    loadSettings();
  }, []);

  useRealtime(["settings"], async () => {
    const { data } = await supabase.from("settings").select("*").single();

    if (data) setSettings(data);
  });

  function goToPage(nextPage) {
    if (nextPage === page || nextPage < 0 || nextPage >= totalPages) return;
    paginationRefresh.current = true;
    setPage(nextPage);
  }

  function openNew() {
    setEditing(null);
    setForm({
      customer_id: "",
      customer_phone: "",
      customer_name: "",
      customer_email: "",
      service_type_id: "",
      weight_kg: "",
      notes: "",
      payment_method: "cash",
      payment_status: "unpaid",
      amount_paid: "",
      branch: "Main - Brgy 7",
      addons: {},
    });
    setPhoneMatch(null);
    setLoyaltyPreview(null);
    setShowModal(true);
  }

  function openEdit(order) {
    setEditing(order);
    setForm({
      customer_id: order.customer_id || "",
      customer_phone: order.customers?.phone || "",
      customer_name: order.customers?.name || "",
      customer_email: order.customers?.email || "",
      service_type_id: order.service_type_id || "",
      weight_kg: order.weight_kg,
      notes: order.notes || "",
      payment_method: order.payment_method || "cash",
      payment_status: order.payment_status,
      branch: order.branch || "",
      amount_paid:
        order.amount_paid ??
        (order.payment_status === "paid"
          ? order.total_price
          : order.payment_status === "partial"
            ? Math.ceil(order.total_price * 0.5)
            : ""),
      addons: order.addons || {},
    });
    setPhoneMatch(order.customers ? order.customers : null);
    setLoyaltyPreview(null);
    setShowModal(true);
  }

  async function lookupPhone(phone) {
    if (!phone || phone.length < 4) {
      setPhoneMatch(null);
      setLoyaltyPreview(null);
      return;
    }
    // Check the central customer directory. Only branch-visible customer details
    // are returned to staff, but a matching phone is still never duplicated.
    let result;
    try {
      result = await lookupCustomerByPhone(phone);
    } catch (error) {
      toast.error(error.message || "Unable to check the client record");
      return;
    }
    const data = result.customer || customers.find((customer) => customer.phone === phone) || null;
    setLoyaltyPreview(result.loyalty?.nextReward || null);
    if (data) {
      setPhoneMatch(data);
      setForm((f) => ({
        ...f,
        customer_id: data.id,
        customer_name: data.name,
        customer_email: data.email || "",
      }));
    } else {
      setPhoneMatch(result.exists ? { exists: true, crossBranch: true } : false);
      setForm((f) => ({
        ...f,
        customer_id: "",
        customer_name: "",
        customer_email: "",
      }));
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (savingOrder) return;
    if (!form.customer_phone.trim())
      return toast.error("Phone number is required");
    if (!isValidPhilippineMobile(form.customer_phone))
      return toast.error("Phone number must start with 09 and contain exactly 11 digits");
    if (!form.customer_name.trim())
      return toast.error("Client name is required");
    if (!editing && serviceTypes.length > 0 && !form.service_type_id)
      return toast.error("Please select a service type");
    if (isAdmin && !form.branch)
      return toast.error("Please assign this order to a branch");

    const weight = parseFloat(form.weight_kg);
    if (!weight || weight <= 0)
      return toast.error("Please enter a valid weight");

    const addonEntries = Object.entries(form.addons).filter(
      ([, qty]) => qty > 0,
    );

    // Check stock for all add-ons
    if (!editing) {
      for (const [itemId, qty] of addonEntries) {
        const item = branchInventoryItems.find((i) => i.id === itemId);
        if (!item) return toast.error("Selected item not found");
        if (item.current_stock < qty) {
          return toast.error(
            `${item.name} only has ${item.current_stock} in stock!`,
          );
        }
      }
    }

    const rawTotal = calcPrice(weight, form.addons);
    const total_price = loyaltyPrice(rawTotal, loyaltyPreview);
    const amountPaid = parseFloat(form.amount_paid) || 0;
    const minRequired = total_price * 0.5;

    // The 50% minimum applies when the order is first placed. Existing
    // records may have older payment terms and can still have their non-payment
    // details corrected without rewriting payment history.
    if (!editing && amountPaid < minRequired) {
      return toast.error(
        `Minimum 50% payment required: \u20B1${minRequired.toLocaleString()}`,
      );
    }

    // Auto-derive payment status from amount paid
    const payment_status =
      amountPaid <= 0
        ? "unpaid"
        : amountPaid >= total_price
          ? "paid"
          : "partial";

    const payload = {
      customer_id: form.customer_id || null,
      service_type_id: form.service_type_id || null,
      weight_kg: weight,
      total_price,
      addons: form.addons, // ✅ now supported
      notes: form.notes,
      ...(!editing && {
        payment_method: form.payment_method,
        payment_status,
        amount_paid: amountPaid,
      }),
      ...(isAdmin && { branch: form.branch }),

      ...(!editing && { status: "received" }),
    };

    setSavingOrder(true);
    let error, orderData;
    if (editing) {
      ({ error } = await supabase
        .from("orders")
        .update(payload)
        .eq("id", editing.id));
    } else {
      try {
        const result = await createBranchOrder({
          branch: isAdmin ? form.branch : undefined,
          bundleKg: BUNDLE_KG,
          customer: {
            name: form.customer_name.trim(),
            phone: form.customer_phone.trim(),
            email: form.customer_email.trim() || null,
          },
          order: payload,
          addons: form.addons,
          loyaltyRewardId: null,
        });
        orderData = result.data;
      } catch (createError) {
        error = { message: createError.message };
      }
    }

    if (error) {
      setSavingOrder(false);
      return toast.error(error.message);
    }

    // Track stage start time for new orders
    if (false && !editing && orderData) {
    }

    // New orders are stock-validated and deducted atomically by the backend
    // for the selected branch. This legacy client-side code remains disabled.
    if (false && !editing && orderData) {
      try {
        // 🔥 1. Compute loads
        const loads = Math.ceil(weight / BUNDLE_KG);

        // 🔥 2. Get ALL inventory items
        const { data: allItems, error } = await supabase
          .from("inventory_items")
          .select("*");

        if (error) throw error;

        const operations = [];

        for (const item of allItems) {
          const usagePerLoad = Number(item.usage_per_load) || 0;

          // ✅ DEFAULT deduction (always applies)
          const defaultDeduction = usagePerLoad * loads;

          // ✅ ADD-ON deduction (only if selected)
          const addonQty = form.addons[item.id] || 0;

          // ✅ TOTAL deduction
          const totalDeduction = defaultDeduction + addonQty;

          if (totalDeduction <= 0) continue;

          const newStock = Math.max(
            0,
            Number(item.current_stock) - totalDeduction,
          );

          // 🔥 Update stock
          operations.push(
            supabase
              .from("inventory_items")
              .update({ current_stock: newStock })
              .eq("id", item.id),
          );

          // 🔥 Log usage
          operations.push(
            supabase.from("inventory_usage_log").insert({
              item_id: item.id,
              quantity_used: totalDeduction,
              order_id: orderData.id,
            }),
          );
        }

        await Promise.all(operations);
      } catch (err) {
        console.error("Inventory deduction error:", err);
        toast.error("Failed to deduct inventory");
      }
    }

    // Send order received email for new orders
    if (
      !editing &&
      orderData &&
      (form.customer_email.trim() || phoneMatch?.email)
    ) {
      const email = form.customer_email.trim() || phoneMatch?.email;
      sendOrderReceivedEmail(
        orderData.order_number,
        form.customer_name.trim(),
        email,
        "Laundry Service",
        weight,
        total_price,
        orderData.estimated_ready_at,
      );
    }

    // Send order received SMS for new orders
    if (!editing && orderData && form.customer_phone.trim()) {
      sendOrderSMS(
        form.customer_phone.trim(),
        orderData.order_number,
        form.customer_name.trim(),
        "Laundry Service",
        weight,
        total_price,
        orderData.estimated_ready_at,
      );
    }

    toast.success(editing ? "Order updated!" : "Order created!");
    setShowModal(false);
    await loadData(true);
    setSavingOrder(false);
  }

  async function completePaymentAndRelease() {
    if (!selectedOrder) return;

    const total = Number(selectedOrder.total_price) || 0;

    // ✅ same fallback logic
    const paid =
      Number(selectedOrder.amount_paid) ||
      (selectedOrder.payment_status === "partial"
        ? total * 0.5
        : selectedOrder.payment_status === "paid"
          ? total
          : 0);

    const pay = Math.max(0, total - paid);

    if (pay <= 0) return toast.error("Enter valid amount");

    const newTotalPaid = paid + pay;

    if (newTotalPaid < total) {
      return toast.error("Full payment required before release");
    }

    setUpdatingOrderId(selectedOrder.id);
    try {
      await settleAndReleaseBranchOrder(selectedOrder.id);
    } catch (transitionError) {
      toast.error(transitionError.message || "Unable to release the order");
      setUpdatingOrderId(null);
      return;
    }

    toast.success("Order released successfully");

    setShowPaymentModal(false);
    setSelectedOrder(null);
    await loadData(true);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    setUpdatingOrderId(null);
  }

  function openAdditionalPayment(order) {
    const remaining = Math.max(0, Number(order.total_price || 0) - Number(order.amount_paid || 0));
    if (remaining <= 0) return toast.error("This order is already fully paid.");
    setSelectedOrder(order);
    setAdditionalPayment({ amount: "", paymentMethod: order.payment_method || "cash" });
    setShowAdditionalPaymentModal(true);
  }

  async function recordAdditionalPayment() {
    if (!selectedOrder) return;
    const amount = Number(additionalPayment.amount);
    const remaining = Math.max(0, Number(selectedOrder.total_price || 0) - Number(selectedOrder.amount_paid || 0));
    if (!Number.isFinite(amount) || amount <= 0) return toast.error("Enter a payment amount greater than zero.");
    if (amount > remaining + 0.005) return toast.error(`Payment cannot exceed the ₱${remaining.toLocaleString()} remaining balance.`);

    setRecordingPayment(true);
    try {
      await collectBranchOrderPayment(selectedOrder.id, amount, additionalPayment.paymentMethod);
      toast.success(`₱${amount.toLocaleString()} payment recorded.`);
      setShowAdditionalPaymentModal(false);
      setSelectedOrder(null);
      await loadData(true);
    } catch (error) {
      toast.error(error.message || "Unable to record the payment.");
    } finally {
      setRecordingPayment(false);
    }
  }

  async function updateStatus(order, newStatus, correctionNote = "") {
    if (newStatus === "released") {
      const total = Number(order.total_price) || 0;

      // ✅ handle downpayment / partial safely
      const paid =
        Number(order.amount_paid) ||
        (order.payment_status === "paid"
          ? total
          : order.payment_status === "partial"
            ? total * 0.5
            : 0);

      const remaining = total - paid;

      if (remaining > 0) {
        setSelectedOrder(order);
        setShowPaymentModal(true);
        return;
      }
    }

    setUpdatingOrderId(order.id);
    try {
      if (PROCESS_FLOW.includes(newStatus) || newStatus === "released") {
        await transitionBranchOrder(order.id, newStatus, correctionNote);
      } else {
        const { error } = await supabase
          .from("orders")
          .update({ status: newStatus, picked_up_at: newStatus === "released" ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
          .eq("id", order.id);
        if (error) throw error;
      }
    } catch (error) {
      toast.error(error.message || "Unable to update the order stage");
      setUpdatingOrderId(null);
      return false;
    }

    toast.success(`Status → ${STATUS_LABELS[newStatus]}`);

    if (newStatus === "ready") {
      if (order.customers?.email) {
        sendReadyEmail(order, order.customers.name, order.customers.email);
      }
      if (order.customers?.phone) {
        sendReadySMS(
          order.customers.phone,
          order.order_number,
          order.customers.name,
        );
      }
    }

    await loadData(true);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    setUpdatingOrderId(null);
    return true;
  }
  async function advanceStatus(order) {
    if (updatingOrderId === order.id) return;
    const idx = PROCESS_FLOW.indexOf(order.status);
    if (idx < 0 || idx >= PROCESS_FLOW.length - 1) return;
    updateStatus(order, PROCESS_FLOW[idx + 1]);
  }

  function canDropIntoStage(order, targetStatus) {
    const currentIndex = PROCESS_FLOW.indexOf(order?.status);
    const targetIndex = PROCESS_FLOW.indexOf(targetStatus);
    return currentIndex >= 0 && targetIndex >= 0 && Math.abs(targetIndex - currentIndex) === 1;
  }

  function openCorrection(order, targetStatus) {
    setDragOrder(null);
    setCorrectionOrder(order);
    setCorrectionTarget(targetStatus);
    setCorrectionReason("");
  }

  async function confirmCorrection(event) {
    event.preventDefault();
    if (!correctionOrder || !correctionTarget || !correctionReason.trim()) {
      return toast.error("Please provide a reason for this correction");
    }
    const changed = await updateStatus(correctionOrder, correctionTarget, correctionReason.trim());
    if (changed) {
      setCorrectionOrder(null);
      setCorrectionTarget("");
      setCorrectionReason("");
      toast.success("Order stage corrected and recorded in history");
    }
  }

  function handleDragStart(event, order) {
    // Only active, forward-movable orders can be dragged. This preserves the
    // sequential Received → On Process → Ready workflow.
    if (updatingOrderId === order.id || PROCESS_FLOW.indexOf(order.status) < 0) {
      event.preventDefault();
      return;
    }
    setDragOrder(order);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", order.id);
  }

  function handleDragEnd() {
    setDragOrder(null);
  }

  function handleDragOver(event, targetStatus) {
    if (!canDropIntoStage(dragOrder, targetStatus)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleDrop(event, targetStatus) {
    event.preventDefault();
    const order = dragOrder;
    setDragOrder(null);
    if (!canDropIntoStage(order, targetStatus)) return;
    if (PROCESS_FLOW.indexOf(targetStatus) < PROCESS_FLOW.indexOf(order.status)) {
      openCorrection(order, targetStatus);
    } else {
      updateStatus(order, targetStatus);
    }
  }

  function openCancellation(order) {
    setCancellingOrder(order);
    setCancellationReason("");
  }

  async function confirmCancellation() {
    if (!cancellationReason.trim()) return toast.error("Please enter a cancellation reason");
    if (!cancellingOrder || isCancelling) return;
    setIsCancelling(true);
    try {
      await cancelBranchOrder(cancellingOrder.id, cancellationReason.trim());
      toast.success("Order cancelled and branch inventory restored");
      setCancellingOrder(null);
      setCancellationReason("");
      loadData(true);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setIsCancelling(false);
    }
  }

  function toggleView(mode) {
    setViewMode(mode);
  }

  const source = searchInput ? allOrders : orders;

  const filtered = source
    .filter((o) => {
      if (!searchInput) return true;

      const q = searchInput.toLowerCase();

      return (
        o.order_number?.toLowerCase().includes(q) ||
        o.customers?.name?.toLowerCase().includes(q)
      );
    })
    .sort(compareOrdersForList);

  if (loading) return <PageLoader label="Loading orders…" />;
  if (loadError) return <PageError message={loadError} onRetry={loadData} />;

  return (
    <>
      {/* Toolbar */}
      <div className="garment-toolbar">
        <div className="garment-filters">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              className={`garment-filter-btn ${filter === s ? "active" : ""}`}
              onClick={() => setFilter(s)}
              aria-pressed={filter === s}
            >
              {s !== "all" && (
                <span className="garment-filter-icon">{STATUS_ICONS[s]}</span>
              )}
              {s === "all" ? "All" : STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <div className="garment-toolbar-actions">
          <div className="search-box">
            <Search />
            <input
              placeholder="Search orders..."
              aria-label="Search by order number or customer name"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div className="view-toggle">
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === "table" ? "active" : ""}`}
              onClick={() => toggleView("table")}
              title="Table view"
              aria-label="Use table view"
              aria-pressed={viewMode === "table"}
            >
              <List size={16} />
            </button>
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === "board" ? "active" : ""}`}
              onClick={() => toggleView("board")}
              title="Board view"
              aria-label="Use board view"
              aria-pressed={viewMode === "board"}
            >
              <LayoutGrid size={16} />
            </button>
          </div>
          <button type="button" className="btn btn-primary" onClick={openNew}>
            <Plus size={18} /> New Order
          </button>
        </div>
      </div>

      {/* Kanban Board */}
      {viewMode === "board" && (
        <div className="kanban-board">
          {PROCESS_FLOW.map((status) => {
            const columnOrders = filtered.filter((o) => o.status === status);
            return (
              <div
                key={status}
                className={`kanban-column ${dragOrder && canDropIntoStage(dragOrder, status) ? "drag-active" : ""}`}
                data-stage={status}
                onDragOver={(event) => handleDragOver(event, status)}
                onDrop={(event) => handleDrop(event, status)}
              >
                <div className="kanban-column-header">
                  <div className="kanban-column-title">
                    <span className="kanban-column-icon">
                      {STATUS_ICONS[status]}
                    </span>
                    <span>{STATUS_LABELS[status]}</span>
                    <span className="kanban-count">{columnOrders.length}</span>
                  </div>
                </div>
                <div className="kanban-cards">
                  {columnOrders.length === 0 ? (
                    <div className="kanban-empty">No orders</div>
                  ) : (
                    columnOrders.map((order) => {
                      return (
                        <div
                          key={order.id}
                          className={`kanban-card ${dragOrder?.id === order.id ? "is-dragging" : ""}`}
                          draggable={updatingOrderId !== order.id && PROCESS_FLOW.includes(order.status)}
                          onDragStart={(event) => handleDragStart(event, order)}
                          onDragEnd={handleDragEnd}
                        >
                          <div className="kanban-card-header">
                            <span className="kanban-order-num">
                              #{order.order_number}
                            </span>
                            <span
                              className={`kanban-payment-badge badge-${order.payment_status}`}
                            >
                              {order.payment_status}
                            </span>
                          </div>
                          <div className="kanban-card-customer">
                            <User size={11} />
                            <span>{order.customers?.name || "Walk-in"}</span>
                          </div>
                          {isAdmin && (
                            <div
                              style={{
                                fontSize: 11,
                                color: "var(--text-muted)",
                                marginTop: 4,
                              }}
                            >
                              Branch: {order.branch || "Unassigned"}
                            </div>
                          )}
                          <div className="kanban-card-details">
                            <span className="kanban-card-kg">
                              {order.weight_kg}kg
                            </span>
                            <span className="kanban-card-price">
                              {"\u20B1"}
                              {(Number(order.total_price) || 0).toLocaleString(
                                undefined,
                                {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                },
                              )}
                            </span>
                          </div>
                          {!["ready", "released", "cancelled"].includes(order.status) && (
                            <div className="kanban-timer-row">
                              <span className="timer-pill live"><Clock size={10} /> Ready by {formatOrderEta(order)}</span>
                            </div>
                          )}
                          {isOrderOverdue(order) && (
                            <div className="kanban-order-alert"><TriangleAlert size={11} /> ETA overdue</div>
                          )}
                          {order.eta_revised_at && <div className="kanban-order-note">ETA revised after correction</div>}
                          <div className="kanban-card-actions">
                            {PROCESS_FLOW.includes(order.status) && order.status !== "received" && (
                              <button
                                className="btn-icon"
                                disabled={updatingOrderId === order.id}
                                title={`Move back to ${STATUS_LABELS[PROCESS_FLOW[PROCESS_FLOW.indexOf(order.status) - 1]]}`}
                                onClick={() => openCorrection(order, PROCESS_FLOW[PROCESS_FLOW.indexOf(order.status) - 1])}
                              >
                                <RotateCcw size={12} />
                              </button>
                            )}
                            {PROCESS_FLOW.includes(order.status) && order.status !== "ready" && (
                              <button
                                className="btn-icon"
                                disabled={updatingOrderId === order.id}
                                title={order.status === "received" ? "Start Processing" : "Mark Ready for Pickup"}
                                onClick={() => advanceStatus(order)}
                              >
                                {updatingOrderId === order.id ? <Loader2 size={12} className="button-spinner" /> : <ArrowRight size={12} />}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Table */}
      {viewMode === "table" && (
        <div className="card" style={{ padding: 0 }}>
          <div className={`table-wrapper orders-table-wrapper ${tableLoading ? "is-refreshing" : ""}`}>
            <table className="orders-table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Customer</th>
                  {isAdmin && <th className="orders-column-branch">Branch</th>}
                  <th className="orders-column-weight">Weight</th>
                  <th>Status</th>
                  <th className="orders-column-eta">Estimated Ready</th>
                  <th className="orders-column-payment">Payment</th>
                  <th>Amount</th>
                  <th className="orders-column-date">Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={isAdmin ? 10 : 9} className="empty-state">
                      <p>{searchInput || filter !== "all" ? "No orders match the current search or status filter." : "No orders have been created yet."}</p>
                      {(searchInput || filter !== "all") && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setSearchInput(""); setFilter("all"); }}>
                          Clear filters
                        </button>
                      )}
                    </td>
                  </tr>
                ) : (
                  filtered.map((order) => (
                    <tr key={order.id} className="orders-table-row">
                      <td
                        style={{
                          fontWeight: 600,
                          color: "var(--text-primary)",
                        }}
                      >
                        {order.order_number}
                      </td>
                      <td>{order.customers?.name || "Walk-in"}</td>
                      {isAdmin && (
                        <td className="orders-column-branch" style={{ fontSize: 13 }}>
                          {order.branch || "Unassigned"}
                        </td>
                      )}
                      <td className="orders-column-weight">{order.weight_kg} kg</td>
                      <td>
                        <div className="status-track">
                          <div className="status-dots">
                            {PROCESS_FLOW.map((s, i) => {
                              const currentIdx = order.status === "released" ? PROCESS_FLOW.length - 1 : PROCESS_FLOW.indexOf(order.status);
                              const isDone = i <= currentIdx;
                              return (
                                <div
                                  key={s}
                                  className="status-dot-group"
                                  title={STATUS_LABELS[s]}
                                >
                                  {i > 0 && (
                                    <div
                                      className={`status-line ${isDone ? "filled" : ""}`}
                                    />
                                  )}
                                  <div
                                    className={`status-dot ${isDone ? "filled" : ""} ${i === currentIdx ? "current" : ""}`}
                                  />
                                </div>
                              );
                            })}
                          </div>
                          <div className="status-track-label">
                            <span className={`badge badge-${order.status}`}>
                              {STATUS_LABELS[order.status]}
                            </span>
                            {PROCESS_FLOW.includes(order.status) && order.status !== "ready" && (
                              <button
                                className="status-next-btn"
                                disabled={updatingOrderId === order.id}
                                onClick={() => advanceStatus(order)}
                                title={order.status === "received" ? "Start Processing" : "Mark Ready for Pickup"}
                              >
                                {updatingOrderId === order.id ? <Loader2 size={14} className="button-spinner" /> : <ArrowRight size={14} />}
                              </button>
                            )}
                            {PROCESS_FLOW.includes(order.status) && order.status !== "received" && (
                              <button
                                className="status-next-btn status-undo-btn"
                                disabled={updatingOrderId === order.id}
                                onClick={() => openCorrection(order, PROCESS_FLOW[PROCESS_FLOW.indexOf(order.status) - 1])}
                                title={`Correct back to ${STATUS_LABELS[PROCESS_FLOW[PROCESS_FLOW.indexOf(order.status) - 1]]}`}
                              >
                                <RotateCcw size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="order-eta-cell orders-column-eta">
                        {['released', 'cancelled'].includes(order.status) ? (
                          <span className="order-eta-unavailable">—</span>
                        ) : (
                          <div className="order-eta-content">
                            <span className="order-eta-primary">
                              <Clock size={15} aria-hidden="true" />
                              {formatOrderEta(order)}
                            </span>
                            {(isOrderOverdue(order) || order.eta_revised_at) && (
                              <div className="order-eta-meta">
                                {isOrderOverdue(order) && <span className="order-eta-warning"><TriangleAlert size={13} /> Overdue</span>}
                                {order.eta_revised_at && <span className="order-eta-revised">ETA updated</span>}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="orders-column-payment">
                        <span className={`badge badge-${order.payment_status}`}>
                          {order.payment_status}
                        </span>
                      </td>
                      <td
                        style={{
                          fontWeight: 600,
                          color: "var(--text-primary)",
                        }}
                      >
                        {"\u20B1"}
                        {(Number(order.total_price) || 0).toLocaleString(
                          undefined,
                          {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          },
                        )}
                      </td>
                      <td className="orders-column-date" style={{ color: "var(--text-muted)", fontSize: 13 }}>
                        {format(new Date(order.created_at), "MMM d, h:mm a")}
                      </td>
                      <td>
                        <div className="orders-row-actions">
                          {order.status !== "cancelled" && (
                            <button
                              className="btn-icon"
                              title="Edit"
                              onClick={() => openEdit(order)}
                            >
                              <Edit2 size={16} />
                            </button>
                          )}
                          {!['released', 'cancelled'].includes(order.status) && Number(order.amount_paid || 0) < Number(order.total_price || 0) && (
                            <button
                              className="btn-icon"
                              title="Record additional payment"
                              onClick={() => openAdditionalPayment(order)}
                            >
                              <Plus size={16} />
                            </button>
                          )}
                          {order.status === "ready" && (
                            <button className="btn-icon" title="Release order after pickup/payment" onClick={() => updateStatus(order, "released")}>
                              <CheckCircle2 size={16} />
                            </button>
                          )}
                          {!['released', 'cancelled'].includes(order.status) && (
                            <button
                              className="btn-icon"
                              title="Cancel order"
                              onClick={() => openCancellation(order)}
                              style={{ color: "var(--danger)" }}
                            >
                              <X size={16} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {!searchInput && (
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
                    onClick={() => goToPage(0)}
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
                    onClick={() => goToPage(page - 1)}
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

                    let start = Math.max(0, page - 1);
                    let end = Math.min(totalPages, start + 3);

                    if (end - start < 3) {
                      start = Math.max(0, end - 3);
                    }

                    for (let i = start; i < end; i++) {
                      const isActive = i === page;

                      pages.push(
                        <button
                          key={i}
                          onClick={() => goToPage(i)}
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
                    onClick={() => goToPage(page + 1)}
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
                    onClick={() => goToPage(totalPages - 1)}
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
                  {searchInput
                    ? `${filtered.length} results found`
                    : totalCount === 0
                      ? "0 of 0"
                      : `${page * PAGE_SIZE + 1}–${Math.min(
                          (page + 1) * PAGE_SIZE,
                          totalCount,
                        )} out of ${totalCount}`}
                </div>
              </div>
            )}
            {tableLoading && (
              <div className="orders-table-loading" role="status" aria-live="polite">
                <Loader2 size={22} className="button-spinner" />
                <span>Loading orders…</span>
              </div>
            )}
          </div>
        </div>
      )}

      {correctionOrder && (
        <div className="modal-overlay" onMouseDown={() => !updatingOrderId && setCorrectionOrder(null)}>
          <section className="order-correction-dialog" role="dialog" aria-modal="true" aria-labelledby="correction-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="order-correction-icon"><RotateCcw size={22} /></div>
            <h3 id="correction-title">Correct order stage</h3>
            <p>
              Move <strong>{correctionOrder.order_number}</strong> back from {STATUS_LABELS[correctionOrder.status]} to <strong>{STATUS_LABELS[correctionTarget]}</strong>.
              This correction is recorded in the order history and may revise the customer ETA.
            </p>
            <form onSubmit={confirmCorrection}>
              <label htmlFor="correction-reason">Reason for correction</label>
              <textarea
                id="correction-reason"
                className="form-control"
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value)}
                placeholder="Example: Order was marked ready by mistake"
                rows={3}
                required
                autoFocus
              />
              <div className="order-correction-actions">
                <button type="button" className="btn btn-secondary" disabled={Boolean(updatingOrderId)} onClick={() => setCorrectionOrder(null)}>Keep current stage</button>
                <button type="submit" className="btn btn-primary" disabled={Boolean(updatingOrderId)}>
                  {updatingOrderId ? <><Loader2 size={16} className="button-spinner" /> Saving…</> : <><RotateCcw size={16} /> Confirm correction</>}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="order-modal" onClick={(e) => e.stopPropagation()}>
            <div className="order-modal-header">
              <div>
                <h3>{editing ? "Edit Order" : "New Order"}</h3>
                <p>
                  {editing
                    ? `Order #${editing.order_number}`
                    : "Fill in the details below"}
                </p>
              </div>
              <button className="btn-icon" onClick={() => setShowModal(false)}>
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="order-modal-body">
                {/* Section: Customer & Service */}
                <div className="order-section">
                  <div className="order-section-title">Client & Service</div>
                  <div className="form-row">
                    {serviceTypes.length > 0 && (
                      <div className="form-group">
                        <label>Service Type *</label>
                        <select
                          className="form-control"
                          value={form.service_type_id}
                          onChange={(e) => setForm((f) => ({ ...f, service_type_id: e.target.value }))}
                          required={!editing}
                        >
                          <option value="">Select service</option>
                          {serviceTypes.map((service) => (
                            <option key={service.id} value={service.id}>
                              {service.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="form-group">
                      <label>Phone Number *</label>
                      <input
                        className="form-control"
                        placeholder="09171234567"
                        type="tel"
                        maxLength={11}
                        inputMode="numeric"
                        pattern="09[0-9]{9}"
                        value={form.customer_phone}
                        onChange={(e) => {
                          // REMOVE NON-NUMBERS
                          const phone = e.target.value
                            .replace(/\D/g, "")
                            .slice(0, 11);

                          setForm((f) => ({
                            ...f,
                            customer_phone: phone,
                          }));

                          if (phone.length === 11) {
                            lookupPhone(phone);
                          } else {
                            setPhoneMatch(null);

                            setForm((f) => ({
                              ...f,
                              customer_id: "",
                              customer_name: "",
                              customer_email: "",
                            }));
                          }
                        }}
                        required
                      />
                      {phoneMatch && phoneMatch.id && (
                        <div
                          style={{
                            marginTop: 4,
                            fontSize: 12,
                            color: "#059669",
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <CheckCircle2 size={13} /> Existing central client:{" "}
                          {phoneMatch.name}
                        </div>
                      )}
                      {phoneMatch === false &&
                        form.customer_phone.length >= 11 && (
                          <div
                            style={{
                              marginTop: 4,
                              fontSize: 12,
                              color: "#d97706",
                            }}
                          >
                            New client — will be registered automatically
                          </div>
                        )}
                      {phoneMatch?.crossBranch && (
                        <div style={{ marginTop: 4, fontSize: 12, color: "#2563eb" }}>
                          Existing central client found — this order will be linked to this branch without creating a duplicate.
                        </div>
                      )}
                    </div>
                    <div className="form-group">
                      <label>Client Name *</label>
                      <input
                        className="form-control"
                        placeholder="Juan Dela Cruz"
                        value={form.customer_name}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            customer_name: e.target.value,
                          }))
                        }
                        required
                        disabled={!!(phoneMatch && phoneMatch.id)}
                      />
                    </div>
                    {isAdmin && (
                      <div className="form-group">
                        <label>Branch *</label>
                        <select
                          className="form-control"
                          value={form.branch}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, branch: e.target.value, addons: {} }))
                          }
                          required
                        >
                          <option value="">Select branch</option>
                          {BRANCHES.map((branch) => (
                            <option key={branch} value={branch}>
                              {branch}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                  {/* Show email input for new clients */}
                  {phoneMatch === false && form.customer_phone.length >= 11 && (
                    <div className="form-group">
                      <label>Client Email</label>
                      <input
                        className="form-control"
                        type="email"
                        placeholder="email@example.com"
                        value={form.customer_email}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            customer_email: e.target.value,
                          }))
                        }
                      />
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          marginTop: 2,
                          display: "block",
                        }}
                      >
                        <Mail
                          size={11}
                          style={{
                            display: "inline",
                            verticalAlign: "middle",
                            marginRight: 4,
                          }}
                        />
                        For pickup notifications
                      </span>
                    </div>
                  )}
                  <div className="form-row">
                    <div className="form-group">
                      <label>Weight (kg) *</label>
                      <input
                        className="form-control"
                        type="number"
                        step="0.1"
                        min="0.1"
                        placeholder="e.g. 3.5"
                        value={form.weight_kg}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, weight_kg: e.target.value }))
                        }
                        required
                      />
                    </div>
                  </div>
                </div>

                {/* Section: Add-ons */}
                <div className="order-section">
                  <div className="order-section-title">
                    Add-ons{" "}
                    <span className="order-section-optional">
                      ₱{SOAP_PRICE} each
                    </span>
                  </div>
                  <div className="addon-grid">
                    {branchInventoryItems.map((item) => {
                      const qty = form.addons[item.id] || 0;
                      const noStock = item.current_stock < 1 && qty === 0;
                      return (
                        <div
                          key={item.id}
                          className={`addon-item ${qty > 0 ? "selected" : ""} ${noStock ? "out-of-stock" : ""}`}
                        >
                          <div className="addon-info">
                            <span className="addon-name">{item.name}</span>
                            <span className="addon-stock">
                              {item.current_stock} {item.unit} in stock
                            </span>
                          </div>
                          <div className="addon-qty">
                            {qty > 0 && (
                              <button
                                type="button"
                                className="addon-btn"
                                onClick={() => updateAddon(item.id, -1)}
                              >
                                <Minus size={14} />
                              </button>
                            )}
                            {qty > 0 && (
                              <span className="addon-count">{qty}</span>
                            )}
                            <button
                              type="button"
                              className="addon-btn addon-btn-add"
                              onClick={() => updateAddon(item.id, 1)}
                              disabled={noStock || qty >= item.current_stock}
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {Object.keys(form.addons).length > 0 && (
                    <div className="soap-selected-info">
                      <CheckCircle2 size={15} />
                      <span>
                        {Object.entries(form.addons)
                          .filter(([, qty]) => qty > 0)
                          .map(([id, qty]) => {
                            const item = branchInventoryItems.find(
                              (i) => String(i.id) === String(id),
                            );
                            return `${item?.name || "Item"} ×${qty}`;
                          })
                          .join(", ")}{" "}
                        — will be deducted from inventory
                      </span>
                    </div>
                  )}
                </div>

                {/* Price Breakdown */}
                <div className="order-section">
                  {!editing && loyaltyPreview && (
                    <div className="account-security-notice" style={{ marginBottom: 14 }}>
                      <CheckCircle2 size={16} />
                      <span><strong>Loyalty reward applied automatically:</strong> {loyaltyPreview.reward_type === "percentage_discount" ? `${loyaltyPreview.discount_percent}% off this entire order, including add-ons and excess kg.` : "one free 8 kg standard load; add-ons and excess kg remain payable."}</span>
                    </div>
                  )}
                  <div className="pricing-card">
                    <div className="pricing-header">Price Breakdown</div>
                    <div className="pricing-row">
                      <span>
                        Laundry (
                        {form.weight_kg
                          ? parseFloat(form.weight_kg) <= BUNDLE_KG
                            ? `₱${BUNDLE_PRICE} minimum (${BUNDLE_KG}kg below)`
                            : `₱${BUNDLE_PRICE} + ₱${EXCESS_KG_PRICE}/kg excess`
                          : `₱${BUNDLE_PRICE} minimum for ${BUNDLE_KG}kg`}
                        )
                      </span>
                      <span>
                        ₱
                        {form.weight_kg
                          ? (() => {
                              const weight = parseFloat(form.weight_kg) || 0;

                              if (weight <= BUNDLE_KG) {
                                return BUNDLE_PRICE;
                              }

                              return (
                                BUNDLE_PRICE +
                                Math.ceil(weight - BUNDLE_KG) * EXCESS_KG_PRICE
                              );
                            })().toLocaleString()
                          : "0"}
                      </span>
                    </div>
                    {Object.entries(form.addons)
                      .filter(([, qty]) => qty > 0)
                      .map(([id, qty]) => {
                        const item = branchInventoryItems.find((i) => i.id === id);
                        return (
                          <div key={id} className="pricing-row">
                            <span>
                              {item?.name || "Add-on"} ×{qty}
                            </span>
                            <span>₱{(qty * SOAP_PRICE).toLocaleString()}</span>
                          </div>
                        );
                      })}
                    {(() => {
                      const rawTotal = calcPrice(parseFloat(form.weight_kg) || 0, form.addons);
                      const reward = loyaltyPreview;
                      const total = loyaltyPrice(rawTotal, reward);
                      return <>
                        {reward && <div className="pricing-row" style={{ color: "#047857", fontWeight: 700 }}>
                          <span>{reward.reward_type === "percentage_discount" ? `${reward.discount_percent}% loyalty discount` : "Free 8 kg standard load"}</span>
                          <span>−₱{(rawTotal - total).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                        </div>}
                    <div className="pricing-total">
                      <span>{reward ? "Total after reward" : "Total"}</span>
                      <span>
                        ₱
                        {total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    </div>
                      </>;
                    })()}
                  </div>
                </div>

                {/* Section: Payment */}
                <div className="order-section">
                  <div className="order-section-title">
                    Payment{" "}
                    <span className="order-section-optional">
                      Min. 50% required
                    </span>
                  </div>
                  {editing && <div style={{ margin: "0 0 12px", color: "var(--text-muted)", fontSize: 13 }}>
                    <p style={{ margin: "0 0 8px" }}>The original payment is kept for accountability. Record an additional payment instead of changing it.</p>
                    {Number(editing.total_price || 0) > Number(editing.amount_paid || 0) && (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => {
                        setShowModal(false);
                        setEditing(null);
                        openAdditionalPayment(editing);
                      }}>
                        <Plus size={15} /> Record additional payment
                      </button>
                    )}
                  </div>}
                  <div className="form-row">
                    <div className="form-group">
                      <label>Method</label>
                      <select
                        className="form-control"
                        value={form.payment_method}
                        onChange={(e) => setForm((f) => ({ ...f, payment_method: e.target.value }))}
                        disabled={Boolean(editing)}
                      >
                        <option value="cash">Cash</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Amount Paid (₱) *</label>
                      <input
                        className="form-control"
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                        value={form.amount_paid}
                        disabled={Boolean(editing)}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            amount_paid: e.target.value,
                          }))
                        }
                        required
                      />
                      {(() => {
                        const rawTotal = calcPrice(parseFloat(form.weight_kg) || 0, form.addons);
                        const reward = loyaltyPreview;
                        const total = loyaltyPrice(rawTotal, reward);
                        const paid = parseFloat(form.amount_paid) || 0;
                        const minRequired = total * 0.5;
                        const status =
                          paid <= 0
                            ? "unpaid"
                            : paid >= total
                              ? "paid"
                              : "partial";
                        if (!form.weight_kg || total <= 0) return null;
                        return (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 12,
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <span className={`badge badge-${status}`}>
                              {status}
                            </span>
                            {paid < minRequired && (
                              <span style={{ color: "var(--danger)" }}>
                                Min: ₱{minRequired.toLocaleString()}
                              </span>
                            )}
                            {paid >= minRequired && paid < total && (
                              <span style={{ color: "#d97706" }}>
                                Balance: ₱{(total - paid).toLocaleString()}
                              </span>
                            )}
                            {paid >= total && (
                              <span style={{ color: "#059669" }}>
                                Fully paid
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* Notes */}
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Notes</label>
                  <textarea
                    className="form-control"
                    placeholder="Special instructions..."
                    rows={2}
                    value={form.notes}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, notes: e.target.value }))
                    }
                  />
                </div>
              </div>
              <div className="order-modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={savingOrder}
                  onClick={() => setShowModal(false)}
                >
                  Cancel
                </button>
                <LoadingButton type="submit" className="btn btn-primary" loading={savingOrder} loadingLabel={editing ? "Updating…" : "Creating…"}>
                  {editing ? "Update Order" : "Create Order"}
                </LoadingButton>
              </div>
            </form>
          </div>
        </div>
      )}
      {showAdditionalPaymentModal && (
        <div className="modal-overlay" onClick={() => !recordingPayment && setShowAdditionalPaymentModal(false)}>
          <div className="order-modal" onClick={(event) => event.stopPropagation()}>
            <div className="order-modal-header">
              <div>
                <h3>Record Additional Payment</h3>
                <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 13 }}>Order #{selectedOrder?.order_number}</p>
              </div>
              <button className="btn-icon" disabled={recordingPayment} onClick={() => setShowAdditionalPaymentModal(false)} aria-label="Close payment dialog">
                <X size={20} />
              </button>
            </div>
            <div className="order-modal-body">
              <div className="form-group">
                <label>Remaining Balance</label>
                <div className="form-control" style={{ display: "flex", alignItems: "center", fontWeight: 700, background: "var(--bg-secondary)" }}>
                  ₱{Math.max(0, Number(selectedOrder?.total_price || 0) - Number(selectedOrder?.amount_paid || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Method</label>
                  <select className="form-control" value={additionalPayment.paymentMethod} disabled={recordingPayment} onChange={(event) => setAdditionalPayment((current) => ({ ...current, paymentMethod: event.target.value }))}>
                    <option value="cash">Cash</option>
                    <option value="gcash">GCash</option>
                    <option value="bank_transfer">Bank transfer</option>
                    <option value="card">Card</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Amount to Add (₱)</label>
                  <input className="form-control" type="number" min="0.01" step="0.01" inputMode="decimal" autoFocus value={additionalPayment.amount} disabled={recordingPayment} onChange={(event) => setAdditionalPayment((current) => ({ ...current, amount: event.target.value }))} placeholder="0.00" />
                </div>
              </div>
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>This adds a separate, auditable payment entry. The original payment will not be changed.</p>
            </div>
            <div className="order-modal-footer">
              <button className="btn btn-secondary" disabled={recordingPayment} onClick={() => setShowAdditionalPaymentModal(false)}>Cancel</button>
              <LoadingButton className="btn btn-primary" loading={recordingPayment} loadingLabel="Recording…" onClick={recordAdditionalPayment}>Record Payment</LoadingButton>
            </div>
          </div>
        </div>
      )}
      {showPaymentModal && (
        <div
          className="modal-overlay"
          onClick={() => setShowPaymentModal(false)}
        >
          <div className="order-modal" onClick={(e) => e.stopPropagation()}>
            <div className="order-modal-header">
              <h3>Complete Payment</h3>
              <button
                className="btn-icon"
                onClick={() => setShowPaymentModal(false)}
              >
                <X size={20} />
              </button>
            </div>

            <div className="order-modal-body">
              <div className="form-group">
                <label>Remaining Amount</label>
                <div className="form-control" style={{ display: "flex", alignItems: "center", fontWeight: 700, background: "var(--bg-secondary)" }}>
                  ₱{Math.max(0, Number(selectedOrder?.total_price || 0) - Number(selectedOrder?.amount_paid || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>The payment recorded when this order was placed cannot be edited. Confirming will collect this exact remaining balance and release the order.</p>
            </div>

            <div className="order-modal-footer">
              <button
                className="btn btn-secondary"
                disabled={updatingOrderId === selectedOrder?.id}
                onClick={() => setShowPaymentModal(false)}
              >
                Cancel
              </button>
              <LoadingButton
                className="btn btn-primary"
                loading={updatingOrderId === selectedOrder?.id}
                loadingLabel="Releasing…"
                onClick={completePaymentAndRelease}
              >
                Confirm & Release
              </LoadingButton>
            </div>
          </div>
        </div>
      )}
      {cancellingOrder && (
        <div
          className="modal-overlay"
          role="presentation"
          onMouseDown={() => !isCancelling && setCancellingOrder(null)}
        >
          <div
            className="order-modal cancellation-alert"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cancel-order-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="order-modal-header">
              <div className="cancellation-alert-title">
                <span className="cancellation-alert-icon"><TriangleAlert size={22} /></span>
                <div><h3 id="cancel-order-title">Cancel this order?</h3><p>Order #{cancellingOrder.order_number}</p></div>
              </div>
              <button className="btn-icon" aria-label="Close cancellation dialog" disabled={isCancelling} onClick={() => setCancellingOrder(null)}><X size={20} /></button>
            </div>
            <div className="order-modal-body">
              <div className="cancellation-alert-message">
                <strong>This action changes the order status to Cancelled.</strong>
                <span>Used inventory is returned to <b>{cancellingOrder.branch || "this branch"}</b>. Payments are retained for audit purposes; issue a refund or correction separately when needed.</span>
              </div>
              <div className="form-group">
                <label>Cancellation reason *</label>
                <textarea autoFocus className="form-control" rows={4} disabled={isCancelling} value={cancellationReason} onChange={(event) => setCancellationReason(event.target.value)} placeholder="Explain why this order is being cancelled" />
              </div>
            </div>
            <div className="order-modal-footer">
              <button className="btn btn-secondary" disabled={isCancelling} onClick={() => setCancellingOrder(null)}>Keep Order</button>
              <button className="btn btn-danger cancellation-confirm-btn" disabled={isCancelling || !cancellationReason.trim()} onClick={confirmCancellation}>
                {isCancelling ? <><Loader2 size={16} className="spin" /> Cancelling…</> : "Cancel Order & Restore Stock"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
