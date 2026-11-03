import { type ReactNode } from "react";
import { CalendarClock, Hourglass } from "lucide-react";
import { Activity, Banknote, BarChart3, Box, Boxes, CircleUserRound, ClipboardList, FileText, Globe, Keyboard, LayoutDashboard, Lock, LogOut, Moon, PackagePlus, ReceiptText, ScrollText, Settings2, ShoppingCart, Sun, Tags, Truck, UsersRound, type LucideIcon } from "lucide-react";
import type { User } from "../lib/api";
import { dateOnly, LANGS, t, todayLabel, useLanguage } from "../i18n";

export type PageId = "dashboard" | "pos" | "products" | "categories" | "customers" | "suppliers" | "purchases" | "orders" | "inventory" | "sales" | "reports" | "cash" | "expenses" | "users" | "audit" | "settings";
// Labels/groups are Dari keys; t() runs at render time so switching the
// language updates the sidebar immediately.
const navigation: { id: PageId; label: string; icon: LucideIcon; group: string; admin?: boolean }[] = [
  { id: "dashboard", label: "نمای کلی", icon: LayoutDashboard, group: "اصلی" },
  { id: "pos", label: "صندوق فروش", icon: ShoppingCart, group: "اصلی" },
  { id: "sales", label: "فروش‌ها", icon: FileText, group: "فروش و انبار" },
  { id: "purchases", label: "خریدها", icon: Truck, group: "فروش و انبار" },
  { id: "products", label: "کالاها", icon: Box, group: "فروش و انبار" },
  { id: "categories", label: "دسته‌بندی‌ها", icon: Tags, group: "فروش و انبار" },
  { id: "orders", label: "سفارش‌ها", icon: ClipboardList, group: "فروش و انبار" },
  { id: "inventory", label: "موجودی انبار", icon: Boxes, group: "فروش و انبار" },
  { id: "customers", label: "مشتریان", icon: UsersRound, group: "اشخاص" },
  { id: "suppliers", label: "تأمین‌کنندگان", icon: PackagePlus, group: "اشخاص" },
  { id: "reports", label: "گزارش‌ها", icon: BarChart3, group: "مدیریت", admin: true },
  { id: "cash", label: "مدیریت صندوق", icon: Banknote, group: "مدیریت" },
  { id: "expenses", label: "دخل و خرج", icon: ReceiptText, group: "مدیریت", admin: true },
  { id: "users", label: "کاربران", icon: CircleUserRound, group: "مدیریت", admin: true },
  { id: "audit", label: "لاگ فعالیت", icon: ScrollText, group: "مدیریت", admin: true },
  { id: "settings", label: "تنظیمات", icon: Settings2, group: "مدیریت", admin: true },
];

/** بنر «نسخهٔ آزمایشی» — فقط تا وقتی تریال فعال است دیده می‌شود؛ با
 *  فعال‌سازی لایسنس کاملاً ناپدید می‌شود تا پایان اعتبار لایسنس. */
export function TrialBanner({ daysLeft, onActivate }: { daysLeft: number; onActivate: () => void }) {
  return <div className="trial-banner" role="status">
    <Hourglass size={18}/>
    <div className="trial-banner-text">
      <b>{t("نسخهٔ آزمایشی فعال است")}</b>
      <span>{t("{days} روز از دورهٔ آزمایشی ۱۴ روزه باقی مانده است. برای ادامهٔ کار پس از پایان این دوره، لایسنس فعال کنید.", { days: String(daysLeft) })}</span>
    </div>
    <button className="primary-button" onClick={onActivate}>{t("فعال‌سازی لایسنس")}</button>
  </div>;
}

/** بنر «نزدیک انقضای لایسنس» — برای لایسنس‌دار وقتی ≤ ۷ روز مانده.
 *  صندوقدار باید قبل از قفل‌شدن برنامه خبردار شود تا سر وقت تمدید کند. */
