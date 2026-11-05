/**
 * آیکون و مانیفست «افزودن به صفحهٔ اصلی» (A2HS) برای صفحهٔ اسکن گوشی.
 * آیکون همان لوگوی برنامه (۲۵۶×۲۵۶) است که داخل باینری embed شده تا پل
 * گوشی بدون هیچ فایل جانبی، روی HTTP و HTTPS هر دو بتواند آن را سرو کند.
 */
import { Buffer } from "node:buffer";

const ICON_BASE64 =
  "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";

/** PNG ۲۵۶×۲۵۶ — همان آیکون برنامهٔ دسکتاپ. */
export const PHONE_SCAN_ICON_PNG = Buffer.from(ICON_BASE64, "base64");

/** manifest وب‌اپ برای مرورگرهای اندروید/کروم (iOS از apple-touch-icon استفاده می‌کند). */
export const PHONE_SCAN_MANIFEST = JSON.stringify({
  name: "اسکنر بارکد — Dar POS",
  short_name: "اسکنر POS",
  description: "اسکنر موقت بارکد با دوربین گوشی، متصل به صندوق Dar POS",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#10151c",
  theme_color: "#10151c",
  icons: [{ src: "/icon.png", sizes: "256x256", type: "image/png", purpose: "any" }],
});
