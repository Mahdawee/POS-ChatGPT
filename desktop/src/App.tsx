import { useEffect, useState, type FormEvent } from "react";
import { CircleAlert, CircleCheck, Globe, LoaderCircle, LockKeyhole, ShoppingBasket } from "lucide-react";
import { get, post, type ShopSettings, type User } from "./lib/api";
import { LANGS, t, useLanguage } from "./i18n";
import { type PageId, Shell } from "./components/Shell";
import { CashPage, CategoriesPage, ContactsPage, DashboardPage, InventoryPage, PosPage, ProductsPage, PurchasesPage, ReportsPage, SalesPage, SettingsPage, UsersPage } from "./components/Pages";

type Notice = { text: string; kind: "success" | "error" };
type Session = { accessToken: string; user: User };

export default function App() {
  // Consuming the language context makes the whole tree re-render (every page
  // calls the module-level t()) the moment the language changes.
  const { lang } = useLanguage();
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<PageId>("dashboard");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [apiSlow, setApiSlow] = useState(false);
  const [restore, setRestore] = useState(true);
  const [shopName, setShopName] = useState("");
  const notify = (text: string, kind: "success" | "error" = "success") => { setNotice({ text, kind }); window.setTimeout(() => setNotice(null), 4000); };

  useEffect(() => {
    let saved: Session | null = null;
    try { const value = localStorage.getItem("darpos-session"); if (value) saved = JSON.parse(value) as Session; } catch { localStorage.removeItem("darpos-session"); }
    if (saved?.accessToken && saved.user) { localStorage.setItem("darpos-token", saved.accessToken); setUser(saved.user); }
    setRestore(false);
    let cancelled = false;
    const startedAt = Date.now();
    const poll = async () => {
      while (!cancelled) {
        try { await get<{ ok: boolean }>("/auth/health"); if (!cancelled) setApiReady(true); return; }
        catch {
          if (!cancelled) {
            setApiReady(false);
            if (Date.now() - startedAt > 20000) setApiSlow(true);
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const expired = () => {
      localStorage.removeItem("darpos-token");
      localStorage.removeItem("darpos-session");
      setUser(null);
      setNotice({ text: t("نشست شما پایان یافته است؛ دوباره وارد شوید."), kind: "error" });
    };
    window.addEventListener("darpos:session-expired", expired);
    return () => window.removeEventListener("darpos:session-expired", expired);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "F2" && user) { event.preventDefault(); setPage("pos"); } };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, [user]);

  useEffect(() => {
    if (!user) { setShopName(""); return; }
    get<ShopSettings>("/settings").then((settings) => setShopName(settings.shopName || "")).catch(() => undefined);
  }, [user]);

  // Sliding sessions: silently exchange the token for a fresh one every 4
  // hours so an always-on register never hits the 12h expiry mid-shift.
  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      post<Session>("/auth/refresh", {}).then((session) => {
        if (!session.accessToken) return;
        localStorage.setItem("darpos-token", session.accessToken);
        localStorage.setItem("darpos-session", JSON.stringify(session));
      }).catch(() => undefined);
    }, 4 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [user]);

  const logout = () => { localStorage.removeItem("darpos-token"); localStorage.removeItem("darpos-session"); setUser(null); setPage("dashboard"); };
  if (restore) return <div className="startup-screen"><LoaderCircle className="spin" size={22}/> {t("برنامه در حال آماده‌شدن است…")}</div>;
  if (!user || apiReady === false) return <LoginScreen apiReady={apiReady} apiSlow={apiSlow} onLogin={(session) => { localStorage.setItem("darpos-token", session.accessToken); localStorage.setItem("darpos-session", JSON.stringify(session)); setUser(session.user); setPage("dashboard"); }} notify={notify}/>;

  const labels: Record<PageId, string> = { dashboard: t("نمای کلی"), pos: t("صندوق فروش"), products: t("کالاها"), categories: t("دسته‌بندی‌ها"), customers: t("مشتریان"), suppliers: t("تأمین‌کنندگان"), purchases: t("خریدها"), inventory: t("موجودی انبار"), sales: t("فروش‌ها"), reports: t("گزارش‌ها"), cash: t("مدیریت صندوق"), users: t("کاربران"), settings: t("تنظیمات") };
  const content = (() => {
    switch (page) {
      case "dashboard": return <DashboardPage onNavigate={setPage}/>;
      case "pos": return <PosPage notify={notify}/>;
      case "products": return <ProductsPage notify={notify} user={user}/>;
      case "categories": return <CategoriesPage notify={notify}/>;
      case "customers": return <ContactsPage kind="customers" notify={notify}/>;
      case "suppliers": return <ContactsPage kind="suppliers" notify={notify}/>;
      case "inventory": return <InventoryPage notify={notify}/>;
      case "purchases": return <PurchasesPage notify={notify}/>;
      case "sales": return <SalesPage notify={notify}/>;
      case "reports": return <ReportsPage/>;
      case "cash": return <CashPage notify={notify}/>;
      case "users": return <UsersPage notify={notify}/>;
      case "settings": return <SettingsPage notify={notify}/>;
    }
  })();
  return <><Shell page={page} onNavigate={setPage} user={user} onLogout={logout} shopName={shopName}>{content}</Shell>{notice && <div className={`toast ${notice.kind}`}>{notice.kind === "success" ? <CircleCheck size={18}/> : <CircleAlert size={18}/>}<span>{t(notice.text)}</span></div>}<div className="page-reader" aria-live="polite" lang={lang}>{labels[page]}</div></>;
}

function LoginScreen({ apiReady, apiSlow, onLogin, notify }: { apiReady: boolean | null; apiSlow: boolean; onLogin: (session: Session) => void; notify: (text: string, kind?: "success" | "error") => void }) {
  const { lang, setLang } = useLanguage();
  const [username, setUsername] = useState("admin"); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { const session = await post<Session>("/auth/login", { username, password }); onLogin(session); notify(t("خوش آمدید، {name}", { name: session.user.displayName })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="login-screen"><div className="login-decor decor-one"/><div className="login-decor decor-two"/><section className="login-card"><div className="login-logo"><div className="brand-mark">{t("رو")}</div><div><strong>{t("روشن")}</strong><span>{t("فروش و مدیریت فروشگاه")}</span></div></div><div className="lang-switch" role="group" aria-label={t("زبان برنامه")}>{LANGS.map((item) => <button key={item.id} type="button" className={`lang-option ${lang === item.id ? "active" : ""}`} onClick={() => setLang(item.id)}><Globe size={13}/>{item.label}</button>)}</div><div className="login-welcome"><div className="login-icon"><ShoppingBasket size={23}/></div><span className="eyebrow">{t("سامانه فروشگاهی محلی")}</span><h1>{t("به فروشگاه خوش آمدید")}</h1><p>{t("برای آغاز کار، وارد حساب کاربری خود شوید.")}</p></div>{apiReady === false && <div className="api-offline"><CircleAlert size={17}/><div><b>{apiSlow ? t("برنامه محلی اجرا نشد") : t("برنامه محلی در حال آماده‌سازی است")}</b><small>{apiSlow ? t("برنامه را ببندید و دوباره باز کنید. اگر مشکل ادامه یافت، فایل api.log در مسیر %APPDATA%\\DarPOSERP را بررسی کنید.") : t("چند لحظه صبر کنید…")}</small></div></div>}<form onSubmit={submit} className="login-form"><label className="field"><span>{t("نام کاربری")}</span><div className="login-input"><CircleAlert size={16}/><input required autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t("نام کاربری")} dir="ltr"/></div></label><label className="field"><span>{t("گذرواژه")}</span><div className="login-input"><LockKeyhole size={16}/><input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("گذرواژه خود را وارد کنید")} dir="ltr"/></div></label>{error && <div className="form-error">{t(error)}</div>}<button className="primary-button login-submit" disabled={busy || apiReady === false}>{busy ? <><LoaderCircle className="spin" size={17}/> {t("در حال ورود…")}</> : t("ورود به فروشگاه")}</button></form><div className="login-foot"><span className="lock-dot"/> {t("داده‌های شما روی همین دستگاه نگهداری می‌شود")}</div></section><div className="login-version">{t("روشن")} · {t("نسخه ۰.۵")}</div></div>;
}
