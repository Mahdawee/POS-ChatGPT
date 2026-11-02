import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { t } from "../i18n";

/**
 * Keeps a render-time crash from white-screening the register: the boundary
 * shows a readable card with a reload button instead of a blank window.
 */
type State = { message: string | null };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: Error): State {
    return { message: error?.message || String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Written to the webview console so it lands in any collected logs.
    console.error("UI crash:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return <div className="startup-screen"><div className="crash-card"><CircleAlert size={26}/><h2>{t("یک خطای غیرمنتظره رخ داد")}</h2><p>{t("برنامه متوقف شد اما داده‌های شما محفوظ است. با دکمهٔ زیر برنامه را دوباره بارگذاری کنید.")}</p>{this.state.message && <code dir="ltr">{this.state.message}</code>}<button className="primary-button" onClick={() => window.location.reload()}>{t("بارگذاری دوباره")}</button></div></div>;
  }
}
