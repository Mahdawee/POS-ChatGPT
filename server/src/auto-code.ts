/**
 * Race handling for auto-generated codes (P-#### for products, C-#### for
 * customers). Two concurrent creates both read "biggest existing number",
 * both derive the same next code, and SQLite serializes the writes — so the
 * loser comes back with:
 *   P2002 — unique-constraint violation (the code column is indexed UNIQUE),
 *   P2034 — transaction write conflict / deadlock.
 * Retrying is only safe when the code was AUTO-generated: a fresh attempt
 * reads the now-current maximum and moves on. A user-supplied duplicate must
 * fail immediately with the friendly conflict message, never retry.
 */
export const AUTO_CODE_ATTEMPTS = 3;

/** مکث کوچک قبل از تلاشِ دوباره — فرصتِ کامیت‌شدن به تراکنشِ رقیب. */
export const autoCodeRetryDelay = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 25 * attempt));

/**
 * صفِ درون-پردازشی برای ثبت‌هایی که کد خودکار می‌سازند. SQLite در هر لحظه
 * فقط یک نویسنده دارد؛ بدون صف، چند ثبتِ همزمان روی قفلِ نوشتن تصادم
 * می‌کنند (P2034) و هر کدام چند بار پشت‌سرهم شکست می‌خورند. با صف، هر
 * ثبت بعد از کامیتِ قبلی شروع می‌کند، شمارهٔ بعدی را «واقعاً تازه»
 * می‌خواند و تصادم از اساس رخ نمی‌دهد. سرور تک‌پردازشی است، پس این صف
 * کل نویسندگانِ کد را پوشش می‌دهد؛ retry همچون خطِ دفاعی دوم می‌ماند.
 */
let writeChain: Promise<unknown> = Promise.resolve();
export function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = writeChain.then(work, work);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

export function isAutoCodeRace(error: unknown, field?: string): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const prismaError = error as { code?: string; meta?: unknown };
  if (prismaError.code === "P2034") return true;
  // P2028: the interactive transaction expired (default 5s) while waiting
  // for SQLite's single writer — transient under write contention.
  if (prismaError.code === "P2028") return true;
  if (prismaError.code === "P2002") {
    // Without a field restriction every unique conflict counts — used where
    // the model has no other unique column (customer code). With a field,
    // only that column's conflict retries (product SKU): a duplicate
    // user-typed BARCODE on the same request must still fail as-is.
    if (!field) return true;
    return JSON.stringify(prismaError.meta ?? "").includes(field);
  }
  return false;
}
