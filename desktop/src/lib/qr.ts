import { qrCreate } from "./vendor/qr-core";

/**
 * Payment-QR rendering. The generator lives in lib/vendor/qr-core.ts (a
 * verified port of the `qrcode` npm core), and the symbol is emitted as an
 * inline SVG — crisp at any print size, synchronous, and dependency-free.
 */

export type QrSvgOptions = { margin?: number; dark?: string };

/** Builds the QR symbol as a standalone inline `<svg>` string. */
export function qrSvg(text: string, options: QrSvgOptions = {}): string {
  const margin = options.margin ?? 3; // quiet-zone modules (spec recommends 4)
  const dark = options.dark ?? "#000";
  const qr = qrCreate(text, "M");
  const total = qr.size + margin * 2;
  // Row-run paths: one horizontal `h` command per run of dark modules keeps
  // the markup compact even for large symbols.
  let paths = "";
  for (let row = 0; row < qr.size; row++) {
    let runStart = -1;
    for (let col = 0; col <= qr.size; col++) {
      const dark2 = col < qr.size && qr.get(row, col) === 1;
      if (dark2 && runStart < 0) runStart = col;
      else if (!dark2 && runStart >= 0) {
        paths += `M${margin + runStart} ${margin + row}h${col - runStart}`;
        runStart = -1;
      }
    }
  }
  return `<svg class="receipt-qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${total}" height="${total}" fill="#fff"/><path d="${paths}" fill="${dark}"/></svg>`;
}
