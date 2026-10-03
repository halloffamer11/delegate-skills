---
name: kiro-delegate
description: >-
  Delegate a coding task to the Kiro CLI (`kiro-cli`) as a background implementer, then review its
  diff and land it yourself. Use this whenever the user wants to hand implementation work to Kiro —
  phrasings like "have Kiro do X", "delegate this to Kiro", "run it through kiro-cli", "use Kiro to
  implement/fix/refactor", or "have Kiro review this" — or to run a queue of coding tasks through
  Kiro while staying the reviewer. Prefer it when the user will review the diff and commit it
  themselves. DO NOT USE for tasks small enough to do inline, or when the user wants the code written
  directly without delegating.
license: MIT
compatibility: Requires the `kiro-cli` CLI (Kiro) installed and, for headless runs, the `KIRO_API_KEY` environment variable set to a Kiro API key (API keys need a Kiro Pro, Pro+, Pro Max, or Power subscription), Node 18+, and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).
metadata:
  version: 0.5.0
---

# Kiro Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — the Kiro CLI (`kiro-cli`) in headless mode — then review what it produced and land
it yourself. You write the brief and own the judgment; Kiro does the typing under an explicit tool
trust setting; you verify and commit.

Nothing here is specific to one orchestrating agent. The loop needs only the ability to run a shell
command and read a file. Status: contract-tested against a fake CLI; a live run against a real
`kiro-cli` is still pending, and the native Windows launch is unverified.

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- `kiro-cli` is not installed, or no `KIRO_API_KEY` is available (headless Kiro authenticates only
  with an API key, and API keys need Kiro Pro or higher).
- You want to write the code yourself, or you only need a review without an implementer run.

## Prerequisites (check once)

1. `kiro-cli --version` succeeds. If not, install the CLI (`curl -fsSL https://cli.kiro.dev/install
   | bash` on macOS/Linux). The binary is `kiro-cli`; plain `kiro` may launch the Kiro IDE instead.
2. `KIRO_API_KEY` is set in the environment the relay runs in. The relay passes it through and never
   reads it; a bad or missing key surfaces as Kiro's own error in a failed `result.json`.
3. You are in (or will point `--cd` at) the target git repository. With the V3 engine (the relay's
   default), trust that workspace once interactively (`kiro-cli --v3` in it): until it is trusted,
   V3 asks before every shell command, and a headless run turns every ask into a deny.
4. Optional: `kiro-cli chat --list-models --format json` lists the model ids `--model` accepts.

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

