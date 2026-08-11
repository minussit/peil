/** Terminal output. No dependencies; colour degrades to plain text when piped. */

const useColour = process.stdout.isTTY && !process.env["NO_COLOR"];

const wrap = (code: string) => (s: string) => (useColour ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = wrap("1");
export const dim = wrap("2");
export const accent = wrap("36");
export const warn = wrap("33");
export const danger = wrap("31");
export const good = wrap("32");

export function usd(n: number): string {
  if (n > 0 && n < 0.01) return "$<0.01";
  return (
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/**
 * Always en-US. A bare toLocaleString() follows the machine's locale, so on a
 * pt-BR or de-DE system "2518" renders as "2.518" and reads as two and a half.
 */
export function num(n: number): string {
  return n.toLocaleString("en-US");
}

export function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function pct(n: number, digits = 1): string {
  return n.toFixed(digits) + "%";
}

/** Visible width, ignoring ANSI escapes. */
function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, w: number, align: "l" | "r"): string {
  const gap = Math.max(0, w - width(s));
  return align === "r" ? " ".repeat(gap) + s : s + " ".repeat(gap);
}

export interface Column {
  header: string;
  align?: "l" | "r";
  /** Applied to the cell text after padding. */
  style?: (s: string) => string;
}

export function table(cols: Column[], rows: string[][]): string {
  const widths = cols.map((c, i) =>
    Math.max(width(c.header), ...rows.map((r) => width(r[i] ?? ""))),
  );
  const head = cols
    .map((c, i) => dim(pad(c.header.toUpperCase(), widths[i]!, c.align ?? "l")))
    .join("  ");
  const body = rows.map((r) =>
    cols
      .map((c, i) => {
        const cell = pad(r[i] ?? "", widths[i]!, c.align ?? "l");
        return c.style ? c.style(cell) : cell;
      })
      .join("  "),
  );
  return [head, ...body].join("\n");
}

/** Single-line proportional bar. */
export function bar(value: number, max: number, cells = 24): string {
  if (max <= 0) return "";
  const filled = Math.max(value > 0 ? 1 : 0, Math.round((value / max) * cells));
  return "█".repeat(filled) + dim("─".repeat(Math.max(0, cells - filled)));
}

export function heading(text: string): string {
  return "\n" + bold(text) + "\n";
}

export function rule(width = 60): string {
  return dim("─".repeat(width));
}

export function kv(label: string, value: string, labelWidth = 18): string {
  return dim(pad(label, labelWidth, "l")) + value;
}