export function LicenseExpiryBanner({ plan, expiresAt, daysLeft, onActivate }: { plan: string; expiresAt: string; daysLeft: number; onActivate: () => void }) {
  return <div className="trial-banner expiry" role="status">
    <CalendarClock size={18}/>
    <div className="trial-banner-text">
      <b>{t("لایسنس {plan} شما رو به پایان است", { plan })}</b>
      <span>{t("اعتبار لایسنس تا {date} است ({days} روز باقی مانده). برای تمدید، کلید دستگاه را برای فروشنده بفرستید و لایسنس تازه را از دکمهٔ کنار فعال کنید.", { date: dateOnly(`${expiresAt.slice(0, 10)}T00:00:00`), days: String(daysLeft) })}</span>
    </div>
    <button className="primary-button" onClick={onActivate}>{t("تمدید لایسنس")}</button>
  </div>;
}

export function Shell({ page, onNavigate, user, onLogout, shopName, onLock, onHelp, dark, onToggleDark, banner, children }: { page: PageId; onNavigate: (page: PageId) => void; user: User; onLogout: () => void; shopName?: string; onLock: () => void; onHelp: () => void; dark: boolean; onToggleDark: () => void; banner?: ReactNode; children: ReactNode }) {
  const { lang, setLang } = useLanguage();
  const items = navigation.map((item) => ({ ...item, label: t(item.label), group: t(item.group) }));
  const titles: Record<PageId, string> = Object.fromEntries(items.map((item) => [item.id, item.label])) as Record<PageId, string>;
  const groups = [...new Set(items.map((item) => item.group))];
  const store = shopName?.trim() || t("فروشگاه من");
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">{t("رو")}</div><div><strong>{t("روشن")}</strong><span>{t("فروش و مدیریت فروشگاه")}</span></div></div>
      <div className="store-chip"><span className="store-dot"/><span>{store}</span><small>{t("محلی · آماده کار")}</small></div>
      <nav className="side-nav">
        {groups.map((group) => <section className="nav-group" key={group}><div className="nav-label">{group}</div>{items.filter((item) => item.group === group && (!item.admin || user.role === "ADMIN")).map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => onNavigate(id)}><Icon size={18} strokeWidth={1.8}/><span>{label}</span>{id === "pos" && <kbd>F2</kbd>}</button>)}</section>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="lang-switch" role="group" aria-label={t("زبان برنامه")}>{LANGS.map((item) => <button key={item.id} className={`lang-option ${lang === item.id ? "active" : ""}`} onClick={() => setLang(item.id)}><Globe size={13}/>{item.label}</button>)}</div>
        <div className="offline"><span/><div><b>{t("حالت آفلاین")}</b><small>{t("داده‌ها روی همین دستگاه ذخیره می‌شوند")}</small></div></div>
        <div className="user-strip"><div className="avatar">{user.displayName.slice(0, 1)}</div><div className="user-name"><b>{user.displayName}</b><small>{user.role === "ADMIN" ? t("مدیر فروشگاه") : t("صندوقدار")}</small></div><button title={t("خروج")} className="icon-button" onClick={onLogout}><LogOut size={17}/></button></div>
      </div>
    </aside>
    <main className="main-area"><header className="topbar"><div><div className="breadcrumb">{t("روشن")} <span>/</span> {titles[page]}</div><h1>{titles[page]}</h1></div><div className="topbar-right"><div className="today"><Activity size={15}/><span>{t("امروز")}</span><b>{todayLabel()}</b></div><button title={t("حالت تیره")} className="icon-button" onClick={onToggleDark}>{dark ? <Sun size={17}/> : <Moon size={17}/>}</button><button title={t("میان‌برهای صفحه‌کلید")} className="icon-button" onClick={onHelp}><Keyboard size={17}/></button><button title={t("قفل سریع صفحه")} className="icon-button" onClick={onLock}><Lock size={17}/></button><button className="primary-button top-pos" onClick={() => onNavigate("pos")}><ShoppingCart size={17}/> {t("فروش جدید")} <kbd>F2</kbd></button></div></header><div className="page-content">{banner}{children}</div></main>
  </div>;
}
