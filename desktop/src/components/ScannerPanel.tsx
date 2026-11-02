import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Keyboard, ScanBarcode } from "lucide-react";
import { t, dateTime } from "../i18n";
import { beep, classifyBarcode, lastScannerTest, rememberScannerTest, saveScannerSettings, scannerSettings, SCANNER_DEVICES, type ScannerTest } from "../lib/scanner";

/**
 * Live connection test for USB barcode/QR readers. Scanners type their code
 * as a fast keystroke burst, so the panel simply listens while it is armed
 * and reports what arrived — value, speed, terminator and code type. A
 * successful pass is remembered as the device's connection status.
 */
export function ScannerPanel() {
  const [armed, setArmed] = useState(false);
  const [last, setLast] = useState<ScannerTest | null>(lastScannerTest);
  const [settings, setSettings] = useState(scannerSettings);
  const bufferRef = useRef<Array<{ char: string; at: number }>>([]);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!armed) return;
    const finish = (terminator: "enter" | "tab" | "none") => {
      window.clearTimeout(timerRef.current);
      const buffer = bufferRef.current;
      bufferRef.current = [];
      setArmed(false);
      if (!buffer.length) return;
      const value = buffer.map((entry) => entry.char).join("");
      const ms = Math.max(1, buffer[buffer.length - 1].at - buffer[0].at);
      const test: ScannerTest = { value, at: new Date().toISOString(), ms, terminator };
      setLast(test);
      rememberScannerTest(test);
      beep(true);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === "Tab") {
        if (event.key === "Tab") event.preventDefault();
        if (event.key === "Enter" && !bufferRef.current.length) return; // plain Enter key press, not a scan
        finish(event.key === "Enter" ? "enter" : "tab");
        return;
      }
      if (event.key.length !== 1) return;
      bufferRef.current.push({ char: event.key, at: Date.now() });
      window.clearTimeout(timerRef.current);
      // Scanners fire 20+ chars per second; typing by hand is far slower.
      timerRef.current = window.setTimeout(() => finish("none"), 150);
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); window.clearTimeout(timerRef.current); };
  }, [armed]);

  const speed = last ? Math.round(last.value.length / (last.ms / 1000)) : 0;
  return <div className="scanner-panel">
    <div className={`scan-status ${last ? "ok" : ""}`}>
      <div className="scan-status-icon">{last ? <Check size={22}/> : <CircleAlert size={22}/>}</div>
      <div className="grow">
        <b>{last ? t("بارکدخوان متصل و فعال است") : armed ? t("در انتظار اسکن…") : t("وسیله آزمون نشده است")}</b>
        <small>{last ? t("آخرین اسکن: {time}", { time: dateTime(last.at) }) : armed ? t("هر بارکد یا کد QR را مقابل وسیله بگیرید.") : t("برای بررسی اتصال، آزمون را شروع کنید و یک بارکد اسکن کنید.")}</small>
      </div>
      <button className={last ? "secondary-button" : "primary-button"} onClick={() => { bufferRef.current = []; setArmed(true); }} disabled={armed}><ScanBarcode size={17}/>{armed ? t("در حال گوش‌دادن…") : t("شروع آزمون")}</button>
    </div>

    {last && <div className="scan-result-grid">
      <div><span>{t("مقدار خوانده‌شده")}</span><b dir="ltr" className="mono">{last.value || "—"}</b></div>
      <div><span>{t("نوع کد")}</span><b>{classifyBarcode(last.value)}</b></div>
      <div><span>{t("سرعت خواندن")}</span><b>{speed} {t("نویسه بر ثانیه")}</b></div>
      <div><span>{t("کلید پایان")}</span><b>{last.terminator === "enter" ? "Enter" : last.terminator === "tab" ? "Tab" : t("بدون کلید")}</b></div>
    </div>}

    <div className="form-grid two">
      <label className="check-line"><input type="checkbox" checked={settings.beep} onChange={(e) => { const next = { ...settings, beep: e.target.checked }; setSettings(next); saveScannerSettings(next); }}/>{t("صدای بوق پس از اسکن موفق")}</label>
      <label className="compact-field"><span>{t("پایان اسکن با")}</span><select value={settings.endKey} onChange={(e) => { const next = { ...settings, endKey: e.target.value as typeof settings.endKey }; setSettings(next); saveScannerSettings(next); }}><option value="both">{t("Enter یا Tab (پیشنهادی)")}</option><option value="enter">Enter</option><option value="tab">Tab</option></select></label>
    </div>

    <div className="hint-box"><Keyboard size={17}/>{t("بارکدخوان‌های رایج (Honeywell، Zebra، Sunlux، Netum، Tera و…) به‌صورت «صفحه‌کلید USB» کار می‌کنند و درایور لازم ندارند؛ به درگاه USB وصل کنید و همین آزمون را اجرا کنید. اگر اسکن نشد، کابل را در درگاه پشتی سیستم بزنید و مطمئن شوید چراغ وسیله روشن است.")}</div>
    <div className="table-wrap"><table><thead><tr><th>{t("وسیله")}</th><th>{t("نوع خواندن")}</th><th>{t("نکته")}</th></tr></thead><tbody>{SCANNER_DEVICES.map((device) => <tr key={device.name}><td><b dir="ltr">{device.name}</b></td><td>{t(device.kind)}</td><td className="muted">{t(device.note)}</td></tr>)}</tbody></table></div>
  </div>;
}
