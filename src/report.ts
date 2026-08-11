/** Standalone HTML report. Self-contained, no network, works offline. */

import { BUCKET_LABELS, BUCKET_MULTIPLIERS } from "./pricing.js";
import {
  attribution,
  bucketBreakdown,
  byBranch,
  byDay,
  byModel,
  byProject,
  totalTokens,
  totals,
} from "./aggregate.js";
import type { LoadResult, Message } from "./transcripts.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);

function barRows(rows: { label: string; value: number; sub?: string }[]): string {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return rows
    .map(
      (r) => `<div class="row">
      <div class="lab">${esc(r.label)}</div>
      <div class="track"><i style="width:${Math.max((r.value / max) * 100, 0.6)}%"></i></div>
      <div class="val">${usd(r.value)}</div>
      <div class="sub">${esc(r.sub ?? "")}</div>
    </div>`,
    )
    .join("");
}

export function renderReport(
  ms: Message[],
  data: LoadResult,
  meta: { since: string; scope?: string },
): string {
  const t = totals(ms);
  const models = byModel(ms);
  const projects = byProject(ms);
  const days = byDay(ms).sort((a, b) => (a.key < b.key ? -1 : 1));
  const branches = byBranch(ms, data.sidecar);
  const attr = attribution(ms, data.sidecar);
  const buckets = bucketBreakdown(ms);
  const maxDay = Math.max(...days.map((d) => d.cost), 0) || 1;

  const dayBars = days
    .map(
      (d) =>
        `<div class="day" title="${d.key} — ${usd(d.cost)}"><i style="height:${Math.max(
          (d.cost / maxDay) * 100,
          1.5,
        )}%"></i></div>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>peil — ${esc(meta.scope ?? "all projects")}</title>
<style>
:root{color-scheme:light;--paper:#f4f6f8;--surface:#fdfdfe;--sunk:#eef1f5;--ink:#0e1418;--ink2:#48535b;--muted:#79858e;--rule:#dfe4e9;--accent:#2a78d6;--dim:#9ec5f4;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--paper:#0e1114;--surface:#171b1f;--sunk:#1e2429;--ink:#eef1f3;--ink2:#a9b3bb;--muted:#7d888f;--rule:#262c31;--accent:#3987e5;--dim:#1c5cab}}
:root[data-theme=dark]{color-scheme:dark;--paper:#0e1114;--surface:#171b1f;--sunk:#1e2429;--ink:#eef1f3;--ink2:#a9b3bb;--muted:#7d888f;--rule:#262c31;--accent:#3987e5;--dim:#1c5cab}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:940px;margin:0 auto;padding:0 24px 64px}
h1{font-family:var(--mono);font-size:34px;letter-spacing:-.025em;margin:44px 0 4px}
h1 span{display:block;font-size:12px;font-weight:400;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-top:9px}
h2{font-size:18px;margin:0 0 4px}
section{padding:34px 0;border-bottom:1px solid var(--rule)}
section:last-of-type{border-bottom:0}
.note{color:var(--ink2);font-size:14px;max-width:66ch;margin:0 0 18px}
.hero{font-family:var(--mono);font-size:52px;font-weight:600;letter-spacing:-.03em;color:var(--accent);line-height:1}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(122px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);margin-top:22px}
.kpi{background:var(--surface);padding:14px 15px}
.kpi b{display:block;font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:20px;font-weight:600}
.kpi span{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.row{display:grid;grid-template-columns:150px 1fr 88px 150px;gap:12px;align-items:center;padding:5px 0}
.lab{font-family:var(--mono);font-size:12.5px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.track{position:relative;height:20px}
.track i{position:absolute;left:0;top:0;height:20px;background:var(--accent);border-radius:0 3px 3px 0;min-width:2px}
.val{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:12.5px;text-align:right}
.sub{font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden}
.days{display:flex;gap:2px;align-items:flex-end;height:110px;border-bottom:1px solid var(--rule);padding-bottom:2px}
.day{flex:1;display:flex;align-items:flex-end;min-width:3px;height:100%}
.day i{width:100%;background:var(--accent);border-radius:2px 2px 0 0}
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--rule);white-space:nowrap}
th{font-family:var(--mono);font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:500;background:var(--sunk)}
td.n{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right}
td.m{font-family:var(--mono);font-size:12.5px}
.scroll{overflow-x:auto;border:1px solid var(--rule);background:var(--surface)}
footer{color:var(--muted);font-size:12px;padding-top:24px}
</style></head><body><div class="wrap">

<h1>peil<span>${esc(meta.scope ?? "all projects")} &middot; since ${esc(meta.since)}</span></h1>

<section>
  <div class="hero">${usd(t.cost)}</div>
  <p class="note" style="margin-top:8px">Consumption value at list price. On a subscription plan this is not spend &mdash; the invoice is flat.</p>
  <div class="kpis">
    <div class="kpi"><b>${num(t.messages)}</b><span>Messages</span></div>
    <div class="kpi"><b>${t.sessions.size}</b><span>Sessions</span></div>
    <div class="kpi"><b>${t.days.size}</b><span>Active days</span></div>
    <div class="kpi"><b>${compact(totalTokens(t.buckets))}</b><span>Tokens</span></div>
    <div class="kpi"><b>${usd(t.days.size ? t.cost / t.days.size : 0)}</b><span>Per active day</span></div>
    <div class="kpi"><b>${num(data.duplicates)}</b><span>Dupes skipped</span></div>
  </div>
</section>

<section>
  <h2>Daily</h2>
  <p class="note">${days.length} active day(s).</p>
  <div class="days">${dayBars}</div>
</section>

<section>
  <h2>By model</h2>
  ${barRows(models.map((g) => ({ label: g.key, value: g.cost, sub: `${g.messages} msgs` })))}
</section>

${
  projects.length > 1
    ? `<section><h2>By project</h2>${barRows(
        projects.slice(0, 12).map((g) => ({ label: g.key, value: g.cost, sub: `${g.messages} msgs` })),
      )}</section>`
    : ""
}

${
  branches.length
    ? `<section><h2>By branch</h2>
       <p class="note">${
         attr.lostCost > 0
           ? `${usd(attr.lostCost)} of in-repo spend could not be tied to a branch — sessions started outside a repository record none.`
           : "All in-repo spend is attributed."
       }</p>
       ${barRows(branches.map((g) => ({ label: g.key, value: g.cost, sub: `${g.sessions.size} session(s)` })))}
     </section>`
    : ""
}

<section>
  <h2>Where the money goes</h2>
  <p class="note">Token share against cost share. The buckets carry very different rates, which is why a single token total tells you almost nothing.</p>
  <div class="scroll"><table>
    <thead><tr><th>Bucket</th><th>Rate</th><th style="text-align:right">Tokens</th><th style="text-align:right">Tok %</th><th style="text-align:right">Cost</th><th style="text-align:right">Cost %</th></tr></thead>
    <tbody>${buckets
      .map(
        (r) => `<tr><td class="m">${BUCKET_LABELS[r.key]}</td><td class="m" style="color:var(--muted)">${
          BUCKET_MULTIPLIERS[r.key]
        }</td><td class="n">${compact(r.tokens)}</td><td class="n">${r.tokenShare.toFixed(
          2,
        )}%</td><td class="n">${usd(r.cost)}</td><td class="n">${r.costShare.toFixed(1)}%</td></tr>`,
      )
      .join("")}</tbody>
  </table></div>
</section>

<footer>Generated by peil &middot; read from local transcripts &middot; nothing left this machine</footer>
</div></body></html>`;
}
