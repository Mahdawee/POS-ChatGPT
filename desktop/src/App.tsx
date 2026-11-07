import { Suspense, lazy, useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert, CircleCheck, Globe, LoaderCircle, LockKeyhole, RefreshCw, ShoppingBasket, Undo2 } from "lucide-react";
import { get, post, serverOrigin, setServerOrigin, type LicenseStatus, type ShopSettings, type User } from "./lib/api";
import { applyBrandWindowTitle, loadBrand, useBrand } from "./lib/brand";
import { applyCurrencyList, applyLocaleSettings, LANGS, licensePlanLabel, t, useLanguage } from "./i18n";
import { LicenseExpiryBanner, type PageId, Shell, TrialBanner } from "./components/Shell";
import { CustomerDisplay } from "./components/CustomerDisplay";
// پل اسکن با گوشی (دور ۵۳؛ همیشگی) — listener بدون رابط؛ با حذف همین تغییرات به‌کل جداست.
import { PhoneScanListener } from "./components/PhoneScan";
import { SectionHead } from "./components/SectionHead";

// Rarely-opened screens load on demand: the main bundle stays lean, which
// the register feels as a faster cold start.
const DashboardPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.DashboardPage })));
const PosPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.PosPage })));
const CategoriesPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.CategoriesPage })));
const ContactsPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.ContactsPage })));
const ExpensesPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.ExpensesPage })));
const InventoryPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.InventoryPage })));
const ProductsPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.ProductsPage })));
const PurchasesPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.PurchasesPage })));
const ReportsPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.ReportsPage })));
const SalesPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.SalesPage })));
const SettingsPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.SettingsPage })));
const UsersPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.UsersPage })));
const AuditPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.AuditPage })));
const CashPage = lazy(() => import("./components/Pages").then((m) => ({ default: m.CashPage })));
const OrdersPage = lazy(() => import("./components/Round16").then((m) => ({ default: m.OrdersPage })));
const LicenseScreen = lazy(() => import("./components/Round16").then((m) => ({ default: m.LicenseScreen })));
const ActivationModal = lazy(() => import("./components/Round16").then((m) => ({ default: m.ActivationModal })));

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
  const [locked, setLocked] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // صندوق فروش بعد از اولین بازدید نصب می‌ماند تا سبدِ باز (اقلام، مشتری،
  // تخفیف‌ها، سریال‌ها) با رفت‌وآمد بین بخش‌ها از حافظه نیفتد.
  const [posMounted, setPosMounted] = useState(false);
  // Licensing: the gate re-checks on every 402 reply and after activation.
  const [licenseOk, setLicenseOk] = useState<boolean | null>(null);
  // Full license state drives the in-app trial banner (and stays null for a
  // licensed shop, so nothing is shown until the license actually expires).
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [showActivation, setShowActivation] = useState(false);
  const [dark, setDark] = useState(() => { try { return localStorage.getItem("darpos-theme") === "dark"; } catch { return false; } });
  const noticeTimer = useRef<number | undefined>(undefined);
  // هنگام قفل (Ctrl+L) برنامه زیر پردهٔ قفل «inert» می‌شود: نه دیده می‌شود،
  // نه با Tab به آن رسیدنی است — ولی unmount هم نمی‌شود تا وضعیت همهٔ صفحه‌ها
  // (از جمله سبد باز صندوق) دست‌نخورده بماند.
  const appRef = useRef<HTMLDivElement>(null);
  // نام برنامه از فایل مالک می‌آید (پیش‌فرض «روشن») و با مصرف این هوک،
  // کل درخت برنامه با هر تغییرش دوباره رندر می‌شود.
  const brand = useBrand();
  useEffect(() => { appRef.current?.toggleAttribute("inert", locked); }, [locked]);
  // Clearing the previous timer keeps the newest toast on screen for its
  // full four seconds instead of being cut short by an older one.
  const notify = (text: string, kind: "success" | "error" = "success") => { setNotice({ text, kind }); window.clearTimeout(noticeTimer.current); noticeTimer.current = window.setTimeout(() => setNotice(null), 4000); };

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

  // برند (نام برنامه) از فایل مالک خوانده می‌شود و دوره‌ای تازه می‌شود تا
  // تغییرش بدون بستن و باز کردن برنامه ظرف حدود یک دقیقه همه‌جا دیده شود.
  useEffect(() => {
    void loadBrand();
    const timer = window.setInterval(() => { void loadBrand(); }, 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => { void applyBrandWindowTitle(brand.appName); }, [brand.appName, lang]);

  useEffect(() => {
    const checkLicense = () => { get<LicenseStatus>("/license/status").then((state) => { setLicenseOk(state.ok); setLicense(state); }).catch(() => setLicenseOk(true)); };
    // Any 402 from the API flips the app onto the license screen.
    const licenseRequired = () => setLicenseOk(false);
    window.addEventListener("darpos:license-required", licenseRequired);
    if (apiReady) checkLicense();
    return () => window.removeEventListener("darpos:license-required", licenseRequired);
  }, [apiReady]);

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

  useEffect(() => { if (page === "pos") setPosMounted(true); }, [page]);
  // اسکنِ گوشی وقتی نه فرم کالا باز است نه صندوق → فقط پیام
  useEffect(() => {
    const fromPhone = (event: Event): void => {
      const detail = (event as CustomEvent<{ code?: string }>).detail;
      if (detail?.code) notify(t("بارکد از گوشی: {code}", { code: detail.code }));
    };
    window.addEventListener("darpos:phone-scan-notify", fromPhone);
    return () => window.removeEventListener("darpos:phone-scan-notify", fromPhone);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem("darpos-theme", dark ? "dark" : "light"); } catch { /* storage unavailable */ }
  }, [dark]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "F2" && user && !locked) { event.preventDefault(); setPage("pos"); }
      // Quick lock (like Windows-L): hides the register until the password
      // is re-entered; the session itself stays valid.
      else if (event.ctrlKey && event.key.toLowerCase() === "l" && user && !locked) { event.preventDefault(); setLocked(true); }
      // "?" opens the keyboard-shortcut cheat sheet — but never while typing.
      else if (event.key === "?" && user && !locked) {
        const element = event.target as HTMLElement | null;
        const typing = element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT" || element.isContentEditable);
        if (!typing) { event.preventDefault(); setShowHelp(true); }
      }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, [user, locked]);

  // Quick print fell back to the dialog (printer offline, non-Windows…):
  // tell the cashier why a dialog appeared at all.
  useEffect(() => {
    const fallback = () => setNotice({ text: t("چاپ سریع ممکن نشد؛ پنجرهٔ چاپ باز شد."), kind: "error" });
    window.addEventListener("darpos:print-fallback", fallback);
    return () => window.removeEventListener("darpos:print-fallback", fallback);
  }, []);

  // Opening heads-up: low stock / near-expiry goods, once per login.
  useEffect(() => {
    if (!user || user.role !== "ADMIN") return;
    let cancelled = false;
    get<{ lowStockCount: number; expiringCount: number }>("/dashboard/summary").then((summary) => {
      if (cancelled) return;
      const low = summary.lowStockCount || 0;
      const expiring = summary.expiringCount || 0;
      if (low || expiring) setNotice({ text: t("توجه: {low} کالا کم‌موجود و {expiring} کالا نزدیک انقضا است — نمای کلی را ببینید.", { low, expiring }), kind: "error" });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [user]);

  useEffect(() => {
    if (!user) { setShopName(""); return; }
    get<ShopSettings>("/settings").then((settings) => {
      setShopName(settings.shopName || "");
      // The shop's currency list (AFN + USD + any custom entries) must be
      // applied before the base currency, or unknown codes fall back to AFN.
      try {
        const rows = settings.currencies ? JSON.parse(settings.currencies) : null;
        if (Array.isArray(rows)) applyCurrencyList(rows);
      } catch { /* keep the default AFN + USD list */ }
      // Calendar / timezone / currency are display settings: apply them
      // before any screen renders dates and amounts.
      applyLocaleSettings({
        calendar: (settings.calendar === "islamic-umalqura" || settings.calendar === "gregorian" ? settings.calendar : "persian"),
        timezone: settings.timezone || "",
        currency: settings.currency || "AFN",
      });
    }).catch(() => undefined);
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
  const refreshLicense = () => { void get<LicenseStatus>("/license/status").then((state) => { setLicenseOk(state.ok); setLicense(state); }).catch(() => undefined); };
  // Network client machines whose server is unreachable must be able to fall
  // back to standalone mode right from the login screen (no settings access
  // before signing in) — otherwise a wrong server URL locks the register out.
  const exitClientMode = async () => {
    // این برگشت خطرناک است: دستگاه بی‌صدا به دیتابیس محلی خودش برمی‌گردد و
    // فروش‌هایش دیگر روی سرور دیده نمی‌شود (دو دیتابیس جدا). پس قبل از
    // انجام، یک‌بار شفاف تأیید گرفته می‌شود.
    const warning = t("بازگشت به حالت تک‌کامپیوتر؟\n\nاز این پس فروش‌های این دستگاه فقط در دیتابیس محلیِ همین دستگاه ذخیره می‌شود و روی دستگاه سرور دیده نمی‌شود. برای اتصال دوباره، بعداً از تنظیمات ← شبکه نشانی سرور را وارد کنید.\n\nاگر می‌خواهید فقط سرور موقتاً خاموش است، «تلاش دوباره» را بزنید.");
    if (!window.confirm(warning)) return;
    setServerOrigin("");
    try { if (inTauri()) await invoke("set_network_mode", { mode: "local" }); } catch { /* not running inside Tauri */ }
    window.location.reload();
  };
  // بنر نسخهٔ آزمایشی: فقط وقتی تریال فعال است. با فعال‌سازی لایسنس دیگر
  // هیچ پیامی نشان داده نمی‌شود تا زمان انقضای لایسنس.
  const banner = license?.ok && license.mode === "TRIAL"
    ? <TrialBanner daysLeft={license.trialDaysLeft ?? 0} onActivate={() => setShowActivation(true)}/>
    : license?.ok && license.mode === "LICENSED" && license.daysLeft != null && license.daysLeft <= 7
      ? <LicenseExpiryBanner plan={licensePlanLabel(license.plan)} expiresAt={license.expiresAt || ""} daysLeft={license.daysLeft} onActivate={() => setShowActivation(true)}/>
      : null;
  if (restore) return <div className="startup-screen"><LoaderCircle className="spin" size={22}/> {t("برنامه در حال آماده‌شدن است…")}</div>;
  if (licenseOk === false) return <Suspense fallback={<Loading/>}><LicenseScreen onActivated={() => { setLicenseOk(null); refreshLicense(); }}/></Suspense>;
  if (!user || apiReady === false) return <LoginScreen apiReady={apiReady} apiSlow={apiSlow} onLogin={(session) => { localStorage.setItem("darpos-token", session.accessToken); localStorage.setItem("darpos-session", JSON.stringify(session)); setUser(session.user); setPage("dashboard"); }} notify={notify} onExitClientMode={exitClientMode}/>;
  // نصب تازه: تا وقتی گذرواژهٔ پیش‌فرض عوض نشده، برنامه قفل می‌شود — محصولِ
  // فروخته‌شده نباید با رمز شناخته‌شدهٔ admin12345 روی دستگاه مشتری بماند.
  if (user.mustChangePassword) return <MustChangePasswordGate user={user} onDone={() => {
    const next = { ...user, mustChangePassword: false };
    try { localStorage.setItem("darpos-session", JSON.stringify(next)); } catch { /* ذخیره نشد — نشست در حافظه به‌روز است */ }
    setUser(next);
  }} onLogout={logout} notify={notify}/>;

  const labels: Record<PageId, string> = { dashboard: t("نمای کلی"), pos: t("صندوق فروش"), products: t("کالاها"), categories: t("دسته‌بندی‌ها"), customers: t("مشتریان"), suppliers: t("تأمین‌کنندگان"), purchases: t("خریدها"), orders: t("سفارش‌ها"), inventory: t("موجودی انبار"), sales: t("فروش‌ها"), reports: t("گزارش‌ها"), cash: t("مدیریت صندوق"), expenses: t("دخل و خرج"), users: t("کاربران"), audit: t("لاگ فعالیت"), settings: t("تنظیمات") };
  // The second window (customer display) renders standalone, without the Shell.
  if (typeof window !== "undefined" && window.location.hash === "#customer-display") return <CustomerDisplay/>;
  const content = <Suspense fallback={<Loading/>}>{(() => {
        switch (page) {
          case "dashboard": return <DashboardPage onNavigate={setPage}/>;
          // «صندوق فروش» پایین‌تر (خارج از switch) رندر می‌شود تا با
          // عوض‌شدن صفحه unmount نشود و سبد فروش در حافظه بماند.
          case "pos": return null;
          case "products": return <ProductsPage notify={notify} user={user}/>;
          case "categories": return <CategoriesPage notify={notify}/>;
          case "customers": return <ContactsPage kind="customers" notify={notify}/>;
          case "suppliers": return <ContactsPage kind="suppliers" notify={notify}/>;
          case "inventory": return <InventoryPage notify={notify}/>;
          case "purchases": return <PurchasesPage notify={notify} user={user}/>;
          case "orders": return <OrdersPage notify={notify}/>;
          case "sales": return <SalesPage notify={notify} user={user}/>;
          case "reports": return <ReportsPage notify={notify}/>;
          case "expenses": return <ExpensesPage notify={notify} user={user}/>;
          case "cash": return <CashPage notify={notify}/>;
          case "users": return <UsersPage notify={notify}/>;
          case "audit": return <AuditPage/>;
          case "settings": return <SettingsPage notify={notify}/>;
          default: return null;
        }
      })()}
      {/* سبدِ بازِ صندوق با رفتن به بخش‌های دیگر پاک نمی‌شود؛ فقط با ثبت
          فروش، دکمهٔ پاک‌کردن یا خروج از حساب. برچسب hidden (نه unmount)
          صفحه را از دید خارج می‌کند. */}
      {posMounted && <div className="pos-keepalive" hidden={page !== "pos"}><PosPage notify={notify} user={user} active={page === "pos" && !locked}/></div>}
    </Suspense>;
  return <><div ref={appRef}><Shell page={page} onNavigate={setPage} user={user} onLogout={logout} shopName={shopName} onLock={() => setLocked(true)} onHelp={() => setShowHelp(true)} dark={dark} onToggleDark={() => setDark((value) => !value)} banner={banner}>{content}</Shell></div>{locked && <LockScreen username={user.username} onUnlock={() => setLocked(false)}/>}{showActivation && <Suspense fallback={<Loading/>}><ActivationModal onClose={() => setShowActivation(false)} onActivated={() => { setShowActivation(false); refreshLicense(); }} notify={notify}/></Suspense>}{notice && <div className={`toast ${notice.kind}`}>{notice.kind === "success" ? <CircleCheck size={18}/> : <CircleAlert size={18}/>}<span>{t(notice.text)}</span></div>}{showHelp && <ShortcutsHelp onClose={() => setShowHelp(false)}/>}<div className="page-reader" aria-live="polite" lang={lang}>{labels[page]}</div><PhoneScanListener active={Boolean(user) && !locked}/></>;
}

/** True when running inside the Tauri desktop shell (not a plain browser). */
const inTauri = (): boolean => typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

function LoginScreen({ apiReady, apiSlow, onLogin, notify, onExitClientMode }: { apiReady: boolean | null; apiSlow: boolean; onLogin: (session: Session) => void; notify: (text: string, kind?: "success" | "error") => void; onExitClientMode: () => void }) {
  const { lang, setLang } = useLanguage();
  const brand = useBrand();
  const remote = serverOrigin(); // نشانی سرور وقتی این دستگاه مشتری شبکه است
  const [username, setUsername] = useState("admin"); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { const session = await post<Session>("/auth/login", { username, password }); onLogin(session); notify(t("خوش آمدید، {name}", { name: session.user.displayName })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="login-screen"><div className="login-decor decor-one"/><div className="login-decor decor-two"/><section className="login-card"><div className="login-logo"><div className="brand-mark">{brand.appName.trim().slice(0, 2)}</div><div><strong>{brand.appName}</strong><span>{t("فروش و مدیریت فروشگاه")}</span></div></div><div className="lang-switch" role="group" aria-label={t("زبان برنامه")}>{LANGS.map((item) => <button key={item.id} type="button" className={`lang-option ${lang === item.id ? "active" : ""}`} onClick={() => setLang(item.id)}><Globe size={13}/>{item.label}</button>)}</div><div className="login-welcome"><div className="login-icon"><ShoppingBasket size={23}/></div><span className="eyebrow">{t("سامانه فروشگاهی محلی")}</span><h1>{t("به فروشگاه خوش آمدید")}</h1><p>{t("برای آغاز کار، وارد حساب کاربری خود شوید.")}</p></div>{apiReady === false && !remote && <div className="api-offline"><CircleAlert size={17}/><div><b>{apiSlow ? t("برنامه محلی اجرا نشد") : t("برنامه محلی در حال آماده‌سازی است")}</b><small>{apiSlow ? t("برنامه را ببندید و دوباره باز کنید. اگر مشکل ادامه یافت، فایل api.log در مسیر %APPDATA%\\DarPOSERP را بررسی کنید.") : t("چند لحظه صبر کنید…")}</small></div></div>}
          {apiReady === false && remote && <div className="api-offline"><CircleAlert size={17}/><div><b>{apiSlow ? t("اتصال به سرور فروشگاه ممکن نشد") : t("در حال اتصال به سرور فروشگاه…")}</b><small dir="ltr">{remote}</small>{apiSlow && <small>{t("برنامهٔ دستگاه سرور روشن و در شبکهٔ فروشگاه باشد. اگر می‌خواهید این دستگاه مستقل کار کند، به حالت تک‌کامپیوتر برگردید.")}</small>}</div>
            <div className="api-offline-actions">
              <button type="button" className="secondary-button" onClick={() => window.location.reload()}><RefreshCw size={15}/>{t("تلاش دوباره")}</button>
              <button type="button" className="secondary-button" onClick={onExitClientMode}><Undo2 size={15}/>{t("بازگشت به حالت تک‌کامپیوتر")}</button>
            </div>
          </div>}<form onSubmit={submit} className="login-form"><label className="field"><span>{t("نام کاربری")}</span><div className="login-input"><CircleAlert size={16}/><input required autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t("نام کاربری")} dir="ltr"/></div></label><label className="field"><span>{t("گذرواژه")}</span><div className="login-input"><LockKeyhole size={16}/><input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("گذرواژه خود را وارد کنید")} dir="ltr"/></div></label>{error && <div className="form-error">{t(error)}</div>}<button className="primary-button login-submit" disabled={busy || apiReady === false}>{busy ? <><LoaderCircle className="spin" size={17}/> {t("در حال ورود…")}</> : t("ورود به فروشگاه")}</button></form><div className="login-foot"><span className="lock-dot"/> {t("داده‌های شما روی همین دستگاه نگهداری می‌شود")}</div></section><div className="login-version">{brand.appName} · {t("نسخه ۰.۸")}</div></div>;
}

function Loading() {
  return <div className="startup-screen"><LoaderCircle className="spin" size={22}/> {t("در حال بارگذاری…")}</div>;
}

/** Screen veil shown after Ctrl+L: password re-entry, session kept alive. */
function LockScreen({ username, onUnlock }: { username: string; onUnlock: () => void }) {
  const brand = useBrand();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const session = await post<Session>("/auth/login", { username, password });
      localStorage.setItem("darpos-token", session.accessToken);
      localStorage.setItem("darpos-session", JSON.stringify(session));
      onUnlock();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="lock-screen"><div className="login-decor decor-one"/><div className="login-decor decor-two"/>
    <section className="login-card lock-card">
      <div className="login-logo"><div className="brand-mark">{brand.appName.trim().slice(0, 2)}</div><div><strong>{brand.appName}</strong><span>{t("صفحه قفل است")}</span></div></div>
      <div className="login-welcome"><div className="login-icon"><LockKeyhole size={23}/></div><h1>{username}</h1><p>{t("برای ادامه، گذرواژهٔ خود را وارد کنید.")}</p></div>
      <form onSubmit={submit} className="login-form">
        <label className="field"><span>{t("گذرواژه")}</span><div className="login-input"><LockKeyhole size={16}/><input autoFocus required type="password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr"/></div></label>
        {error && <div className="form-error">{t(error)}</div>}
        <button className="primary-button login-submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={17}/> {t("در حال بررسی…")}</> : t("بازکردن صفحه")}</button>
      </form>
    </section>
  </div>;
}

/** Keyboard cheat sheet ("?" key). */
function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ["F2", t("رفتن به صندوق فروش")],
    ["F1", t("جست‌وجوی کالا در صندوق")],
    ["F4", t("معلق‌کردن فاکتور")],
    ["F6", t("مبلغ دریافتی از مشتری")],
    ["F9", t("چاپ دوبارهٔ آخرین رسید")],
    ["Alt + 1…9", t("افزودن کالا به فاکتور")],
    ["Ctrl + L", t("قفل سریع صفحه")],
    ["Esc", t("بستن پنجره یا لغو آزمون اسکنر")],
    ["?", t("نمایش همین راهنما")],
  ];
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
      <SectionHead title={t("میان‌برهای صفحه‌کلید")} subtitle={t("برای کار سریع‌تر در صندوق")}/>
      <table className="shortcut-table"><tbody>{rows.map(([keys, label]) => <tr key={keys}><td><kbd>{keys}</kbd></td><td>{label}</td></tr>)}</tbody></table>
      <div className="form-actions"><button className="primary-button" onClick={onClose}>{t("بستن")}</button></div>
    </div>
  </div>;
}

/** ── گارد گذرواژهٔ پیش‌فرض ───────────────────────────────────────────────────
 * در نصب تازه، کاربر «admin» با گذرواژهٔ پیش‌فرض ساخته می‌شود؛ برنامه تا وقتی
 * آن گذرواژه عوض نشود قفل می‌ماند تا دستگاهِ فروخته‌شده با رمز شناخته‌شده
 * روی دست مشتری نماند. گذرواژهٔ فعلی (پیش‌فرض) و گذرواژهٔ تازه گرفته می‌شود
 * و همان مسیر /auth/change-password همیشگی اجرا می‌شود. */
function MustChangePasswordGate({ user, onDone, onLogout, notify }: { user: User; onDone: () => void; onLogout: () => void; notify: (text: string, kind?: "success" | "error") => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (newPassword.length < 8) { setError(t("گذرواژهٔ تازه باید دست‌کم ۸ نویسه باشد.")); return; }
    if (newPassword !== confirmPassword) { setError(t("تکرار گذرواژه با گذرواژهٔ تازه یکسان نیست.")); return; }
    if (newPassword === currentPassword) { setError(t("گذرواژهٔ تازه باید با گذرواژهٔ فعلی متفاوت باشد.")); return; }
    setBusy(true);
    try {
      await post("/auth/change-password", { currentPassword, newPassword });
      notify(t("گذرواژه با موفقیت تغییر کرد."));
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return <div className="login-screen"><div className="login-decor decor-one"/><div className="login-decor decor-two"/><section className="login-card">
    <div className="login-logo"><div className="brand-mark">{t("امن")}</div><div><strong>{t("تغییر گذرواژهٔ پیش‌فرض")}</strong><span>{user.displayName}</span></div></div>
    <div className="login-welcome"><div className="login-icon"><LockKeyhole size={23}/></div>
      <h1>{t("برای امنیت فروشگاه")}</h1>
      <p>{t("این نصب تازه است و حساب مدیر هنوز گذرواژهٔ پیش‌فرض دارد. برای شروع کار، یک گذرواژهٔ تازه انتخاب کنید — این گذرواژه فقط خودتان می‌دانید و از این پس برای ورود استفاده می‌شود.")}</p>
    </div>
    <form onSubmit={submit} className="login-form must-change-form">
      <label className="field"><span>{t("گذرواژهٔ فعلی (پیش‌فرض)")}</span><div className="login-input"><LockKeyhole size={16}/><input required type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} dir="ltr" autoFocus/></div></label>
      <label className="field"><span>{t("گذرواژهٔ تازه (حداقل ۸ نویسه)")}</span><div className="login-input"><LockKeyhole size={16}/><input required type="password" minLength={8} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} dir="ltr"/></div></label>
      <label className="field"><span>{t("تکرار گذرواژهٔ تازه")}</span><div className="login-input"><LockKeyhole size={16}/><input required type="password" minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} dir="ltr"/></div></label>
      {error && <div className="form-error">{t(error)}</div>}
      <button className="primary-button login-submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={17}/>{t("در حال ذخیره…")}</> : t("ذخیره و ورود به برنامه")}</button>
    </form>
    <div className="login-foot"><button type="button" className="text-button" onClick={onLogout}>{t("خروج از حساب")}</button></div>
  </section></div>;
}
