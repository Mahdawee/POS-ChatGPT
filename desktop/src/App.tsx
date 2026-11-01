import { useEffect, useState, type FormEvent } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, LockKeyhole, ShoppingBasket } from "lucide-react";
import { get, post, type User } from "./lib/api";
import { type PageId, Shell } from "./components/Shell";
import { CashPage, CategoriesPage, ContactsPage, DashboardPage, InventoryPage, PosPage, ProductsPage, SalesPage, SettingsPage, UsersPage } from "./components/Pages";

type Notice = { text: string; kind: "success" | "error" };
type Session = { accessToken: string; user: User };
const labels: Record<PageId, string> = { dashboard: "نمای کلی", pos: "صندوق فروش", products: "کالاها", categories: "دسته‌بندی‌ها", customers: "مشتریان", suppliers: "تأمین‌کنندگان", inventory: "موجودی انبار", sales: "فروش‌ها", cash: "مدیریت صندوق", users: "کاربران", settings: "تنظیمات" };

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<PageId>("dashboard");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [restore, setRestore] = useState(true);
  const notify = (text: string, kind: "success" | "error" = "success") => { setNotice({ text, kind }); window.setTimeout(() => setNotice(null), 4000); };

  useEffect(() => {
    let saved: Session | null = null;
    try { const value = localStorage.getItem("darpos-session"); if (value) saved = JSON.parse(value) as Session; } catch { localStorage.removeItem("darpos-session"); }
    if (saved?.accessToken && saved.user) { localStorage.setItem("darpos-token", saved.accessToken); setUser(saved.user); }
    setRestore(false);
    let cancelled = false;
    const poll = async () => {
      for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
        try { await get<{ ok: boolean }>("/auth/health"); if (!cancelled) setApiReady(true); return; }
        catch { if (!cancelled) setApiReady(false); await new Promise((resolve) => window.setTimeout(resolve, 1000)); }
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
      setNotice({ text: "نشست شما پایان یافته است؛ دوباره وارد شوید.", kind: "error" });
    };
    window.addEventListener("darpos:session-expired", expired);
    return () => window.removeEventListener("darpos:session-expired", expired);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "F2" && user) { event.preventDefault(); setPage("pos"); } };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, [user]);

  const logout = () => { localStorage.removeItem("darpos-token"); localStorage.removeItem("darpos-session"); setUser(null); setPage("dashboard"); };
  if (restore) return <div className="startup-screen"><LoaderCircle className="spin" size={22}/> برنامه در حال آماده‌شدن است…</div>;
  if (!user) return <LoginScreen apiReady={apiReady} onLogin={(session) => { localStorage.setItem("darpos-token", session.accessToken); localStorage.setItem("darpos-session", JSON.stringify(session)); setUser(session.user); setPage("dashboard"); }} notify={notify}/>;

  const content = (() => {
    switch (page) {
      case "dashboard": return <DashboardPage onNavigate={setPage}/>;
      case "pos": return <PosPage notify={notify}/>;
      case "products": return <ProductsPage notify={notify}/>;
      case "categories": return <CategoriesPage notify={notify}/>;
      case "customers": return <ContactsPage kind="customers" notify={notify}/>;
      case "suppliers": return <ContactsPage kind="suppliers" notify={notify}/>;
      case "inventory": return <InventoryPage notify={notify}/>;
      case "sales": return <SalesPage/>;
      case "cash": return <CashPage notify={notify}/>;
      case "users": return <UsersPage notify={notify}/>;
      case "settings": return <SettingsPage notify={notify}/>;
    }
  })();
  return <><Shell page={page} onNavigate={setPage} user={user} onLogout={logout}>{content}</Shell>{notice && <div className={`toast ${notice.kind}`}>{notice.kind === "success" ? <CircleCheck size={18}/> : <CircleAlert size={18}/>}<span>{notice.text}</span></div>}<div className="page-reader" aria-live="polite">{labels[page]}</div></>;
}

function LoginScreen({ apiReady, onLogin, notify }: { apiReady: boolean | null; onLogin: (session: Session) => void; notify: (text: string, kind?: "success" | "error") => void }) {
  const [username, setUsername] = useState("admin"); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { const session = await post<Session>("/auth/login", { username, password }); onLogin(session); notify(`خوش آمدید، ${session.user.displayName}`); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="login-screen"><div className="login-decor decor-one"/><div className="login-decor decor-two"/><section className="login-card"><div className="login-logo"><div className="brand-mark">رو</div><div><strong>روشن</strong><span>فروش و مدیریت فروشگاه</span></div></div><div className="login-welcome"><div className="login-icon"><ShoppingBasket size={23}/></div><span className="eyebrow">سامانه فروشگاهی محلی</span><h1>به فروشگاه خوش آمدید</h1><p>برای آغاز کار، وارد حساب کاربری خود شوید.</p></div>{apiReady === false && <div className="api-offline"><CircleAlert size={17}/><div><b>برنامه محلی اجرا نشده</b><small>در پوشه برنامه دستور <code>npm run dev</code> را اجرا کنید.</small></div></div>}<form onSubmit={submit} className="login-form"><label className="field"><span>نام کاربری</span><div className="login-input"><CircleAlert size={16}/><input required autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="نام کاربری" dir="ltr"/></div></label><label className="field"><span>گذرواژه</span><div className="login-input"><LockKeyhole size={16}/><input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="گذرواژه خود را وارد کنید" dir="ltr"/></div></label>{error && <div className="form-error">{error}</div>}<button className="primary-button login-submit" disabled={busy || apiReady === false}>{busy ? <><LoaderCircle className="spin" size={17}/> در حال ورود…</> : "ورود به فروشگاه"}</button></form><div className="login-foot"><span className="lock-dot"/> داده‌های شما روی همین دستگاه نگهداری می‌شود</div></section><div className="login-version">روشن · نسخه ۰.۱ آزمایشی</div></div>;
}
