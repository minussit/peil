#!/usr/bin/env node
/**
 * peil — what your AI coding sessions actually cost.
 *
 * Reads Claude Code's local transcripts. Nothing is uploaded, no network calls
 * are made, and message content is never read.
 */

import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { load, projectOf } from "./transcripts.js";
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
import { BUCKET_LABELS, BUCKET_MULTIPLIERS } from "./pricing.js";
import { currentBranch, isRepo, mergedBranches, repoRoot } from "./git.js";
import { hookStatus, installHook } from "./hook.js";
import { renderReport } from "./report.js";
import * as f from "./format.js";

const HELP = `
${f.bold("peil")} — what your AI coding sessions actually cost

${f.dim("USAGE")}
  peil [command] [options]

${f.dim("COMMANDS")}
  (none)            summary for the current directory
  branches          cost per branch, and what could not be attributed
  buckets           token share against cost share
  report            write a standalone HTML report
  hook install      record the real git branch on every future session
  hook status       is the hook installed?

${f.dim("OPTIONS")}
  --days <n>        look back n days (default 30)
  --since <date>    look back to an ISO date, overrides --days
  --all             every project, not just the current directory
  --out <file>      output path for report (default peil-report.html)
  --json            machine-readable output
  --help            this

${f.dim("NOTES")}
  Costs are list price. On a subscription plan they are consumption value,
  not spend. Nothing leaves your machine.
`;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        days: { type: "string" },
        since: { type: "string" },
        all: { type: "boolean", default: false },
        out: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(f.danger("error: ") + (err as Error).message);
    process.exit(2);
  }

  const { values: opt, positionals } = parsed;
  const command = positionals[0] ?? "summary";
  if (opt.help || command === "help") {
    console.log(HELP);
    return;
  }

  if (command === "hook") {
    const sub = positionals[1] ?? "status";
    if (sub === "install") {
      const res = await installHook();
      console.log(res.ok ? f.good("✓ ") + res.message : f.warn("! ") + res.message);
      return;
    }
    const st = await hookStatus();
    console.log(st.installed ? f.good("✓ ") + st.message : f.dim("· ") + st.message);
    return;
  }

  const days = opt.days ? Number(opt.days) : 30;
  if (!Number.isFinite(days) || days <= 0) {
    console.error(f.danger("error: ") + "--days must be a positive number");
    process.exit(2);
  }
  const since = opt.since ?? isoDaysAgo(days);
  const cwd = process.cwd();
  const scope = opt.all ? undefined : (repoRoot(cwd) ?? cwd);

  const data = await load({ since, underPath: scope });
  const ms = data.messages;

  if (ms.length === 0) {
    const where = scope ? `under ${f.dim(scope)}` : "anywhere";
    console.log(
      `\nNo Claude Code activity ${where} since ${since}.\n` +
        f.dim(`Scanned ${data.filesScanned} transcript file(s). Try --all or --days 90.\n`),
    );
    return;
  }

  switch (command) {
    case "summary":
      await summary(ms, data, since, scope, opt.json);
      break;
    case "branches":
      branches(ms, data, since, scope, opt.json);
      break;
    case "buckets":
      buckets(ms, opt.json);
      break;
    case "report": {
      const out = resolve(opt.out ?? "peil-report.html");
      const html = renderReport(ms, data, { since, scope });
      await writeFile(out, html, "utf8");
      console.log(f.good("✓ ") + `report written to ${out}`);
      break;
    }
    default:
      console.error(f.danger("error: ") + `unknown command "${command}"`);
      console.log(HELP);
      process.exit(2);
  }
}

type Data = Awaited<ReturnType<typeof load>>;

async function summary(
  ms: Data["messages"],
  data: Data,
  since: string,
  scope: string | undefined,
  json: boolean,
) {
  const t = totals(ms);
  const models = byModel(ms);
  const projects = byProject(ms);
  const days = byDay(ms);
  const attr = attribution(ms, data.sidecar);

  if (json) {
    console.log(
      JSON.stringify(
        {
          since,
          scope: scope ?? null,
          cost: t.cost,
          messages: t.messages,
          sessions: t.sessions.size,
          activeDays: t.days.size,
          tokens: totalTokens(t.buckets),
          buckets: t.buckets,
          duplicatesSkipped: data.duplicates,
          models: models.map((g) => ({ model: g.key, cost: g.cost, messages: g.messages })),
          projects: projects.map((g) => ({ project: g.key, cost: g.cost })),
          attribution: attr,
        },
        null,
        2,
      ),
    );
    return;
  }

  const scopeLabel = scope ? scope.replace(process.env["HOME"] ?? "", "~") : "all projects";
  console.log(f.heading("peil") + f.dim(`${scopeLabel}  ·  since ${since}`));

  console.log(
    "\n  " +
      f.bold(f.accent(f.usd(t.cost))) +
      f.dim("  consumption value at list price") +
      "\n",
  );
  console.log(
    f.kv("  messages", f.num(t.messages)) +
      f.dim("   sessions ") +
      t.sessions.size +
      f.dim("   active days ") +
      t.days.size,
  );
  console.log(f.kv("  tokens", f.compact(totalTokens(t.buckets))));
  if (t.days.size > 0) console.log(f.kv("  per active day", f.usd(t.cost / t.days.size)));

  if (models.length) {
    console.log(f.heading("By model"));
    const max = models[0]!.cost;
    console.log(
      f.table(
        [
          { header: "model" },
          { header: "cost", align: "r" },
          { header: "share", align: "r" },
          { header: "msgs", align: "r" },
          { header: "" },
        ],
        models.map((g) => [
          g.key,
          f.usd(g.cost),
          f.pct((100 * g.cost) / (t.cost || 1)),
          String(g.messages),
          f.accent(f.bar(g.cost, max, 18)),
        ]),
      ),
    );
  }

  if (projects.length > 1) {
    console.log(f.heading("By project"));
    const max = projects[0]!.cost;
    console.log(
      f.table(
        [
          { header: "project" },
          { header: "cost", align: "r" },
          { header: "msgs", align: "r" },
          { header: "" },
        ],
        projects
          .slice(0, 10)
          .map((g) => [g.key, f.usd(g.cost), String(g.messages), f.accent(f.bar(g.cost, max, 18))]),
      ),
    );
  }

  if (days.length > 1) {
    const busiest = [...days].sort((a, b) => b.cost - a.cost)[0]!;
    console.log(
      "\n" + f.dim("  busiest day  ") + busiest.key + f.dim("  ·  ") + f.usd(busiest.cost),
    );
  }

  // Attribution is the thing most people do not know they are missing.
  const attributable = attr.attributedCost + attr.lostCost;
  if (attributable > 0) {
    const share = (100 * attr.attributedCost) / attributable;
    const line =
      `  ${f.pct(share, 0)} of in-repo spend is tied to a branch` +
      (attr.lostCost > 0 ? f.dim(`  (${f.usd(attr.lostCost)} not attributable)`) : "");
    console.log("\n" + (share > 80 ? f.good(line) : f.warn(line)));
    if (attr.lostCost > 0) {
      console.log(
        f.dim("  run ") + "peil hook install" + f.dim(" to attribute future sessions\n"),
      );
    } else {
      console.log("");
    }
  }

  if (data.duplicates > 0) {
    console.log(
      f.dim(
        `  ${f.num(data.duplicates)} duplicate message(s) skipped — transcripts replay history\n`,
      ),
    );
  }
}

