/**
 * Reading Claude Code's local session transcripts.
 *
 * Transcripts live in ~/.claude/projects/<slugified-cwd>/<session-id>.jsonl,
 * one JSON object per line. We only ever read a fixed set of scalar fields;
 * message content is never touched.
 *
 * Two things that will silently corrupt any total if you skip them:
 *
 *   Deduplicate on message.id. Roughly half of all usage-bearing lines are
 *   replays — resumed sessions, forks, and streaming reconstruction all write
 *   the same assistant message more than once. Not deduping doubles every
 *   figure.
 *
 *   Drop the synthetic model. Lines with model "<synthetic>" carry no real
 *   inference and must not be priced.
 */

import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { type Buckets, isKnownModel } from "./pricing.js";

export interface Message {
  id: string;
  sessionId: string;
  ts: string;
  model: string;
  fast: boolean;
  effort: string | null;
  cwd: string;
  /** Raw value from the transcript. "HEAD" is a sentinel, not a branch. */
  rawBranch: string | null;
  cliVersion: string | null;
  sidechain: boolean;
  buckets: Buckets;
  tools: string[];
}

export interface LoadOptions {
  /** Only include messages at or after this ISO date. */
  since?: string;
  /** Only include messages whose cwd sits under this path. */
  underPath?: string;
  claudeDir?: string;
}

export interface LoadResult {
  messages: Message[];
  /** Usage-bearing lines skipped because their message.id was already seen. */
  duplicates: number;
  /** Lines dropped for carrying the synthetic model. */
  synthetic: number;
  /** Lines that would not parse as JSON. */
  unparseable: number;
  filesScanned: number;
  /** Session id -> branch, from the sidecar hook log when installed. */
  sidecar: Map<string, string>;
}

export function claudeDir(override?: string): string {
  return override ?? join(homedir(), ".claude");
}

async function transcriptFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      for (const f of await readdir(dir)) {
        if (f.endsWith(".jsonl")) out.push(join(dir, f));
      }
    } catch {
      // Unreadable project directory; skip rather than fail the whole run.
    }
  }
  return out;
}

/** Branch readings written by the SessionStart hook, if it is installed. */
async function loadSidecar(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(join(dir, "branch-log.jsonl"), "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { session_id?: string; branch?: string };
      if (rec.session_id && rec.branch) map.set(rec.session_id, rec.branch);
    } catch {
      // A truncated final line is normal while a session is being written.
    }
  }
  return map;
}

export async function load(opts: LoadOptions = {}): Promise<LoadResult> {
  const dir = claudeDir(opts.claudeDir);
  const files = await transcriptFiles(join(dir, "projects"));
  const seen = new Set<string>();
  const messages: Message[] = [];
  let duplicates = 0;
  let synthetic = 0;
  let unparseable = 0;

  for (const file of files) {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        unparseable++;
        continue;
      }
      if (rec?.type !== "assistant") continue;

      const msg = rec.message;
      const usage = msg?.usage;
      const id = msg?.id;
      if (!usage || typeof id !== "string") continue;

      if (seen.has(id)) {
        duplicates++;
        continue;
      }
      seen.add(id);

      const model: string = msg.model ?? "";
      if (!isKnownModel(model)) {
        // "<synthetic>" and anything we have no rate card for.
        if (model === "<synthetic>") synthetic++;
        continue;
      }

      const ts: string = rec.timestamp ?? "";
      if (opts.since && ts.slice(0, 10) < opts.since) continue;

      const cwd: string = rec.cwd ?? "";
      if (opts.underPath && !cwd.startsWith(opts.underPath)) continue;

      const cc = usage.cache_creation ?? {};
      const tools: string[] = [];
      for (const block of msg.content ?? []) {
        if (block?.type === "tool_use" && typeof block.name === "string") tools.push(block.name);
      }

      messages.push({
        id,
        sessionId: rec.sessionId ?? rec.session_id ?? "",
        ts,
        model,
        fast: usage.speed === "fast",
        effort: rec.effort ?? null,
        cwd,
        rawBranch: rec.gitBranch ?? null,
        cliVersion: rec.version ?? null,
        sidechain: Boolean(rec.isSidechain),
        tools,
        buckets: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite5m: cc.ephemeral_5m_input_tokens ?? 0,
          cacheWrite1h: cc.ephemeral_1h_input_tokens ?? 0,
        },
      });
    }
  }

  messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return {
    messages,
    duplicates,
    synthetic,
    unparseable,
    filesScanned: files.length,
    sidecar: await loadSidecar(dir),
  };
}

/** Last path segment of the working directory — a usable project label. */
export function projectOf(m: Message): string {
  return basename(m.cwd) || "unknown";
}
