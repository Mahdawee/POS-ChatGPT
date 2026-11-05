/**
 * صفحهٔ اسکن موقت با دوربین گوشی — روی HTTP(S) مستقل پل گوشی سرو می‌شود
 * (نه روی API اصلی). کاملاً خودکفا: ZXing از /zxing.js همان سرور لود می‌شود
 * و هیچ درخواست اینترنتی ندارد. سه حالت: اسکن زنده، عکس، ورود دستی.
 * این بخش «موقت/آزمایشی» است و هیچ ردی در منطق بارکدخوان‌های USB ندارد.
 */
export const PHONE_SCAN_HTML = `<!doctype html>
<html dir="rtl" lang="fa"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#10151c">
<title>اسکنر موقت — Dar POS</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" href="/icon.png">
<link rel="apple-touch-icon" href="/icon.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="اسکنر POS">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  body { font-family: system-ui, "Segoe UI", Tahoma, sans-serif; background: #10151c; color: #e8edf4; min-height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: #161d27; border-bottom: 1px solid #232d3b; position: sticky; top: 0; z-index: 5; }
  header .dot { width: 9px; height: 9px; border-radius: 50%; background: #e5484d; flex: none; }
  header .dot.ok { background: #46a758; }
  header b { font-size: 15px; }
  header small { color: #93a4bb; font-size: 11px; display: block; }
  main { padding: 14px; display: flex; flex-direction: column; gap: 12px; flex: 1; }
  .card { background: #161d27; border: 1px solid #232d3b; border-radius: 14px; padding: 14px; }
  h1 { font-size: 17px; margin-bottom: 4px; }
  .sub { color: #93a4bb; font-size: 12.5px; line-height: 1.9; }
  .pin-box { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
  .pin-box input { flex: 1; font-size: 22px; letter-spacing: 8px; text-align: center; background: #0d1117; color: #fff; border: 1px solid #2b3745; border-radius: 10px; padding: 10px; direction: ltr; }
  button { border: 0; border-radius: 12px; padding: 13px 16px; font-size: 15px; font-weight: 600; font-family: inherit; cursor: pointer; }
  .primary { background: #2f6fed; color: #fff; width: 100%; }
  .primary:active { background: #2558c4; }
  .modes { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .mode { background: #1c2532; color: #e8edf4; padding: 14px 6px 10px; display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 12px; border: 1px solid transparent; }
  .mode .ico { font-size: 26px; line-height: 1; }
  .mode.on { border-color: #2f6fed; background: #1a2a45; }
  #liveWrap { position: relative; border-radius: 14px; overflow: hidden; background: #000; }
  #video { width: 100%; display: block; max-height: 62vh; object-fit: cover; }
  #liveWrap .frame { position: absolute; inset: 18% 12%; border: 2px solid rgba(47,111,237,.9); border-radius: 12px; pointer-events: none; box-shadow: 0 0 0 2000px rgba(0,0,0,.35); }
  .live-bar { display: flex; gap: 8px; padding: 10px; background: #0d1117; }
  .live-bar button { flex: 1; background: #1c2532; color: #e8edf4; font-size: 13px; padding: 10px; }
  .notice { background: #2a1e1e; border: 1px solid #5b2b2b; color: #ffb4b9; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; line-height: 2; }
  .notice b { color: #ffd7d9; }
  input[type=text], input[type=number] { width: 100%; font-size: 18px; background: #0d1117; color: #fff; border: 1px solid #2b3745; border-radius: 10px; padding: 12px; direction: ltr; text-align: center; }
  #flash { position: fixed; inset: 0; background: rgba(70,167,88,.92); color: #fff; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 8px; z-index: 50; font-size: 22px; font-weight: 700; }
  #flash.show { display: flex; }
  #flash code { direction: ltr; font-size: 17px; background: rgba(0,0,0,.25); padding: 4px 12px; border-radius: 8px; }
  .last { display: flex; flex-direction: column; gap: 6px; }
  .last .row { display: flex; justify-content: space-between; align-items: center; background: #0d1117; border: 1px solid #232d3b; border-radius: 10px; padding: 9px 12px; font-size: 13px; }
  .last .row code { direction: ltr; font-size: 14px; }
  .last .row span { color: #93a4bb; font-size: 11px; }
  footer { text-align: center; color: #5c6b80; font-size: 11px; padding: 10px 0 16px; }
  #installCard { border-color: #2a3a2a; }
  #installCard h1 { font-size: 15px; }
  .spin { width: 18px; height: 18px; border: 2px solid #2f6fed; border-top-color: transparent; border-radius: 50%; animation: sp 1s linear infinite; margin: 0 auto 8px; }
  @keyframes sp { to { transform: rotate(360deg); } }
</style></head>
<body>
<header><span class="dot" id="dot"></span><div><b>اسکنر بارکد — Dar POS</b><small id="headState">قطع</small></div></header>
<main>
  <section class="card" id="pairCard">
    <h1>📱 اتصال به صندوق</h1>
    <div class="sub">کد PIN را از صفحهٔ «بارکدخوان / QR» در تنظیمات برنامهٔ کامپیوتر بردارید و همین‌جا وارد کنید.</div>
    <div class="pin-box"><input id="pinInput" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••" autocomplete="off"><button class="primary" style="width:auto" id="pairBtn">اتصال</button></div>
    <div id="pairErr" style="color:#ffb4b9;font-size:12px;margin-top:8px"></div>
  </section>

  <div id="main" hidden style="display:flex;flex-direction:column;gap:12px">
    <div class="notice" id="httpBanner" hidden>
      <b>فعال‌سازی اسکن زندهٔ دوربین (فقط یک‌بار):</b> این نشانی ساده است و مرورگر در آن دوربینِ زنده را باز نمی‌کند؛ اما «اسکن با عکس» همین‌جا کامل کار می‌کند. برای اسکن زنده، یک‌بار با دکمهٔ زیر به نشانی امن بروید و هشدار امنیتی مرورگر را تأیید کنید (گزینهٔ «پیشرفته» و سپس «ادامه») — گواهی محلی برنامه است و بعد از این دیگر این هشدار را نمی‌بینید.
      <button class="primary" id="goHttps" style="margin-top:10px">فعال‌سازی اسکن زندهٔ دوربین</button>
    </div>
    <div class="modes">
      <button class="mode on" id="mLive"><span class="ico">📷</span>اسکن زنده</button>
      <button class="mode" id="mPhoto"><span class="ico">🖼️</span>اسکن با عکس</button>
      <button class="mode" id="mManual"><span class="ico">⌨️</span>ورود دستی</button>
    </div>

    <section id="liveView">
      <div id="liveWrap"><video id="video" playsinline muted autoplay></video><div class="frame"></div></div>
      <div class="live-bar"><button id="torchBtn">🔦 چراغ</button><button id="stopBtn">⏹ توقف</button></div>
    </section>

    <section class="card" id="photoView" hidden>
      <h1>🖼️ عکس بارکد بگیرید</h1>
      <div class="sub">دوربین باز می‌شود؛ از بارکد عکس بگیرید تا همان‌جا خوانده و به صندوق فرستاده شود. این حالت روی هر گوشی و هر مرورگری کار می‌کند.</div>
      <input type="file" id="photoInput" accept="image/*" capture="environment" hidden>
      <button class="primary" id="photoBtn" style="margin-top:10px">گرفتن عکس از بارکد</button>
      <div id="photoMsg" class="sub" style="margin-top:8px"></div>
    </section>

    <section class="card" id="manualView" hidden>
      <h1>⌨️ ورود دستی</h1>
      <div class="sub">شمارهٔ بارکد را با دست بنویسید و بفرستید.</div>
      <input type="text" id="manualInput" placeholder="شمارهٔ بارکد…" style="margin-top:10px">
      <button class="primary" id="manualBtn" style="margin-top:10px">ارسال به صندوق</button>
    </section>

    <section class="card">
      <h1>آخرین ارسال‌ها</h1>
      <div class="last" id="lastList" style="margin-top:8px"><div class="sub">هنوز چیزی فرستاده نشده.</div></div>
    </section>
  </div>

  <section class="card" id="installCard">
    <h1>📲 نصب روی گوشی</h1>
    <div class="sub" id="installHint">این صفحه را مثل یک اپ روی گوشی نصب کنید تا آیکونش بین اپ‌هایتان باشد و هر روز با یک لمس باز شود.</div>
    <button class="primary" id="installBtn" style="margin-top:10px" hidden>افزودن به صفحهٔ اصلی</button>
    <div class="sub" id="iosHint" style="margin-top:8px" hidden>در آیفون: دکمهٔ <b>اشتراک‌گذاری</b> (مربع با فلش رو به بالا) را بزنید و گزینهٔ <b>Add to Home Screen</b> را انتخاب کنید.</div>
  </section>
</main>
<div id="flash"><span>✓ فرستاده شد</span><code id="flashCode"></code></div>
<footer>Dar POS — ابزار موقت آزمایش اسکن · بدون اینترنت کار می‌کند</footer>
<script src="/zxing.js"></script>
<script>
"use strict";
var $ = function (id) { return document.getElementById(id); };
var token = localStorage.getItem("darpos-scan-token") || "";
var sent = [];
function setHead(ok, text) { $("dot").className = "dot" + (ok ? " ok" : ""); $("headState").textContent = text; }
function beep(ok) {
  try {
    var ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === "suspended") ctx.resume();
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = ok ? 1180 : 300; g.gain.value = 0.1;
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.08 : 0.2));
  } catch (e) {}
}
function vibrate() { try { navigator.vibrate && navigator.vibrate(70); } catch (e) {} }
function timeStr(ts) { var d = new Date(ts); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2); }
function pushLast(code, ok) {
  sent.unshift({ code: code, at: Date.now(), ok: ok }); sent = sent.slice(0, 12);
  $("lastList").innerHTML = sent.map(function (s) {
    return '<div class="row"><code>' + String(s.code).replace(/[&<>]/g, "") + "</code><span>" + timeStr(s.at) + (s.ok ? " ✓" : " ✗") + "</span></div>";
  }).join("");
}
function flash(code) {
  $("flashCode").textContent = code;
  $("flash").classList.add("show");
  setTimeout(function () { $("flash").classList.remove("show"); }, 750);
}
function send(code) {
  code = String(code || "").trim(); if (!code) return;
  if (!token) { showPair(); return; }
  fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token, code: code }) })
    .then(function (res) {
      if (res.status === 401) { token = ""; localStorage.removeItem("darpos-scan-token"); showPair(); return; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      var dup = data && data.duplicate;
      beep(!dup); vibrate();
      if (!dup) { flash(code); pushLast(code, true); setHead(true, "وصل · آخرین ارسال " + timeStr(Date.now())); }
    })
    .catch(function () { beep(false); pushLast(code, false); setHead(false, "خطای ارسال"); });
}
function showPair() { $("pairCard").hidden = false; $("main").hidden = true; setHead(false, "در انتظار PIN"); }
function showMain() { $("pairCard").hidden = true; $("main").hidden = false; setHead(true, "وصل شد ✓"); }
$("pairBtn").addEventListener("click", function () {
  var pin = $("pinInput").value.trim();
  $("pairErr").textContent = "";
  fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: pin }) })
    .then(function (res) { if (res.status === 403) throw new Error("PIN درست نیست — از صفحهٔ تنظیمات کامپیوتر دوباره بگیرید."); if (!res.ok) throw new Error("خطای سرور"); return res.json(); })
    .then(function (data) { token = data.token; localStorage.setItem("darpos-scan-token", token); showMain(); })
    .catch(function (e) { $("pairErr").textContent = e.message || "اتصال ممکن نشد."; });
});
$("pinInput").addEventListener("keydown", function (e) { if (e.key === "Enter") $("pairBtn").click(); });

/* ---------- نصب روی گوشی (Add to Home Screen) ---------- */
(function () {
  var card = $("installCard");
  if (!card) return;
  var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  if (standalone) { card.hidden = true; return; } // از قبل مثل اپ نصب شده
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var deferred = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferred = e; $("installBtn").hidden = false;
  });
  window.addEventListener("appinstalled", function () { card.hidden = true; });
  $("installBtn").addEventListener("click", function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function () { deferred = null; $("installBtn").hidden = true; }).catch(function () {});
  });
  if (isIOS) $("iosHint").hidden = false;
})();

/* ---------- حالت‌ها ---------- */
var mode = "live";
function setMode(next) {
  mode = next;
  ["mLive", "mPhoto", "mManual"].forEach(function (id) { $(id).classList.remove("on"); });
  $({ live: "mLive", photo: "mPhoto", manual: "mManual" }[next]).classList.add("on");
  $("liveView").hidden = next !== "live";
  $("photoView").hidden = next !== "photo";
  $("manualView").hidden = next !== "manual";
  if (next !== "live") stopLive();
  if (next === "live") startLive();
}
$("mLive").addEventListener("click", function () { setMode("live"); });
$("mPhoto").addEventListener("click", function () { setMode("photo"); });
$("mManual").addEventListener("click", function () { setMode("manual"); });

/* ---------- اسکن زنده ---------- */
var stream = null, detector = null, coreReader = null, rafTimer = 0, torchOn = false, wakeLock = null;
var canvas = document.createElement("canvas"), cctx = canvas.getContext("2d", { willReadFrequently: true });
function ensureCore() {
  if (coreReader || !window.ZXing) return coreReader;
  try { coreReader = new ZXing.MultiFormatReader(); } catch (e) { coreReader = null; }
  return coreReader;
}
function decodeCanvas() {
  // اول BarcodeDetector بومی (اندروید کروم)، بعد ZXing روی canvas
  if (detector) return detector.detect(canvas).then(function (codes) { return codes && codes.length ? codes[0].rawValue : null; }).catch(function () { return null; });
  var reader = ensureCore();
  if (!reader) return Promise.resolve(null);
  try {
    var luminance = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    var bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
    var result = reader.decode(bitmap); // در نبود کد استثنا می‌دهد
    reader.reset && reader.reset();
    return Promise.resolve(result ? result.getText() : null);
  } catch (e) { try { reader.reset && reader.reset(); } catch (e2) {} return Promise.resolve(null); }
}
var lastSentCode = "", lastSentAt = 0;
function handleCode(code) {
  var now = Date.now();
  if (code === lastSentCode && now - lastSentAt < 1600) return; // جلوگیری از ارسال دوبارهٔ همان کد
  lastSentCode = code; lastSentAt = now;
  send(code);
}
function loop() {
  if (!stream || mode !== "live") return;
  var v = $("video");
  if (v.videoWidth) {
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    try { cctx.drawImage(v, 0, 0); } catch (e) {}
    if (detector) {
      detector.detect(v).then(function (codes) { if (codes && codes.length) handleCode(codes[0].rawValue); }).catch(function () {});
    } else {
      decodeCanvas().then(function (code) { if (code) handleCode(code); });
    }
  }
  rafTimer = setTimeout(loop, 140);
}
function startLive() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $("liveView").querySelector(".live-bar").insertAdjacentHTML("afterbegin",
      '<div class="notice" style="flex:1">این مرورگر دوربین را روی نشانی غیرامن باز نمی‌کند. دو راه دارید: <b>۱)</b> هشدار امنیتی را موقع بازکردن صفحه پذیرفته باشید (پیشرفته ← ادامه) یا <b>۲)</b> از حالت «اسکن با عکس» استفاده کنید که همه‌جا کار می‌کند.</div>');
    return;
  }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    .then(function (s) {
      stream = s; var v = $("video"); v.srcObject = s;
      return v.play();
    })
    .then(function () {
      if ("BarcodeDetector" in window) { try { detector = new BarcodeDetector(); } catch (e) { detector = null; } }
      ensureCore();
      loop();
      if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; }).catch(function () {});
    })
    .catch(function (err) {
      $("liveView").querySelector(".live-bar").insertAdjacentHTML("afterbegin",
        '<div class="notice" style="flex:1">دوربین باز نشد (' + String(err && err.name || err).replace(/[<>]/g, "") + '). هشدار امنیتی مرورگر را پذیرفته باشید یا از حالت «اسکن با عکس» استفاده کنید.</div>');
    });
}
function stopLive() {
  clearTimeout(rafTimer);
  if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} stream = null; }
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  torchOn = false;
}
$("stopBtn").addEventListener("click", function () { stopLive(); });
$("torchBtn").addEventListener("click", function () {
  var track = stream && stream.getVideoTracks()[0];
  if (!track) return;
  var caps = track.getCapabilities ? track.getCapabilities() : {};
  if (!caps.torch) { $("torchBtn").textContent = "🔦 پشتیبانی نمی‌شود"; return; }
  torchOn = !torchOn;
  track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () {});
});

/* ---------- اسکن با عکس ---------- */
$("photoBtn").addEventListener("click", function () { $("photoInput").click(); });
$("photoInput").addEventListener("change", function () {
  var file = this.files && this.files[0]; this.value = "";
  if (!file) return;
  $("photoMsg").innerHTML = '<div class="spin"></div>در حال خواندن عکس…';
  var url = URL.createObjectURL(file);
  var img = new Image();
  img.onload = function () {
    var scale = Math.min(1, 1400 / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    cctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    var finish = function (msg, ok) { $("photoMsg").textContent = msg; if (ok !== undefined) { beep(ok); if (ok) vibrate(); } };
    if ("BarcodeDetector" in window) {
      var det; try { det = new BarcodeDetector(); } catch (e) { det = null; }
      if (det) { det.detect(canvas).then(function (codes) {
          if (codes && codes.length) { handleCode(codes[0].rawValue); finish("خوانده شد ✓", true); }
          else finish("بارکدی در عکس پیدا نشد — نزدیک‌تر و بی‌موج بگیرید.", false);
        }).catch(function () { finish("خواندن ممکن نشد.", false); }); return; }
    }
    var reader = ensureCore();
    if (!reader) { finish("کتابخانهٔ اسکن بارگذاری نشده.", false); return; }
    decodeCanvas().then(function (code) {
      if (code) { handleCode(code); finish("خوانده شد ✓", true); }
      else finish("بارکدی در عکس پیدا نشد — نزدیک‌تر و بی‌موج بگیرید.", false);
    });
  };
  img.onerror = function () { URL.revokeObjectURL(url); $("photoMsg").textContent = "عکس خوانده نشد."; };
  img.src = url;
});

/* ---------- ورود دستی ---------- */
$("manualBtn").addEventListener("click", function () { send($("manualInput").value); $("manualInput").value = ""; });
$("manualInput").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); $("manualBtn").click(); } });

/* ---------- شروع ---------- */
setHead(false, "در انتظار PIN");
// پورت نشانی امن توسط سرور در همین صفحه جایگذاری شده است (۰ یعنی TLS نیست)
var httpsPort = parseInt("__HTTPS_PORT__", 10) || 0;
// QR دسکتاپ، PIN را در انتهای نشانی (#۱۲۳۴) می‌آورد — مستقیم جفت می‌شویم
var startPin = (location.hash || "").replace(/[^0-9]/g, "");
var securePage = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
if (location.protocol === "http:" && httpsPort) {
  $("httpBanner").hidden = false;
  $("goHttps").addEventListener("click", function () {
    location.href = "https://" + location.hostname + ":" + httpsPort + "/" + (startPin ? "#" + startPin : "");
  });
}
if (startPin) {
  token = "";
  try { localStorage.removeItem("darpos-scan-token"); } catch (e) {}
  $("pinInput").value = startPin;
  $("pairBtn").click();
  try { history.replaceState(null, "", location.pathname); } catch (e) {}
} else if (token) {
  fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token }) })
    .then(function (res) { if (res.ok) return res.json(); throw new Error("x"); })
    .then(function (data) { if (data && data.token) { token = data.token; localStorage.setItem("darpos-scan-token", token); showMain(); } })
    .catch(function () { token = ""; localStorage.removeItem("darpos-scan-token"); showPair(); });
} else showPair();
// حالت پیش‌فرض: روی نشانی امن «اسکن زنده»، روی نشانی ساده «اسکن با عکس»
setMode(securePage ? "live" : "photo");
document.addEventListener("visibilitychange", function () {
  // بازگشت به صفحه: اگر حالت زنده بود ولی استریم مرده، دوباره روشن کن
  if (!document.hidden && mode === "live" && !stream) startLive();
});
</script>
</body></html>`;
