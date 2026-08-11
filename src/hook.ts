/**
 * The SessionStart hook.
 *
 * Claude Code resolves `gitBranch` once, from the directory the session began
 * in. Sessions started above a repository record the "HEAD" sentinel, and no
 * amount of later `cd` changes it. This hook records the branch itself at
 * session start, keeping three states distinct that the transcript field
 * collapses into one: a branch name, `detached:<sha>`, and `null` for no
 * repository.
 *
 * Everything it writes stays on the machine, in ~/.claude/branch-log.jsonl.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeDir } from "./transcripts.js";

const SCRIPT = `#!/usr/bin/env bash
# Installed by peil. Records the git branch for each Claude Code session.
# Uses 'git symbolic-ref' rather than 'rev-parse --abbrev-ref', because the
# latter returns the literal "HEAD" when detached, which is the ambiguity
# this hook exists to remove.
set -uo pipefail

payload=$(cat)
log="\${CLAUDE_BRANCH_LOG:-$HOME/.claude/branch-log.jsonl}"

sid=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
dir=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$dir" ] || dir="$PWD"

branch=""
repo=""
if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
  repo=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
  if ! branch=$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null); then
    branch="detached:$(git -C "$dir" rev-parse --short HEAD 2>/dev/null)"
  fi
fi

jq -n -c \\
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
  --arg session_id "$sid" \\
  --arg cwd "$dir" \\
  --arg repo "$repo" \\
  --arg branch "$branch" \\
  '{ts:$ts,
    session_id:(if $session_id=="" then null else $session_id end),
    cwd:$cwd,
    repo:(if $repo=="" then null else $repo end),
    branch:(if $branch=="" then null else $branch end)}' >> "$log"

exit 0
`;

const HOOK_PATH = "$HOME/.claude/hooks/peil-branch.sh";
const COMMAND = `"${HOOK_PATH}"`;

/** Any SessionStart hook that feeds the same sidecar counts as installed. */
function looksLikeBranchHook(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return (
    command.includes("peil-branch.sh") ||
    command.includes("branch-log") ||
    /record-branch/.test(command)
  );
}

export async function hookStatus(): Promise<{ installed: boolean; message: string }> {
  const dir = claudeDir();
  const settingsPath = join(dir, "settings.json");
  let matched: string | null = null;

  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    for (const entry of settings?.hooks?.SessionStart ?? []) {
      for (const h of entry?.hooks ?? []) {
        if (looksLikeBranchHook(h?.command)) {
          matched = String(h.command);
          break;
        }
      }
    }
  } catch {
    // No settings file, or unparseable — fall through to the sidecar check.
  }

  // The sidecar is the ground truth: if it has readings, something is working.
  let readings = 0;
  try {
    const raw = await readFile(join(dir, "branch-log.jsonl"), "utf8");
    readings = raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    /* no sidecar yet */
  }

  if (matched) {
    const own = matched.includes("peil-branch.sh");
    return {
      installed: true,
      message:
        (own ? "peil hook installed" : `a compatible hook is installed — ${matched.trim()}`) +
        (readings ? ` · ${readings} session(s) recorded` : " · no sessions recorded yet"),
    };
  }
  if (readings > 0) {
    return {
      installed: true,
      message: `no SessionStart hook found, but ${readings} reading(s) exist in branch-log.jsonl`,
    };
  }
  return { installed: false, message: "not recording branches — run: peil hook install" };
}

export async function installHook(): Promise<{ ok: boolean; message: string }> {
  const dir = claudeDir();
  const scriptPath = join(dir, "hooks", "peil-branch.sh");
  const settingsPath = join(dir, "settings.json");

  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(scriptPath, SCRIPT, "utf8");
  await chmod(scriptPath, 0o755);

  let settings: any = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    // No settings file yet, or unreadable — start from an empty object rather
    // than overwriting something we failed to parse.
    try {
      const raw = await readFile(settingsPath, "utf8");
      if (raw.trim()) {
        return {
          ok: false,
          message: `${settingsPath} exists but is not valid JSON — fix it, then re-run`,
        };
      }
    } catch {
      /* genuinely absent */
    }
  }

  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];

  const already = settings.hooks.SessionStart.some((e: any) =>
    (e?.hooks ?? []).some((h: any) => looksLikeBranchHook(h?.command)),
  );
  if (already) {
    return {
      ok: true,
      message: "a branch-recording hook is already installed; peil's script was refreshed",
    };
  }

  settings.hooks.SessionStart.push({
    hooks: [{ type: "command", command: COMMAND, timeout: 10 }],
  });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

  return {
    ok: true,
    message:
      `hook installed — ${scriptPath}\n` +
      `  Takes effect on your next Claude Code session. Requires jq.\n` +
      `  Writes only session id, cwd, repo and branch to ~/.claude/branch-log.jsonl.`,
  };
}