Kiro sees **only** the text you send — no orchestrator chat history, no shared context. Everything the
task needs goes in the brief: the goal, the current state, what to change, what to leave untouched,
the project's **actual** gate commands (discover them from the repo's CLAUDE.md/AGENTS.md/Makefile —
do not assume), and a report contract. Tell Kiro it will **not** commit (you will). Keep one task per
brief. Full guidance and a template: [references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief to Kiro with the bundled helper. It wraps `kiro-cli chat --no-interactive
--output-format stream-json`, pipes the brief on stdin, and writes a structured `result.json` — so
your only job is "run a command, read a file." (`<skill-dir>` below is this skill's installed
directory — the folder containing this `SKILL.md`. Claude Code prints it as "Base directory for this
skill" when the skill loads; if unsure where it landed, run
`find ~ -name relay.mjs -path '*kiro-delegate*'` and substitute the directory above it.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# pin model and effort:                     add --model <id> --effort high
# read-only (review/diagnosis):             add --read-only   (verify touchedFiles afterwards)
# continue the previous Kiro session:       add --resume-last (send only the delta brief)
# hard time limit (watchdog):               add --timeout 2h  (default: off)
# see all options:                          node .../relay.mjs --help
```

It writes its artifacts to a temp dir, so the repo under review stays clean, and it **never
commits** — see step 5. Mechanics, flags, and the `result.json` shape:
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until Kiro finishes, so back it with whatever your orchestrator offers:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** run it in the foreground for short tasks, or background it and poll
  the result file. The run is done when `result.json` exists with a `status`. (A pre-run usage error
  — bad args or an empty brief — instead exits with code 2 and writes no result file, so check the
  exit code too. A missing `kiro-cli` exits 127 but *does* write a `result.json` with status
  `kiro_unavailable`.)

The implementer's full report is the `finalMessage` field in `result.json` (also in `final.txt`, and
printed on stdout between the report markers).

### 4. Review — do not trust the self-report

- **Re-run the project's gates yourself.** Never take "gates passed" on faith.
- **Read the diff** against the brief: did Kiro do what was asked, nothing more and nothing less?
  `touchedFiles` in the result is your starting point.
- **Run the relevant guard skills** on the diff if you have them installed.

Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

**The orchestrator commits.** Only after the gates pass and the diff holds. If it needs changes,
send a delta brief with `--resume-last` (or `--session <id>`) and review again.

## Model and effort

`kiro-cli chat` documents both as headless flags, and the relay passes them straight through:

- `--model <id>` → `--model <id>`. An explicit model overrides the agent's configured model and, on
  V3, `chat.defaultModel` ([headless mode](https://kiro.dev/docs/cli/headless/)). Without it, Kiro
  picks the model from the agent or `chat.defaultModel`.
- `--effort <level>` → `--effort <level>`, one of `low`, `medium`, `high`, `xhigh`, `max`
  ([CLI commands](https://kiro.dev/docs/reference/cli-commands/)). Supported levels depend on the
  model ([reasoning effort](https://kiro.dev/docs/models/effort/)). In V3 neither value is saved as
  a default.

The relay records both in `result.json`. Kiro documents no usage or credits command, so the relay
reports only whatever `usage` object the stream carries.

## Autonomy model

Headless Kiro cannot prompt, so tools must be trusted up front. Kiro has **no sandbox**:

| Relay flag | What Kiro gets | Use when |
| --- | --- | --- |
| *(default)* | `--trust-all-tools` | Normal implementation — every tool, no path restriction |
| `--trust-tools <list>` | `--trust-tools=<list>` (e.g. `read,grep,write`) | A narrower write run, e.g. no shell |
| `--read-only` | `--trust-tools=read,grep` | Review / diagnosis — plus the git tripwire below |

`--trust-tools` trusts tool categories; it is not a boundary. Kiro's permissions docs say a headless
run treats every `ask` as a deny, so untrusted tools should be refused, but your own
`permissions.yaml` allow rules and an agent's `permissions` still apply, and the docs do not say how
`--trust-tools` composes with V3's capability rules. So the relay adds a reporting tripwire to every
`--read-only` run: it compares parsed git porcelain and fingerprints the working-tree identity and
index entries of Git-visible paths that were already dirty. `readOnlyViolation` is `true` when either
signal proves a change, `false` when coverage is complete and detects none, and `null` when coverage
is incomplete. Ignored paths, submodule internals, perfect restores, and attribution of concurrent
changes remain outside it, so the diff review stays the guarantee.

The relay always names an agent engine because `--output-format stream-json` requires V2 or V3:
`--v3` by default, `--engine v2` for `--v2`.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract. Two limits on that mandate: **surface, don't
absorb** (report Kiro's design decisions and defensible-but-unasked turns rather than silently keeping
them) and **stop for scope changes** (if correct completion needs going beyond the brief, ask). The
full treatment is in [references/review-and-land.md](references/review-and-land.md).

## What Kiro's docs leave open

Read on kiro.dev, 2026-10-02/03. Not documented there, so the relay does not guess:

- **stream-json event shapes.** The docs promise one JSON object per line and, in V3, a final
  interruption record. The relay reads session ids, report text, usage, and interruption defensively
  and falls back to the last assistant text; `events.jsonl` keeps the raw stream.
- **Session ids in the stream.** Kiro session ids are UUIDs (`kiro-cli chat --list-sessions`), but
  which event carries one is undocumented, so `sessionId` may be `null`.
- **`--trust-tools` under V3 permissions**, and the full list of trust categories (the docs name
  `read`, `grep`, `write`, and `shell`).
- **Usage or credits reporting** from the CLI.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — how to write a brief Kiro can
  execute blind: structure, XML blocks, the report contract, embedding the real gate commands.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the
  `result.json` contract, backgrounding per orchestrator, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the review checklist, the commit
  boundary, and the rework cycle via `--resume-last`.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a sequential queue:
  carrying constraints forward, progress tracking, and the end-of-run coherence check.
