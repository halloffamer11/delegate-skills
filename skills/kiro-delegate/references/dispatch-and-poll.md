# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `kiro-cli chat --no-interactive` (Kiro's headless
mode), grants tools under an explicit trust setting, captures everything, and writes a structured
`result.json`. Your job collapses to: run one command, then read one file. Everything Kiro-specific
lives in the helper, which is what keeps the loop portable across orchestrators.

## Before the first run: check the binary and the key

```bash
command -v kiro-cli          # the active binary; `kiro` may instead launch the Kiro IDE
kiro-cli --version           # recorded into result.json so a stale binary is visible after the fact
export KIRO_API_KEY=...      # headless auth; API keys need Kiro Pro, Pro+, Pro Max, or Power
kiro-cli chat --list-models --format json   # the model ids --model accepts
```

The relay never reads, checks, or writes `KIRO_API_KEY`; it passes your environment through. A
missing or rejected key shows up as a failed run with Kiro's own message in `stderrTail` or `error`,
not as `kiro_unavailable`. If your subscription is managed by an administrator, API key generation
must be enabled for you first.

In V3, open the repository once interactively (`kiro-cli --v3` in it) and trust the workspace.
Until a workspace is trusted, V3 asks before every shell command, and a headless run treats every
ask as a deny — so an untrusted write run cannot run the project gates.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

(`<skill-dir>` is wherever this skill is installed — the folder containing its `SKILL.md`. On Claude
Code it's the printed "Base directory for this skill"; on other orchestrators substitute that install
path. See [`SKILL.md`](../SKILL.md) if you need to locate it.)

Options:

| Flag | Effect |
| --- | --- |
| `--brief <file>` | The brief. Omit it to read the brief from stdin (`node relay.mjs … < brief.txt`). |
| `--cd <dir>` | Working root for Kiro (default: current directory); the child process cwd. |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <id>` | Kiro model id, passed as `--model`. It overrides the agent's configured model and, on V3, `chat.defaultModel`. |
| `--effort <level>` | Reasoning effort, passed as `--effort`: `low`, `medium`, `high`, `xhigh`, or `max`. Supported levels depend on the model. |
| `--agent <name>` | Kiro custom agent, passed as `--agent` (default: Kiro's own default agent). |
| `--engine <v2\|v3>` | Agent engine, passed as `--v2` or `--v3` (default: `v3`). `--output-format stream-json` requires one of them. |
| `--read-only` | Review/diagnosis: `--trust-tools=read,grep` plus the Git-visible change tripwire. Not a sandbox. |
| `--trust-tools <list>` | Trust only these comma-separated tool categories (e.g. `read,grep,write`) instead of `--trust-all-tools`. Mutually exclusive with `--read-only`. |
| `--resume-last` | Resume the previous Kiro session in this directory (`--resume`); send only the delta brief. |
| `--session <id>` | Resume a specific session (`--resume-id <id>`); mutually exclusive with `--resume-last`. |
| `--kiro-path <file>` | The `kiro-cli` binary to run (default: `kiro-cli` on PATH). `KIRO_CLI` does the same. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the process tree is killed and `result.json` gets `status: "timeout"`. Off by default. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Default trust (neither `--read-only` nor `--trust-tools`) is `--trust-all-tools`: every tool, with
no path restriction. Kiro has no sandbox; the brief's path list is guidance, not containment.

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only Kiro's edits and nothing of the helper's own.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `tool` — `"kiro"`; `binary` — the command the relay launched
- `status` — `completed` | `failed` | `timeout` | `aborted` | `kiro_unavailable`
- `exitCode` — mirrors Kiro's exit code (`0` success, `1` failure, `3` MCP startup failure); `128` plus the signal number if the child was killed; `127` if `kiro-cli` isn't found; `1` when the stream ended in an interruption record even if `kiro-cli` exited `0`; on a `timeout` the relay forces a non-zero code
- `signal` — the signal that killed the child, otherwise `null`
- `kiroVersion` — the `kiro-cli --version` output for the binary that actually ran
- `sessionId` — feed this to a later `--session <id>`; `null` when the stream carried none
- `finalMessage` — Kiro's own final report: a result-like event's text, else the text deltas after the last assistant message, else that message. Also in `final.txt`
- `interrupted` — `true` when the stream carried V3's interruption record
- `usage` — the last `usage` object the stream carried; `null` if none
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point. `null` (not `[]`) when git can't report; `[]` means git ran and the tree is clean
- `briefPath` / `eventsPath` / `finalPath` — the exact brief the relay sent, the raw stream-json event log, and the final-message file
- `workdir`, `engine`, `agent`, `model`, `effort`, `readOnly`, `trustTools` (the trust flag passed), `resumeLast`, `lane`, `laneSource`, `startedAt`, `finishedAt`
- `readOnlyViolation` — present on dispatched `--read-only` runs: `true` when parsed git porcelain or
  the working-tree/index fingerprint of an already-dirty Git-visible path proves a change; `false`
  when coverage is complete and detects none; `null` when coverage is incomplete. Ignored paths,
  submodule internals, perfect restores, and attribution remain outside it — the diff review, not this flag, is the guarantee
- `stderrTail` — last ~20 stderr lines; present on every run that did not complete
- `error` — present on a launch failure, a preflight failure, `timeout`, `aborted`, an interrupted run, and a failed run whose stream carried an error event

The helper also prints a summary to stdout and exits with the result's exit code, so a wrapping
script can branch on success/failure directly.

## Waiting for completion

The helper blocks until Kiro finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job` in PowerShell,
  `start /b` in cmd). A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief) exits with code 2 *before* writing any file — so check the exit code
  too, don't only watch for the file. (A missing `kiro-cli` binary exits 127 but *does* write a
  `result.json` with status `kiro_unavailable`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: kiro_unavailable` (exit 127):** `kiro-cli` isn't on PATH, or `--kiro-path`/`KIRO_CLI`
  names a file that doesn't exist. Install with `curl -fsSL https://cli.kiro.dev/install | bash`,
  then re-dispatch.
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `kiro-cli --version` probe exited non-zero or hung past its cap (10s, or `--timeout` when shorter),
  so Kiro was never dispatched. Run `kiro-cli --version` yourself.
