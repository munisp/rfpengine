import { type ReactNode, useEffect } from "react";
import { Link } from "wouter";
import {
  ArrowUpRight,
  Bell,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Crosshair,
  FileCheck2,
  FolderKanban,
  Radar,
  Building2,
  Radio,
  Workflow,
  LayoutDashboard,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? "small" : ""}`}>
      <span className="brand-mark">
        <svg
          width="27"
          height="30"
          viewBox="0 0 27 30"
          fill="none"
          aria-hidden="true"
        >
          <path d="M3 4h13l8 8-8 8H9v7H3V4Z" fill="currentColor" />
          <path d="M9 9v6h6l3-3-3-3H9Z" fill="#101827" />
          <path d="M18 21h6l-6 6h-6l6-6Z" fill="currentColor" />
        </svg>
      </span>
      {!small && (
        <span>
          bidforge<span className="brand-dot">.</span>
        </span>
      )}
    </div>
  );
}
export const nav = [
  { path: "/", title: "Overview", icon: LayoutDashboard },
  { path: "/discovery", title: "Opportunity discovery", icon: Radar },
  { path: "/profiles", title: "Company profiles", icon: Building2 },
  { path: "/sources", title: "Sources", icon: Radio },
  { path: "/pipeline", title: "Continuous pipeline", icon: Workflow },
  { path: "/pursuits", title: "Pursuits", icon: FolderKanban },
  { path: "/compliance", title: "Compliance matrix", icon: ShieldCheck },
  { path: "/studio", title: "Response studio", icon: FileCheck2 },
  { path: "/library", title: "Evidence library", icon: BookOpen },
  { path: "/pricing", title: "Price to win", icon: Crosshair },
  { path: "/reviews", title: "Team & reviews", icon: Users },
  {
    path: "/claim-review",
    title: "Claim review · wireframe",
    icon: FileCheck2,
  },
];
export function Shell({
  children,
  path,
  search,
  setSearch,
  userName,
  onLogin,
  onAlerts,
  onHelp,
  demo,
}: {
  children: ReactNode;
  path: string;
  search: string;
  setSearch: (v: string) => void;
  userName?: string;
  onLogin: () => void;
  onAlerts: () => void;
  onHelp: () => void;
  demo: boolean;
}) {
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document
          .querySelector<HTMLInputElement>(".global-search input")
          ?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" className="brand-link">
          <Brand />
        </Link>
        <div className="workspace-switch">
          <span className="workspace-icon">B</span>
          <div>
            <strong>Capture workspace</strong>
            <small>
              {demo ? "Sample environment" : "Your private workspace"}
            </small>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map(n => (
            <Link
              key={n.path}
              href={n.path}
              className={`nav-item ${(n.path === "/" ? path === "/" : path.startsWith(n.path)) ? "active" : ""}`}
            >
              <n.icon size={18} />
              <span>{n.title}</span>
              {n.path === "/pricing" && <span className="nav-new">NEW</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="ai-note">
            <span className="pulse-dot" />
            <span>Evidence first. Always.</span>
            <Sparkles size={14} />
          </div>
          <Link
            href="/settings"
            className={`nav-item ${path === "/settings" ? "active" : ""}`}
          >
            <Settings2 size={18} />
            Workspace settings
          </Link>
          <button className="nav-item" onClick={onHelp}>
            <CircleHelp size={18} />
            Help & workflow
          </button>
          <button className="profile" onClick={onLogin}>
            <span className="avatar">
              {(userName || "Guest")
                .split(" ")
                .map(s => s[0])
                .slice(0, 2)
                .join("")}
            </span>
            <div>
              <strong>{userName || "Explore BidForge"}</strong>
              <small>
                {userName ? "Account settings" : "Sign in to save your work"}
              </small>
            </div>
            <ChevronRight size={15} />
          </button>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <div className="breadcrumb">
            <Menu size={17} className="mobile-menu" />
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {nav.find(n => n.path === path)?.title ||
                (path.startsWith("/pursuits/")
                  ? "Pursuit workspace"
                  : "Settings")}
            </strong>
          </div>
          <div className="top-actions">
            <label className="global-search">
              <Search size={16} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search pursuits, evidence…"
                aria-label="Search pursuits and evidence"
              />
              <span>⌘ K</span>
            </label>
            <button className="icon-button" onClick={onHelp} aria-label="Help">
              <CircleHelp size={18} />
            </button>
            <button
              className="icon-button notification"
              onClick={onAlerts}
              aria-label="Notifications"
            >
              <Bell size={18} />
              <i />
            </button>
            <span className="avatar top-avatar">
              {(userName || "BF").slice(0, 2).toUpperCase()}
            </span>
          </div>
        </header>
        <main className="main-content">{children}</main>
        <footer className="app-footer">
          <span>
            <ShieldCheck size={13} /> Human-reviewed. Source-grounded.
          </span>
          <span>BidForge / Proposal intelligence</span>
        </footer>
      </div>
    </div>
  );
}
export function Modal({
  title,
  description,
  open,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className={`bid-modal ${wide ? "wide" : ""}`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span
      className={`status status-${value.toLowerCase().replaceAll(" ", "-").replace("/", "")}`}
    >
      <i />
      {value}
    </span>
  );
}
export function TypeBadge({ value }: { value: string }) {
  return (
    <span
      className={`type-badge ${value === "RFI" ? "blue" : value === "Sources sought" ? "purple" : ""}`}
    >
      {value === "Sources sought" ? "SOURCES SOUGHT" : value}
    </span>
  );
}
export function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon?: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon}
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function PanelTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel-title">
      <div>
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
export function Progress({ value }: { value: number }) {
  return (
    <div className="progress-line">
      <span>
        <i style={{ width: `${value}%` }} />
      </span>
      <small>{value}%</small>
    </div>
  );
}
export function PageHead({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function ActionLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={14} />
    </button>
  );
}