function branches(
  ms: Data["messages"],
  data: Data,
  since: string,
  scope: string | undefined,
  json: boolean,
) {
  const groups = byBranch(ms, data.sidecar);
  const attr = attribution(ms, data.sidecar);
  const root = scope && isRepo(scope) ? scope : null;
  const merged = root ? mergedBranches(root) : new Set<string>();
  const here = root ? currentBranch(root) : null;

  if (json) {
    console.log(
      JSON.stringify(
        {
          since,
          branches: groups.map((g) => ({
            branch: g.key,
            cost: g.cost,
            messages: g.messages,
            sessions: g.sessions.size,
            confidence: g.confidence,
            merged: merged.has(g.key),
          })),
          attribution: attr,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(f.heading("Cost per branch") + f.dim(`since ${since}`));

  if (groups.length === 0) {
    console.log(
      "\n  " +
        f.warn("No branch could be resolved for this period.") +
        "\n" +
        f.dim(
          "  The branch is read from the directory a session started in.\n" +
            "  Start Claude Code from the repository root, or run ",
        ) +
        "peil hook install" +
        f.dim(" to\n  record it independently.\n"),
    );
    return;
  }

  const max = groups[0]!.cost;
  console.log(
    "\n" +
      f.table(
        [
          { header: "branch" },
          { header: "cost", align: "r" },
          { header: "msgs", align: "r" },
          { header: "sessions", align: "r" },
          { header: "state" },
          { header: "" },
        ],
        groups.map((g) => {
          const state =
            g.key === here ? f.accent("current") : merged.has(g.key) ? f.good("merged") : "";
          const src = g.confidence === "hook" ? "" : f.dim("~");
          return [
            g.key + src,
            f.usd(g.cost),
            String(g.messages),
            String(g.sessions.size),
            state,
            f.accent(f.bar(g.cost, max, 16)),
          ];
        }),
      ),
  );

  const attributable = attr.attributedCost + attr.lostCost;
  console.log("");
  if (attr.lostCost > 0) {
    console.log(
      f.warn(`  ${f.usd(attr.lostCost)} of in-repo spend could not be attributed to a branch.`),
    );
    console.log(f.dim("  Sessions started outside a repository record no branch. Run "));
    console.log("  peil hook install" + f.dim(" to fix this going forward.\n"));
  } else if (attributable > 0) {
    console.log(f.good("  All in-repo spend is attributed.\n"));
  }
  if (groups.some((g) => g.confidence !== "hook")) {
    console.log(f.dim("  ~ read from the transcript rather than the hook\n"));
  }
}

function buckets(ms: Data["messages"], json: boolean) {
  const rows = bucketBreakdown(ms);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(f.heading("Where the money goes") + f.dim("token share against cost share"));
  console.log(
    "\n" +
      f.table(
        [
          { header: "bucket" },
          { header: "rate", align: "r" },
          { header: "tokens", align: "r" },
          { header: "tok %", align: "r" },
          { header: "cost", align: "r" },
          { header: "cost %", align: "r" },
        ],
        rows.map((r) => [
          BUCKET_LABELS[r.key],
          f.dim(BUCKET_MULTIPLIERS[r.key]),
          f.compact(r.tokens),
          f.pct(r.tokenShare, 2),
          f.usd(r.cost),
          f.pct(r.costShare),
        ]),
      ),
  );
  const read = rows.find((r) => r.key === "cacheRead");
  if (read && read.tokenShare > 50) {
    console.log(
      "\n" +
        f.dim("  Cache reads are ") +
        f.pct(read.tokenShare) +
        f.dim(" of tokens but ") +
        f.pct(read.costShare) +
        f.dim(" of cost — they bill at a tenth of the input rate.\n"),
    );
  }
}

main().catch((err) => {
  console.error(f.danger("peil failed: ") + (err?.stack ?? String(err)));
  process.exit(1);
});