- **`status: timeout`:** the `--timeout` watchdog killed the run. The working tree may hold a
  half-applied change — inspect it before deciding between a longer `--timeout`, a smaller brief,
  or a resume.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to `kiro-cli`. The result is written before the relay
  exits; inspect the working tree before re-dispatching. On native Windows a hard kill of the relay
  is uncatchable (Node supports no `SIGTERM` handler there), so this status may never get written —
  a relay process that is gone without a `result.json` is an aborted run.
- **`status: failed` with `interrupted: true`:** Kiro ended the stream with its interruption
  record. Inspect the tree, then resume or re-dispatch.
- **`status: failed`, exit 3:** an MCP server required by `--require-mcp-startup` did not start
  (only if your agent or settings ask for it; the relay does not pass that flag).
- **`status: failed`:** read `stderrTail`, `error`, and the tail of `eventsPath`. Common causes: a
  missing or rejected `KIRO_API_KEY`, a subscription below Pro, an invalid `--model`, an `--effort`
  the model does not support, a stream-json engine mismatch, or a tool the run needed but was not
  trusted. Fix the cause and re-dispatch; don't paper over it by doing the work yourself unless
  that's what the user wants.
- **Empty `finalMessage`:** Kiro exited before producing a report, or its event shape didn't match
  the relay's defensive reader. Treat as a failed run; `events.jsonl` shows where it stopped and is
  the source of truth for tightening the parser.

## Recovering lost work

`events.jsonl` in the run directory records every event the implementer streamed. If finished
work is lost — the run killed late, or the working tree damaged afterward — read the event log
before re-dispatching: it identifies which files and tool commands were involved, which scopes
what needs redoing. Whether it also carries the edit contents depends on what the CLI streams,
so treat any reconstruction as unverified until it matches a working-tree diff — when the tree
still holds the work, preserve the tree rather than replaying the log.

## What the helper is doing

Under the hood the helper runs, with the brief piped on stdin and no positional instruction:

```bash
# fresh write run (default)
kiro-cli chat --no-interactive --v3 --output-format stream-json \
  [--agent <name>] [--model <id>] [--effort <level>] --trust-all-tools < brief.txt

# read-only run
kiro-cli chat --no-interactive --v3 --output-format stream-json \
  [--model <id>] [--effort <level>] --trust-tools=read,grep < brief.txt

# resume: the previous session in this directory, or a specific one
kiro-cli chat --no-interactive --v3 --output-format stream-json --trust-all-tools --resume < delta.txt
kiro-cli chat --no-interactive --v3 --output-format stream-json --trust-all-tools --resume-id <id> < delta.txt
```

Every flag comes from Kiro's [headless mode](https://kiro.dev/docs/cli/headless/) and
[CLI commands](https://kiro.dev/docs/reference/cli-commands/) pages. The trust flag is re-passed on
resume because tool trust is per run.

**Prompt delivery:** the headless docs say that when stdin is piped and no positional argument is
given, Kiro reads the full stream as the instruction. The relay pipes the brief that way, so it stays
out of the host process list, isn't bounded by the OS argument-length cap, and a brief that begins
with `-` can't be misread as a flag.

**What the docs leave open:** the stream-json event names and fields (the docs promise one JSON
object per line and, in V3, a final interruption record), how `--trust-tools` categories compose with
V3's capability-based `permissions.yaml`, and any usage or credits command. The relay parses the
stream defensively and keeps the raw log in `events.jsonl`.

## The commit boundary

The helper never commits — by design, not omission. The robust contract is: Kiro edits the working
tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
