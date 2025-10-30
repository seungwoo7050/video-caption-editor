import { NavLink, Outlet } from "react-router-dom";

function ToastPlaceholder() {
  return (
    <div
      aria-live="polite"
      aria-relevant="additions text"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        width: 320,
        minHeight: 48,
        border: "1px dashed #999",
        borderRadius: 8,
        padding: 12,
        background: "rgba(255,255,255,0.9)",
        fontSize: 12,
      }}
      data-testid="toast-placeholder"
    >
      Toast placeholder
    </div>
  );
}

export default function BaseLayout() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid #ddd",
        }}
      >
        <div style={{ fontWeight: 700 }}>Video Tool</div>

        <nav style={{ display: "flex", gap: 12 }}>
          <NavLink
            to="/login"
            style={({ isActive }) => ({
              textDecoration: "none",
              fontWeight: isActive ? 700 : 400,
            })}
          >
            Login
          </NavLink>
          <NavLink
            to="/videos"
            style={({ isActive }) => ({
              textDecoration: "none",
              fontWeight: isActive ? 700 : 400,
            })}
          >
            Videos
          </NavLink>
        </nav>
      </header>

      <div style={{ flex: 1 }}>
        <Outlet />
      </div>

      <ToastPlaceholder />
    </div>
  );
}
