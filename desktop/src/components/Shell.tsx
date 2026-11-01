import { type ReactNode } from "react";
import { Activity, Banknote, Box, Boxes, CircleUserRound, FileText, LayoutDashboard, LogOut, PackagePlus, Settings2, ShoppingCart, Tags, UsersRound, type LucideIcon } from "lucide-react";
import type { User } from "../lib/api";

export type PageId = "dashboard" | "pos" | "products" | "categories" | "customers" | "suppliers" | "inventory" | "sales" | "cash" | "users" | "settings";
const navigation: { id: PageId; label: string; icon: LucideIcon; group: string; admin?: boolean }[] = [
  { id: "dashboard", label: "نمای کلی", icon: LayoutDashboard, group: "اصلی" },
  { id: "pos", label: "صندوق فروش", icon: ShoppingCart, group: "اصلی" },
  { id: "sales", label: "فروش‌ها", icon: FileText, group: "فروش و انبار" },
  { id: "products", label: "کالاها", icon: Box, group: "فروش و انبار" },
  { id: "categories", label: "دسته‌بندی‌ها", icon: Tags, group: "فروش و انبار" },
  { id: "inventory", label: "موجودی انبار", icon: Boxes, group: "فروش و انبار" },
  { id: "customers", label: "مشتریان", icon: UsersRound, group: "اشخاص" },
  { id: "suppliers", label: "تأمین‌کنندگان", icon: PackagePlus, group: "اشخاص" },
  { id: "cash", label: "مدیریت صندوق", icon: Banknote, group: "مدیریت" },
  { id: "users", label: "کاربران", icon: CircleUserRound, group: "مدیریت", admin: true },
  { id: "settings", label: "تنظیمات", icon: Settings2, group: "مدیریت", admin: true },
];
const titles: Record<PageId, string> = Object.fromEntries(navigation.map((item) => [item.id, item.label])) as Record<PageId, string>;

export function Shell({ page, onNavigate, user, onLogout, children }: { page: PageId; onNavigate: (page: PageId) => void; user: User; onLogout: () => void; children: ReactNode }) {
  const groups = [...new Set(navigation.map((item) => item.group))];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">رو</div><div><strong>روشن</strong><span>فروش و مدیریت فروشگاه</span></div></div>
      <div className="store-chip"><span className="store-dot"/><span>فروشگاه من</span><small>محلی · آماده کار</small></div>
      <nav className="side-nav">
        {groups.map((group) => <section className="nav-group" key={group}><div className="nav-label">{group}</div>{navigation.filter((item) => item.group === group && (!item.admin || user.role === "ADMIN")).map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => onNavigate(id)}><Icon size={18} strokeWidth={1.8}/><span>{label}</span>{id === "pos" && <kbd>F2</kbd>}</button>)}</section>)}
      </nav>
      <div className="sidebar-bottom"><div className="offline"><span/><div><b>حالت آفلاین</b><small>داده‌ها روی همین دستگاه ذخیره می‌شوند</small></div></div><div className="user-strip"><div className="avatar">{user.displayName.slice(0, 1)}</div><div className="user-name"><b>{user.displayName}</b><small>{user.role === "ADMIN" ? "مدیر فروشگاه" : "صندوقدار"}</small></div><button title="خروج" className="icon-button" onClick={onLogout}><LogOut size={17}/></button></div></div>
    </aside>
    <main className="main-area"><header className="topbar"><div><div className="breadcrumb">روشن <span>/</span> {titles[page]}</div><h1>{titles[page]}</h1></div><div className="topbar-right"><div className="today"><Activity size={15}/><span>امروز</span><b>{new Intl.DateTimeFormat("fa-AF", { dateStyle: "medium" }).format(new Date())}</b></div><button className="primary-button top-pos" onClick={() => onNavigate("pos")}><ShoppingCart size={17}/> فروش جدید <kbd>F2</kbd></button></div></header><div className="page-content">{children}</div></main>
  </div>;
}
