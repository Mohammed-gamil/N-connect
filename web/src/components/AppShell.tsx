import * as React from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { ChevronDown, LogOut, Menu, Plus, X, Zap } from "lucide-react";
import { useAuth } from "../features/auth/AuthContext";
import { cn } from "../lib/utils";
import { Button } from "./ui";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/connections", label: "Connections", end: false },
  { to: "/activity", label: "Activity", end: false },
];

export function AppShell() {
  const { user, organization, logout } = useAuth();
  const navigate = useNavigate();

  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  const userMenuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!userMenuOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [userMenuOpen]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await logout();
      navigate("/login", { replace: true });
    } finally {
      setSigningOut(false);
      setUserMenuOpen(false);
      setMobileMenuOpen(false);
    }
  }

  const userInitial = (user?.name?.trim()[0] ?? user?.email?.[0] ?? "U").toUpperCase();

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur-xs">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-6">
            <Link
              to="/"
              className="flex items-center gap-2 rounded-lg py-1 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold tracking-tight text-ink">
                Integration Hub
              </span>
            </Link>

            <nav aria-label="Main navigation" className="hidden items-center gap-1 md:flex">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
                      isActive
                        ? "bg-subtle text-ink"
                        : "text-ink-secondary hover:bg-subtle/70 hover:text-ink",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-2.5">
            <Link
              to="/automations/new"
              className="hidden sm:inline-flex"
              tabIndex={-1}
            >
              <Button size="sm">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                New automation
              </Button>
            </Link>

            {/* User & org dropdown (desktop) */}
            <div ref={userMenuRef} className="relative hidden md:block">
              <button
                type="button"
                aria-expanded={userMenuOpen}
                aria-haspopup="menu"
                onClick={() => setUserMenuOpen((open) => !open)}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-subtle text-xs font-semibold text-ink">
                  {userInitial}
                </span>
                <span className="max-w-32 truncate text-xs font-medium text-ink">
                  {user?.name}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
              </button>

              {userMenuOpen && (
                <div
                  role="menu"
                  aria-label="Account menu"
                  className="absolute right-0 mt-1.5 w-60 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
                >
                  <div className="border-b border-border px-2.5 py-2">
                    <p className="truncate text-sm font-medium text-ink">{user?.name}</p>
                    <p className="truncate text-xs text-ink-muted">{user?.email}</p>
                    {organization && (
                      <p className="mt-1 truncate text-xs font-medium text-ink-secondary">
                        {organization.name}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={signingOut}
                    onClick={handleSignOut}
                    className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-secondary transition-colors hover:bg-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    {signingOut ? "Signing out..." : "Sign out"}
                  </button>
                </div>
              )}
            </div>

            {/* Mobile hamburger */}
            <button
              type="button"
              aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen((open) => !open)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-ink-secondary transition-colors hover:bg-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:hidden"
            >
              {mobileMenuOpen ? (
                <X className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Menu className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {/* Mobile menu panel */}
        {mobileMenuOpen && (
          <div className="border-t border-border bg-surface px-4 pb-4 pt-3 md:hidden">
            <nav aria-label="Mobile navigation" className="flex flex-col gap-1">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setMobileMenuOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-subtle text-ink"
                        : "text-ink-secondary hover:bg-subtle/70 hover:text-ink",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <div className="mt-3 border-t border-border pt-3">
              <Link
                to="/automations/new"
                onClick={() => setMobileMenuOpen(false)}
                className="block"
              >
                <Button className="w-full" size="md">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  New automation
                </Button>
              </Link>

              <div className="mt-3 flex items-center justify-between rounded-lg bg-subtle px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{user?.name}</p>
                  <p className="truncate text-xs text-ink-muted">
                    {organization?.name ?? user?.email}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={signingOut}
                  onClick={handleSignOut}
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                  Sign out
                </Button>
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
