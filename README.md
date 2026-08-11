<p align="center">
  <img src="assets/logo.svg" width="84" alt="">
</p>

<h1 align="center">peil</h1>

<p align="center">
  <strong>What your AI coding sessions actually cost — per repo, per branch, per feature.</strong>
</p>

<p align="center">
  <code>npm i -g @peil/cli</code> &mdash; the command is <code>peil</code>.
</p>

---

`peil` reads Claude Code's local session transcripts and tells you where the money went. It runs entirely on your machine: no account, no upload, no network calls, and it never reads message content.

Run in a repository and it reports on that repository. This is `peil` on its own source tree:

```
$ peil

peil
~/projects/peil  ·  since 2026-05-13

  $34.35  consumption value at list price

  messages        57   sessions 1   active days 1
  tokens          49.2M
  per active day  $34.35

By model

MODEL            COST   SHARE  MSGS
claude-opus-5  $34.35  100.0%    57  ██████████████████

  0% of in-repo spend is tied to a branch  ($34.35 not attributable)
  run peil hook install to attribute future sessions

  2,578 duplicate message(s) skipped — transcripts replay history
```

Two of those lines are the point. **57 messages, but 2,578 duplicates skipped** — transcripts replay history, so a tool that doesn't deduplicate reports wildly inflated totals. And **0% attributed to a branch**, because this session started a directory above the repo. `peil` says so instead of quietly reporting a smaller number as though it were the whole picture.

---

## Install

```sh
npx @peil/cli        # no install
npm i -g @peil/cli  # or keep it around
```

Requires Node 20+. `peil hook install` additionally needs `jq`.

## Commands

| Command | What it does |
|---|---|
| `peil` | Summary for the current repository |
| `peil branches` | Cost per branch, and what couldn't be attributed |
| `peil buckets` | Token share against cost share |
| `peil report` | Standalone HTML report |
| `peil hook install` | Record the real git branch on future sessions |
| `peil hook status` | Is branch recording working? |

Options: `--days <n>` (default 30), `--since <date>`, `--all` (every project, not just this one), `--out <file>`, `--json`.

## Why the numbers differ from other tools

A Claude Code message doesn't have "an input token count". It has four separately-priced input buckets, and pricing them as one number is wrong by a large multiple.

| Bucket | Rate | Typical share of tokens |
|---|---|---|
| `input` | 1.00× input | ~0.02% |
| `cache_read` | **0.10×** input | **~97%** |
| `cache_write` 5m | 1.25× input | small |
| `cache_write` 1h | **2.00×** input | ~2% |
| `output` | output rate | ~0.4% |

Two mistakes are easy, and both are large:

1. **Pricing every input-side token at the full input rate.** Cache reads are routinely 97% of all tokens, so this overstates cost by roughly **6×**.
2. **Using the flat `cache_creation_input_tokens` field at 1.25×.** Most cache writes carry the 1-hour TTL and bill at **2×**. Read the nested `cache_creation` object instead.

`peil buckets` shows the split. On a real 90-day sample: cache reads were 97.8% of tokens but 63.2% of cost, while 1-hour cache writes were 1.8% of tokens and 23.4% of cost.

**It also deduplicates on `message.id`.** Roughly half of usage-bearing transcript lines are replays — resumed sessions, forks and streaming reconstruction all write the same assistant message more than once. Not deduping doubles every figure.

Rate cards are **dated**, so re-running a report over a past period keeps producing the same answer after a price change.

## Branch attribution

`peil branches` answers *what did that feature cost*.

Claude Code writes a `gitBranch` field, but resolves it **once, from the directory the session started in**, and never re-evaluates it. Three different situations wear the same value:

- `main` — a real branch, trustworthy
- `HEAD` — the session started outside a repository, so there is no branch. Correct, but not a branch name
- `null` — nothing recorded

So **starting Claude Code from the repository root is what makes the field useful.** Changing directory later doesn't help.

`peil hook install` adds a `SessionStart` hook that records the branch independently. It uses `git symbolic-ref` rather than `rev-parse --abbrev-ref`, because the latter returns the literal `HEAD` when detached — collapsing "detached" and "no branch" into one ambiguous string. The hook keeps three states distinct: a branch name, `detached:<sha>`, and `null`.

It appends one line per session to `~/.claude/branch-log.jsonl`:

```json
{"ts":"2026-08-11T10:26:12Z","session_id":"e722e84b","cwd":"/Users/me/projects/app","repo":"/Users/me/projects/app","branch":"feat/checkout"}
```

Session id, working directory, repository root, branch. Nothing else. Local file, never uploaded.

## Privacy

`peil` reads `~/.claude/projects/**/*.jsonl` and takes only scalar fields: model, token counts, timestamps, session id, working directory, branch, CLI version and tool names.

It never reads `message.content` — not prompts, not responses, not file contents, not tool inputs or results. It makes no network requests of any kind. There is no telemetry and no account.

The source is short and MIT-licensed; `src/transcripts.ts` is the only file that touches your transcripts, and it's worth the two minutes to read.

## A note on "cost"

Figures are **list price**. If you're on a Claude subscription the invoice is flat, so these numbers are *consumption value*, not spend — useful for "are we getting the seat's worth" and for comparing features against each other, not for reconciling a bill. On API billing they approximate actual spend, though your organisation's negotiated rates may differ.

## Licence

MIT
