/**
 * Branch attribution.
 *
 * Claude Code writes a `gitBranch` field on every message, but it is resolved
 * once from the directory the session *started* in and never re-evaluated.
 * That produces three different situations wearing the same value:
 *
 *   "main"     a real branch. Trustworthy.
 *   "HEAD"     the session started outside a git repository, so there is no
 *              branch. Correct, but not a branch name. Some older CLI builds
 *              also wrote "HEAD" for sessions that *did* start in a repo, so
 *              the value is not evidence either way.
 *   null       nothing recorded.
 *
 * Starting a session from the repository root is what makes the field useful.
 * `peil hook install` adds a SessionStart hook that records the branch
 * independently, which additionally survives a mid-session directory change
 * and distinguishes a detached checkout from "no repository".
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "./transcripts.js";

/** The literal value Claude Code writes when there is no branch to record. */
export const NO_BRANCH_SENTINEL = "HEAD";

export type Confidence = "hook" | "transcript" | "none";

export interface BranchInfo {
  branch: string | null;
  confidence: Confidence;
  /** Why attribution is missing, when it is. */
  reason?: "no-repo" | "sentinel" | "absent";
}

export function resolveBranch(m: Message, sidecar: Map<string, string>): BranchInfo {
  const fromHook = sidecar.get(m.sessionId);
  if (fromHook) {
    // The hook records `null` for a non-repo and `detached:<sha>` when detached.
    if (fromHook === "null") return { branch: null, confidence: "hook", reason: "no-repo" };
    return { branch: fromHook, confidence: "hook" };
  }
  if (m.rawBranch && m.rawBranch !== NO_BRANCH_SENTINEL) {
    return { branch: m.rawBranch, confidence: "transcript" };
  }
  if (m.rawBranch === NO_BRANCH_SENTINEL) {
    return {
      branch: null,
      confidence: "none",
      reason: isRepo(m.cwd) ? "sentinel" : "no-repo",
    };
  }
  return { branch: null, confidence: "none", reason: "absent" };
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

const repoCache = new Map<string, boolean>();

export function isRepo(cwd: string): boolean {
  if (!cwd) return false;
  const hit = repoCache.get(cwd);
  if (hit !== undefined) return hit;
  const ok = existsSync(join(cwd, ".git")) || git(cwd, ["rev-parse", "--git-dir"]) !== null;
  repoCache.set(cwd, ok);
  return ok;
}

export function repoRoot(cwd: string): string | null {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

/**
 * Current branch. Uses `symbolic-ref` rather than `rev-parse --abbrev-ref`,
 * because the latter returns the literal "HEAD" when detached — collapsing
 * "detached" and "no branch" into one ambiguous string, which is the whole
 * problem this module exists to work around.
 */
export function currentBranch(cwd: string): string | null {
  const b = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (b) return b;
  const sha = git(cwd, ["rev-parse", "--short", "HEAD"]);
  return sha ? `detached:${sha}` : null;
}

/** Branches already merged into the repository's default branch. */
export function mergedBranches(cwd: string): Set<string> {
  const out = new Set<string>();
  const head =
    git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])?.replace(
      /^origin\//,
      "",
    ) ?? "main";
  const listed = git(cwd, ["branch", "--merged", head, "--format=%(refname:short)"]);
  for (const line of listed?.split("\n") ?? []) {
    const name = line.trim();
    if (name) out.add(name);
  }
  return out;
}

/** Branch names that still exist locally or on the default remote. */
export function knownBranches(cwd: string): Set<string> {
  const out = new Set<string>();
  const listed = git(cwd, ["branch", "-a", "--format=%(refname:short)"]);
  for (const line of listed?.split("\n") ?? []) {
    const name = line.trim().replace(/^origin\//, "");
    if (name && name !== "HEAD") out.add(name);
  }
  return out;
}
