import {
  BarChart3,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Package,
  PanelLeft,
  PanelLeftClose,
  Settings,
  ArchiveRestore,
  KeyRound,
  MapPin,
  ShoppingBag,
  UserCog,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const navigation = [
  { name: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
  { name: "Garment", path: "/dashboard/orders", icon: ShoppingBag },
  { name: "Client", path: "/dashboard/customers", icon: Users },
  { name: "Inventory", path: "/dashboard/inventory", icon: Package },
  { name: "Account Security", path: "/dashboard/change-password", icon: KeyRound, staffOnly: true },
  {
    name: "Analytics",
    path: "/dashboard/analytics",
    icon: BarChart3,
    adminOnly: true,
  },
  { name: "Services", path: "/dashboard/services", icon: ShoppingBag, adminOnly: true },
  {
    name: "Notifications",
    path: "/dashboard/sms",
    icon: MessageSquare,
    adminOnly: true,
  },
  { name: "Staff", path: "/dashboard/staff", icon: UserCog, adminOnly: true },
  { name: "Audit Log", path: "/dashboard/audit-log", icon: ArchiveRestore, adminOnly: true },
  {
    name: "Settings",
    path: "/dashboard/settings",
    icon: Settings,
    adminOnly: true,
  },
];

const pageNames = {
  "/dashboard": "Dashboard",
  "/dashboard/orders": "Garment",
  "/dashboard/customers": "Client",
  "/dashboard/inventory": "Inventory",
  "/dashboard/analytics": "Analytics",
  "/dashboard/services": "Services",
  "/dashboard/sms": "Notifications",
  "/dashboard/staff": "Staff",
  "/dashboard/settings": "Settings",
  "/dashboard/audit-log": "Audit Log",
  "/dashboard/recycle-bin": "Audit Log",
  "/dashboard/change-password": "Account Security",
};

export default function Layout() {
  const { signOut, user, role, staffName, branch, contactEmail } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("ic_laundry_collapsed") || localStorage.getItem("hc_laundry_collapsed")) || false
      );
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem("ic_laundry_collapsed", JSON.stringify(collapsed));
  }, [collapsed]);

  // Close mobile sidebar on nav
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // A collapsed desktop preference must not hide the contents of the mobile
  // drawer. The drawer is a full navigation surface, not the icon rail.
  const sidebarExpanded = !collapsed || mobileOpen;

  return (
    <div className={`app-layout ${collapsed ? "sidebar-collapsed" : ""}`}>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="sidebar-overlay" onClick={() => setMobileOpen(false)} />
      )}

      <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-icon">
            <img
              src="/assets/Rectangle.png"
              alt="I&C Laundry"
              style={{ width: 52, height: 52, objectFit: "contain" }}
            />
          </div>
          {sidebarExpanded && (
            <div>
              <h1>I&C Laundry</h1>
              <span>Management System</span>
            </div>
          )}
        </div>

        <nav className="sidebar-nav">
          {sidebarExpanded && <div className="sidebar-section-label">Main Menu</div>}
          {navigation
            .filter((item) => (!item.adminOnly || role === "admin") && (!item.staffOnly || role !== "admin"))
            .map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === "/dashboard"}
                className={({ isActive }) =>
                  `nav-link ${isActive ? "active" : ""}`
                }
                title={!sidebarExpanded ? item.name : undefined}
              >
                <item.icon size={19} />
                {sidebarExpanded && item.name}
              </NavLink>
            ))}
        </nav>

        <div className="sidebar-footer">
          <button
            className="nav-link"
            onClick={signOut}
            style={{ color: "#ff6b6b", fontSize: 13 }}
            title={!sidebarExpanded ? "Sign Out" : undefined}
          >
            <LogOut size={18} />
            {sidebarExpanded && "Sign Out"}
          </button>

          {/* Collapse toggle - desktop only */}
          <button
            className="sidebar-toggle-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="top-bar">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              className="mobile-menu-btn"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={22} />
            </button>
            <h2>{pageNames[location.pathname] || "Dashboard"}</h2>
          </div>
          <div className="top-bar-actions">
            <div
              style={{
                fontSize: 13,
                color: "#6b7280",
                fontWeight: 400,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {new Date().toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </div>
            <div className="top-bar-user">
              <div className="top-bar-avatar">
                {(staffName || user?.email || "A")[0].toUpperCase()}
              </div>
              <div className="top-bar-user-info">
                <span className="top-bar-user-name">
                  {staffName || (role === "admin" ? "Admin" : "Staff")}
                </span>
                <span className="top-bar-user-email">{contactEmail || (/@accounts\.(?:hc|ic)laundry\.local$/i.test(user?.email || '') ? 'Staff account' : user?.email)}</span>
                {role !== "admin" && branch && (
                  <span className="top-bar-user-branch" title={`Assigned branch: ${branch}`}>
                    <MapPin size={11} aria-hidden="true" />
                    {branch}
                  </span>
                )}
              </div>
            </div>
          </div>
        </header>
        <div className="page-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
