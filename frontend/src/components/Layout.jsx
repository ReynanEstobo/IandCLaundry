import {
  BarChart3,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Package,
  PanelLeft,
  PanelLeftClose,
  Settings,
  ArchiveRestore,
  KeyRound,
  MapPin,
  ShoppingBag,
  Shirt,
  Sun,
  UserCog,
  Users,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import useUserTheme from "../hooks/useUserTheme";

// Items are grouped by the kind of work they support; a section label is shown
// whenever the group changes in the visible list.
const navigation = [
  { name: "Dashboard", path: "/dashboard", icon: LayoutDashboard, group: "Operations" },
  { name: "Orders", path: "/dashboard/orders", icon: ShoppingBag, group: "Operations" },
  { name: "Customers", path: "/dashboard/customers", icon: Users, group: "Operations" },
  { name: "Inventory", path: "/dashboard/inventory", icon: Package, group: "Operations" },
  { name: "Account Security", mobileName: "Account", path: "/dashboard/change-password", icon: KeyRound, staffOnly: true, group: "Account" },
  { name: "Analytics", path: "/dashboard/analytics", icon: BarChart3, adminOnly: true, group: "Management" },
  { name: "Services", path: "/dashboard/services", icon: Shirt, adminOnly: true, group: "Management" },
  { name: "Notifications", path: "/dashboard/sms", icon: MessageSquare, adminOnly: true, group: "Management" },
  { name: "Staff", path: "/dashboard/staff", icon: UserCog, adminOnly: true, group: "Management" },
  { name: "Audit Log", path: "/dashboard/audit-log", icon: ArchiveRestore, adminOnly: true, group: "Management" },
  { name: "Settings", path: "/dashboard/settings", icon: Settings, adminOnly: true, group: "Management" },
];

const pageNames = {
  "/dashboard": "Dashboard",
  "/dashboard/orders": "Orders",
  "/dashboard/customers": "Customers",
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
  const { darkMode, toggleTheme } = useUserTheme(user?.id);
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

  const visibleNavigation = navigation.filter(
    (item) => (!item.adminOnly || role === "admin") && (!item.staffOnly || role !== "admin"),
  );
  const mobileNavigation = role === "admin" ? [] : visibleNavigation;

  // A collapsed desktop preference must not hide the contents of the mobile
  // drawer. The drawer is a full navigation surface, not the icon rail.
  const sidebarExpanded = !collapsed || mobileOpen;

  return (
    <div className={`app-layout ${collapsed ? "sidebar-collapsed" : ""} ${role === "admin" ? "admin-layout" : "staff-layout"}`}>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="sidebar-overlay" onClick={() => setMobileOpen(false)} />
      )}

      <aside id="mobile-full-navigation" className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
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
          {visibleNavigation.map((item, index) => (
            <Fragment key={item.path}>
              {sidebarExpanded && item.group !== visibleNavigation[index - 1]?.group && (
                <div className="sidebar-section-label">{item.group}</div>
              )}
              <NavLink
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
            </Fragment>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-account-summary">
            <strong>{staffName || (role === "admin" ? "Administrator" : "Staff")}</strong>
            <span>{contactEmail || user?.email || "No contact email"}</span>
            {branch && <span>{branch}</span>}
          </div>
          <button
            className="nav-link sidebar-signout"
            onClick={signOut}
            title={!sidebarExpanded ? "Sign out" : undefined}
          >
            <LogOut size={18} />
            {sidebarExpanded && "Sign out"}
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
          <div className="top-bar-title">
            <button
              className="mobile-menu-btn"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </button>
            <h2>{pageNames[location.pathname] || "Dashboard"}</h2>
          </div>
          <div className="top-bar-actions">
            <span className="top-bar-date">
              {new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
            </span>
            <button
              type="button"
              className="theme-toggle-button"
              onClick={toggleTheme}
              aria-label={darkMode ? "Use light mode" : "Use dark mode"}
              title={darkMode ? "Use light mode" : "Use dark mode"}
            >
              {darkMode ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            </button>
            <div className="top-bar-user" title={contactEmail || user?.email || undefined}>
              <div className="top-bar-avatar">
                {(staffName || user?.email || "A")[0].toUpperCase()}
              </div>
              <div className="top-bar-user-info">
                <span className="top-bar-user-name">
                  {staffName || (role === "admin" ? "Admin" : "Staff")}
                </span>
                {role === "admin" ? (
                  <span className="top-bar-user-email">Administrator · All branches</span>
                ) : branch ? (
                  <span className="top-bar-user-branch" title={`Assigned branch: ${branch}`}>
                    <MapPin size={11} aria-hidden="true" />
                    {branch}
                  </span>
                ) : (
                  <span className="top-bar-user-email">Staff</span>
                )}
              </div>
            </div>
          </div>
        </header>
        <div className="page-content">
          <Outlet />
        </div>
      </main>

      {role !== "admin" && <nav className="mobile-bottom-nav" aria-label="Primary mobile navigation">
        {mobileNavigation.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/dashboard"}
            className={({ isActive }) => `mobile-bottom-link ${isActive ? "active" : ""}`}
          >
            <span className="mobile-bottom-icon"><item.icon size={21} aria-hidden="true" /></span>
            <span>{item.mobileName || item.name}</span>
          </NavLink>
        ))}
      </nav>}
    </div>
  );
}
