#!/usr/bin/env node
/**
 * delegate-skills · kiro-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Kiro CLI in headless mode
 * (`kiro-cli chat --no-interactive`), capture its `stream-json` event stream,
 * and write a structured result the orchestrating agent can review. The
 * orchestrator runs this one command and reads the result JSON — every
 * Kiro-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Contract-tested against a fake CLI; a live run
 * against a real `kiro-cli` is still pending.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `kiro-cli`, `git`, and Windows `taskkill` for
 * process-tree termination. Headless Kiro authenticates with the
 * `KIRO_API_KEY` environment variable (Kiro Pro tier and up); the relay never
 * reads, checks, or writes it — it passes the environment through unchanged
 * and lets `kiro-cli` report its own auth failure. Read this file before you
 * run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * Launch (all flags from kiro.dev/docs/cli/headless and
 * kiro.dev/docs/reference/cli-commands, read 2026-10-02/03):
 *   kiro-cli chat --no-interactive --v3 --output-format stream-json
 *     [--agent <name>] [--model <id>] [--effort <level>]
 *     (--trust-all-tools | --trust-tools=<categories>)
 *     [--resume | --resume-id <id>]
 * The brief goes to kiro-cli on stdin, never argv: the headless docs say that
 * when stdin is piped and no positional instruction is given, Kiro reads the
 * whole stream as the instruction. That keeps the brief out of the host
 * process list and the OS arg-length cap, and a brief that begins with "-"
 * cannot be misread as a flag.
 *
 * Autonomy. Headless Kiro has no one to approve tool calls, so the relay
 * always grants tools up front. Kiro has no sandbox:
 *   default        — `--trust-all-tools` (every tool, no path restriction)
 *   --trust-tools  — `--trust-tools=<categories>` (only the named categories)
 *   --read-only    — `--trust-tools=read,grep` (the docs' own read-only example)
 * `--trust-tools` trusts categories; it is not a sandbox. Kiro's headless
 * docs (V3 permissions) treat every `ask` as a deny, so untrusted writes
 * should be refused — but your own `permissions.yaml` allow rules and agent
 * `permissions` still apply, and the docs do not say how `--trust-tools`
 * composes with V3's capability rules. So a `--read-only` run also runs the
 * git tripwire: `readOnlyViolation` is true when git porcelain or an
 * already-dirty Git-visible path proves a change, false when coverage is
 * complete and detects none, and null when coverage is incomplete. It cannot
 * attribute a concurrent change to Kiro and does not cover ignored paths.
 *
 * Engine. `--output-format stream-json` requires the V2 or V3 agent engine,
 * so the relay always names one: `--v3` by default (the headless docs'
 * example and the engine that writes an interruption record), `--engine v2`
 * for `--v2`. In V3, an untrusted workspace asks before every shell command —
 * a deny when headless — so trust the workspace once interactively before
 * dispatching write runs that must run the gates.
 *
 * Model and effort. `--model <id>` and `--effort <level>` are documented
 * headless flags (kiro.dev/docs/cli/headless, "Agent selection"): an explicit
 * `--model` overrides the agent's configured model and, on V3,
 * `chat.defaultModel`; `--effort` takes low|medium|high|xhigh|max
 * (kiro.dev/docs/reference/cli-commands), and supported levels depend on the
 * model. In V3 neither is saved as a default (kiro.dev/docs/models/effort).
 * List models with `kiro-cli chat --list-models --format json`.
 *
 * stream-json. The docs promise one self-contained JSON object per line and,
 * in V3, a final interruption record for an interrupted run; they do not
 * document event names or fields. The relay therefore parses defensively:
 * the session id from any `sessionId`/`session_id`/`conversationId`-style
 * field, the final report from a result-like event's text, else the last
 * assistant message, else the concatenated text deltas; usage from any
 * `usage` object; an event whose type names an interruption marks the run
 * interrupted. events.jsonl keeps the raw stream for anything this misses.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Kiro (child process cwd; default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <id>            Kiro model id (`--model`; default: the agent's or `chat.defaultModel`).
 *   --effort <level>        Reasoning effort (`--effort`): low|medium|high|xhigh|max.
 *   --agent <name>          Kiro custom agent (`--agent`; default: Kiro's own default agent).
 *   --engine <v2|v3>        Agent engine (`--v2` / `--v3`; default: v3). stream-json needs one.
 *   --read-only             Review/diagnosis: `--trust-tools=read,grep` plus the git tripwire.
 *   --trust-tools <list>    Trust only these comma-separated tool categories instead of all
 *                           tools (e.g. read,grep,write). Mutually exclusive with --read-only.
 *   --resume-last           Resume the previous Kiro session in this directory (`--resume`);
 *                           send only the delta brief.
 *   --session <id>          Resume a specific session (`--resume-id <id>`); send only the
 *                           delta brief. Mutually exclusive with --resume-last.
 *   --kiro-path <file>      Path to the kiro-cli binary (default: `kiro-cli` on PATH;
 *                           the KIRO_CLI environment variable does the same).
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the kiro-cli process tree is
 *                           killed and result.json gets status "timeout".
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, kiroVersion, engine, model, effort, agent,
 *   readOnly, trustTools, sessionId (for a later resume, when the stream
 *   carries one), finalMessage (Kiro's own report), interrupted, usage (null if
 *   none), touchedFiles (git porcelain, null if git can't report),
 *   readOnlyViolation (read-only runs), stderrTail, and the paths to
 *   brief.txt, events.jsonl, and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `kiro-cli` binary exits
 * 127 and writes a result with status kiro_unavailable; otherwise the exit
 * code mirrors Kiro's own (0 success, 1 failure, 3 MCP startup failure under
 * --require-mcp-startup), except that a run whose stream ends in an
 * interruption record exits 1 even if kiro-cli exits 0. If the child dies on a
 * signal, the exit code is 128 plus the signal number and `result.json`
 * records the signal. Once the brief validates, `result.json` is written on
 * every outcome — completed, failed, timeout (the --timeout watchdog fired),
 * aborted (the relay itself was killed and forwarded the kill to kiro-cli), or
 * kiro_unavailable.
 */

import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync, appendFileSync, lstatSync, readlinkSync, openSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";

const MAX_BUFFERED_CHARS = 1_048_576;

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

const IMPLEMENTER_KEY = "kiro";
const DEFAULT_BIN = "kiro-cli";
// The headless docs' own least-privilege example for a review run.
const READ_ONLY_TRUST_TOOLS = "read,grep";
const ENGINES = new Set(["v2", "v3"]);
// kiro.dev/docs/reference/cli-commands: `--effort <LEVEL>` low|medium|high|xhigh|max.
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Value flags stay plain tokens: a launch through a .cmd/.bat override goes through a shell.
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
const TRUST_TOOLS_TOKEN = /^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/;

function makeEventScanner(onObject) {
  let buf = "";
  let index = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    if (!chunk) return;
    buf += chunk;
    for (;;) {
      while (index < buf.length) {
        const ch = buf[index];
        // Only track strings inside an object (depth > 0). At depth 0 we are
        // skipping a junk prefix, and an unmatched `"` there must not swallow the
        // real `{...}` that follows in the same chunk.
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') {
          if (depth > 0) inString = true;
        } else if (ch === "{") {
          if (depth === 0) start = index;
          depth += 1;
        } else if (ch === "}") {
          if (depth > 0) {
            depth -= 1;
            if (depth === 0 && start !== -1) {
              const slice = buf.slice(start, index + 1);
              try { onObject(JSON.parse(slice)); } catch { /* skip malformed */ }
              start = -1;
            }
          }
        }
        index += 1;
      }
      if (depth === 0 || start === -1 || buf.length - start <= MAX_BUFFERED_CHARS) break;
      // A complete object may exceed the retained-input cap within this chunk.
      // Drop only an oversized partial, then rescan its suffix so a later
      // concatenated event is not lost.
      buf = buf.slice(start + MAX_BUFFERED_CHARS);
      index = 0;
      start = -1;
      depth = 0;
      inString = false;
      escaped = false;
    }
    if (depth > 0 && start !== -1) {
      if (start > 0) {
        buf = buf.slice(start);
        index -= start;
        start = 0;
      }
    } else {
      buf = "";
      index = 0;
      start = -1;
    }
  };
}

function applyFleetLane(opts, flagged) {
  if (!opts.lane) return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../delegate-setup/scripts/lane.mjs");
  if (!existsSync(script)) {
    fail("--lane requires the delegate-setup skill installed beside this relay");
  }
  const r = spawnSync(
    process.execPath,
    [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", IMPLEMENTER_KEY],
    { encoding: "utf8", env: process.env },
  );
  if (r.error) fail(`lane resolve failed: ${r.error.message}`);
  if (r.status !== 0) {
    fail((r.stderr || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
  }
  let resolved;
  try {
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    resolved = JSON.parse(lines[lines.length - 1]);
  } catch {
    fail("lane resolve returned invalid JSON");
  }
  opts.laneSource = resolved.source;
  for (const [field, value] of Object.entries(resolved.dials || {})) {
    if (flagged.has(field)) continue;
    if (field === "readOnly" && (flagged.has("readOnly") || flagged.has("trustTools"))) continue;
    if (field === "trustTools" && (flagged.has("trustTools") || flagged.has("readOnly"))) continue;
    opts[field] = value;
  }
}

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const flagged = new Set();
  const opts = {
    lane: null,
    laneSource: null,
    brief: null,
    cd: process.cwd(),
    model: null,
    effort: null,
    agent: null,
    engine: "v3",
    readOnly: false,
    trustTools: null,
    resumeLast: false,
    session: null,
    kiroPath: null,
    timeout: null,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--lane": opts.lane = next(); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--effort": opts.effort = next(); flagged.add("effort"); break;
      case "--agent": opts.agent = next(); flagged.add("agent"); break;
      case "--engine": opts.engine = next(); flagged.add("engine"); break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--trust-tools": opts.trustTools = next(); flagged.add("trustTools"); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--kiro-path": opts.kiroPath = resolve(next()); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  // The watchdog is relay-only (kiro-cli has no timeout flag), so a malformed --timeout must
  // fail loudly here - a silent no-watchdog fallback would be wrong.
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  if (opts.readOnly && opts.trustTools !== null) {
    fail("--read-only and --trust-tools are mutually exclusive; --read-only already trusts read,grep");
  }
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive");
  }
  if (!ENGINES.has(opts.engine)) {
    fail(`invalid --engine "${opts.engine}" (expected: v2 or v3; stream-json needs one of them)`);
  }
  for (const flag of ["model", "effort", "agent", "session"]) {
    if (opts[flag] !== null && !SAFE_TOKEN.test(opts[flag])) {
      fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
  }
  if (opts.effort !== null && !EFFORT_LEVELS.has(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected: ${[...EFFORT_LEVELS].join(", ")})`);
  }
  if (opts.trustTools !== null && !TRUST_TOOLS_TOKEN.test(opts.trustTools)) {
    fail("--trust-tools takes comma-separated tool categories (letters, digits, _ and - only), e.g. read,grep,write");
  }
  try {
    if (!statSync(opts.cd).isDirectory()) fail(`--cd is not a directory: ${opts.cd}`);
  } catch {
    fail(`--cd directory not found: ${opts.cd}`);
  }
  return opts;
}

function parseDuration(duration) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  try {
    const seconds =
      BigInt(match[1] || 0) * 3600n +
      BigInt(match[2] || 0) * 60n +
      BigInt(match[3] || 0);
    const milliseconds = seconds * 1000n;
    if (milliseconds <= 0n || milliseconds > BigInt(MAX_TIMER_MS)) return null;
    return Number(milliseconds);
  } catch {
    return null;
  }
}

function killChild(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return;
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch {
      // The process tree already exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process group already exited.
    }
  }
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to kiro-cli chat --no-interactive\n";
  return match[1].replace(/^\s*\* ?/gm, "").trim() + "\n";
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  // No --brief: read from stdin (fd 0). Empty stdin is an error.
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  return stdin;
}

function resolveLaunch(opts) {
  // --kiro-path, then KIRO_CLI, then `kiro-cli` on PATH. Only a .cmd/.bat override is
  // launched through a shell (Windows cannot spawn those directly); every value flag is a
  // validated token and the brief travels on stdin, so no user text reaches that shell.
  const named = opts.kiroPath || (process.env.KIRO_CLI || "").trim() || null;
  const command = named || DEFAULT_BIN;
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  return { command: shell ? `"${command}"` : command, display: command, shell };
}

function versionProbeTimeout(opts) {
  // The watchdog is only armed once kiro-cli is running, so the preflight needs a bound of
  // its own: a version probe that never returns would wedge the relay here, before any
  // result.json exists, and --timeout could not reach it.
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  return timeoutMs === null ? VERSION_PROBE_TIMEOUT_MS : Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS);
}

function kiroVersion(launch, probeTimeoutMs) {
  // `--version` / `-V` is a documented global argument (kiro.dev/docs/reference/cli-commands).
  try {
    const version = execFileSync(launch.command, ["--version"], {
      encoding: "utf8",
      shell: launch.shell,
      timeout: probeTimeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { version: version || "unknown", error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: null, error: null };
    if (launch.shell && /not recognized as an internal or external command/i.test(String(error?.stderr || ""))) {
      return { version: null, error: null };
    }
    // A hung probe we killed, or a real non-zero exit, means kiro-cli is installed but not
    // usable. Reporting that as "unavailable" would send the caller off to reinstall it.
    return { version: null, error };
  }
}


// Porcelain status alone cannot see every write. A path that is " M file" before a run and
// " M file" after it produces an identical line, so comparing status lines proves nothing about
// its contents — which is why the read-only tripwire below fingerprints the already-dirty paths
// as well. Two sentinels stand for "could not fingerprint"; they are never treated as unchanged.
const FINGERPRINT_UNREADABLE = "<unreadable>";
const FINGERPRINT_DIRECTORY = "<directory>";

function gitRepoRoot(cwd) {
  // Porcelain paths are relative to the repository ROOT, not to the directory git ran in
  // (--porcelain forces status.relativePaths off). Joining them against a --cd that is a
  // subdirectory would look for <repo>/src/src/file and find nothing at either end.
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\n$/, "") || null;
  } catch {
    return null;
  }
}

function gitStatusEntries(cwd) {
  // -z so a path containing a space, a quote, or a newline stays one field rather than being
  // quoted and escaped; -uall so an untracked directory is expanded into its files, because a
  // collapsed "?? dir/" line never changes when a file inside it does.
  try {
    const output = execFileSync("git", ["status", "--porcelain", "-z", "-uall"], {
      cwd,
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const fields = new TextDecoder("utf-8", { fatal: true }).decode(output)
      .split("\0").filter((field) => field.length > 0);
    const entries = [];
    for (let i = 0; i < fields.length; i += 1) {
      const entry = fields[i];
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      // R and C can sit in EITHER status column, and under -z such an entry is followed by its
      // origin path as its own unprefixed field. Consume that field in both cases. A rename
      // origin belongs in the dirty set (the file moved away from it); a copy origin does not,
      // since a copy source can be a perfectly clean file.
      const renamed = status.includes("R");
      const copied = status.includes("C");
      let origin = null;
      if (renamed || copied) {
        i += 1;
        origin = fields[i] ?? null;
      }
      entries.push({ status, path, origin });
    }
    return entries;
  } catch {
    return null;
  }
}

function dirtyPaths(cwd) {
  const entries = gitStatusEntries(cwd);
  if (entries === null) return null;
  const paths = [];
  for (const entry of entries) {
    paths.push(entry.path);
    if (entry.status.includes("R") && entry.origin !== null) paths.push(entry.origin);
  }
  return paths;
}

function asciiFold(value) {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function canonicalFilePath(path) {
  const absolute = resolve(path);
  let parent;
  try { parent = realpathSync.native(dirname(absolute)); } catch { return absolute; }
  const leaf = basename(absolute);
  const canonical = join(parent, leaf);
  try { lstatSync(canonical); } catch { return canonical; }
  try {
    const entries = readdirSync(parent);
    if (entries.includes(leaf)) return canonical;
    const matches = entries.filter((entry) => asciiFold(entry) === asciiFold(leaf));
    return join(parent, matches.length === 1 ? matches[0] : leaf);
  } catch {
    return canonical;
  }
}

function gitPathKey(root, path) {
  let canonicalRoot;
  try { canonicalRoot = realpathSync.native(root); } catch { canonicalRoot = resolve(root); }
  const key = relative(canonicalRoot, canonicalFilePath(path));
  return process.platform === "win32" ? key.replaceAll("\\", "/") : key;
}

function gitPathIsExcluded(root, path, excluded, foldedExcluded) {
  return excluded.has(path) ||
    (foldedExcluded.has(asciiFold(path)) && excluded.has(gitPathKey(root, join(root, path))));
}

function gitTripwireState(cwd, excludedPaths) {
  const root = gitRepoRoot(cwd);
  if (root === null) return null;
  const entries = gitStatusEntries(cwd);
  if (entries === null) return null;
  const excluded = new Set(excludedPaths.map((path) => gitPathKey(root, path)));
  const foldedExcluded = new Set([...excluded].map(asciiFold));
  return entries.flatMap((entry) => [
    [entry.status, "path", entry.path],
    ...(entry.origin === null ? [] : [[entry.status.replace(/[^RC]/g, " "), "origin", entry.origin]]),
  ]
    .filter(([, , path]) => !gitPathIsExcluded(root, path, excluded, foldedExcluded)));
}

function pathFingerprint(absolutePath) {
  // Identity, not just bytes: a retargeted symlink, a flipped mode bit, or a file replaced by a
  // directory are all writes, and none of them change file contents.
  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    // Absence is a state, not a failure - it differs from every real fingerprint, so a deletion
    // or a re-creation still registers. Any other errno means we genuinely cannot tell.
    return error && error.code === "ENOENT" ? "absent" : FINGERPRINT_UNREADABLE;
  }
  if (stats.isSymbolicLink()) {
    try {
      return `symlink:${readlinkSync(absolutePath, { encoding: "buffer" }).toString("hex")}`;
    } catch {
      return FINGERPRINT_UNREADABLE;
    }
  }
  // A directory in the dirty set is a submodule, whose contents belong to another repository.
  // Reported as unknown coverage rather than silently passed off as unchanged.
  if (stats.isDirectory()) return FINGERPRINT_DIRECTORY;
  if (!stats.isFile()) return FINGERPRINT_UNREADABLE;
  let fd;
  try {
    // Streamed rather than read whole: an unignored multi-gigabyte artifact must not be pulled
    // into memory just to answer whether it changed.
    const hash = createHash("sha256");
    fd = openSync(absolutePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return `file:${(stats.mode & 0o7777).toString(8)}:${hash.digest("hex")}`;
  } catch {
    return FINGERPRINT_UNREADABLE;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function gitIndexFingerprints(root, paths) {
  if (paths.length === 0) return new Map();
  try {
    const output = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: root,
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const wanted = new Set(paths);
    const prints = new Map(paths.map((path) => [path, []]));
    for (const field of new TextDecoder("utf-8", { fatal: true }).decode(output).split("\0")) {
      if (!field) continue;
      const separator = field.indexOf("\t");
      if (separator === -1) return null;
      const path = field.slice(separator + 1);
      if (wanted.has(path)) prints.get(path).push(field.slice(0, separator));
    }
    return prints;
  } catch {
    return null;
  }
}

function fingerprintPaths(root, paths) {
  // `complete` goes false the moment one path cannot be fingerprinted, so the caller reports
  // "unknown" instead of an unearned clean bill of health.
  const indexPrints = gitIndexFingerprints(root, paths);
  const prints = new Map();
  let complete = indexPrints !== null;
  for (const path of paths) {
    const file = pathFingerprint(join(root, path));
    if (file === FINGERPRINT_UNREADABLE || file === FINGERPRINT_DIRECTORY) complete = false;
    prints.set(path, { file, index: indexPrints?.get(path) ?? null });
  }
  return { prints, complete };
}

function fingerprintDirtyPaths(cwd, excludedPaths) {
  // Only the already-dirty set is covered. A path that is clean at dispatch and gets written
  // surfaces as a brand-new porcelain line anyway, and fingerprinting a whole repository per run
  // would cost far more than the case it covers.
  const root = gitRepoRoot(cwd);
  if (root === null) return null;
  const paths = dirtyPaths(cwd);
  if (paths === null) return null;
  const excluded = new Set(excludedPaths.map((path) => gitPathKey(root, path)));
  const foldedExcluded = new Set([...excluded].map(asciiFold));
  return {
    root,
    ...fingerprintPaths(root, paths.filter((path) => !gitPathIsExcluded(root, path, excluded, foldedExcluded))),
  };
}

function changedDirtyPaths(before) {
  // Re-fingerprint exactly the baseline paths, not whatever happens to be dirty now: a path the
  // run newly dirtied is already reported by the porcelain comparison, and letting an unreadable
  // one of those blind this signal would be a regression, not caution.
  if (!before) return { changed: [], complete: false };
  const now = fingerprintPaths(before.root, [...before.prints.keys()]);
  const changed = [];
  for (const [path, print] of before.prints) {
    const current = now.prints.get(path);
    const fileKnown = print.file !== FINGERPRINT_UNREADABLE && current.file !== FINGERPRINT_UNREADABLE;
    const fileChanged = fileKnown &&
      !(print.file === FINGERPRINT_DIRECTORY && current.file === FINGERPRINT_DIRECTORY) &&
      current.file !== print.file;
    const indexChanged = print.index !== null && current.index !== null &&
      JSON.stringify(current.index) !== JSON.stringify(print.index);
    if (fileChanged || indexChanged) changed.push(path);
  }
  return { changed: changed.sort(), complete: before.complete && now.complete };
}

function readOnlyVerdict(beforeTree, afterTree, beforeFingerprints) {
  // Three-valued on purpose. Proof of a write settles it even when the other signal is unknown;
  // only when nothing is proven AND coverage is incomplete is the answer genuinely unknown.
  // Collapsing that last case to false is the false assurance a tripwire must never give.
  const changed = changedDirtyPaths(beforeFingerprints);
  const porcelainMoved =
    beforeTree !== null && afterTree !== null && JSON.stringify(beforeTree) !== JSON.stringify(afterTree);
  if (porcelainMoved || changed.changed.length > 0) return true;
  if (beforeTree === null || afterTree === null || !changed.complete) return null;
  return false;
}

function gitTouchedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  // Local script (not a workflow): Date is available and fine here.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function trustFlag(opts) {
  // Headless Kiro cannot prompt, so tools are granted up front (kiro.dev/docs/cli/headless).
  // `--trust-tools=<categories>` is spelled with `=` exactly as the docs show it.
  if (opts.readOnly) return `--trust-tools=${READ_ONLY_TRUST_TOOLS}`;
  if (opts.trustTools !== null) return `--trust-tools=${opts.trustTools}`;
  return "--trust-all-tools";
}

function buildArgv(opts) {
  const argv = [
    "chat",
    "--no-interactive",
    opts.engine === "v2" ? "--v2" : "--v3",
    "--output-format", "stream-json",
  ];
  if (opts.agent) argv.push("--agent", opts.agent);
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  argv.push(trustFlag(opts));
  if (opts.resumeLast) argv.push("--resume");
  else if (opts.session) argv.push("--resume-id", opts.session);
  // No positional instruction: the brief is piped on stdin, which the headless docs say Kiro
  // reads in full when no positional argument is present.
  return argv;
}

// --- stream-json parsing -------------------------------------------------------------------
// kiro.dev documents stream-json only as "run events as JSON Lines" plus, in V3, a final
// interruption record. No event names or fields are documented, so every reader below is a
// tolerant guess that ignores what it does not recognise.

function eventType(event) {
  const type = event.type ?? event.event ?? event.kind;
  return typeof type === "string" ? type : "";
}

function extractSessionId(event) {
  const candidates = [
    event.sessionId, event.session_id, event.conversationId, event.conversation_id,
    event.session && typeof event.session === "object" ? (event.session.id ?? event.session.sessionId) : null,
    event.data && typeof event.data === "object" ? (event.data.sessionId ?? event.data.session_id) : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => (typeof part === "string" ? part
        : part && typeof part === "object" && (part.type === undefined || part.type === "text") && typeof part.text === "string" ? part.text
          : ""))
      .filter(Boolean);
    return parts.length ? parts.join("") : null;
  }
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "message"]) {
      const nested = textOf(value[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function isAssistant(event, type) {
  const role = event.role ?? event.message?.role ?? event.data?.role;
  if (role === "assistant") return true;
  return /assistant|agent_message|^response$/i.test(type);
}

function classifyEvent(event) {
  // Returns { kind, text } — kind is result | assistant | delta | interrupt | error | other.
  const type = eventType(event);
  if (/interrupt/i.test(type) || event.interrupted === true) return { kind: "interrupt", text: null };
  // Observed from kiro-cli 2.27.1 (V3): ACP `sessionUpdate` events carry `data.update`, whose
  // `agent_message_chunk` holds the reply text, and a closing `runFinished` holds the whole
  // report in `data.finalText`.
  if (type === "runFinished") return { kind: "result", text: textOf(event.data?.finalText) };
  if (type === "sessionUpdate") {
    const update = event.data?.update;
    if (update?.sessionUpdate === "agent_message_chunk") return { kind: "delta", text: textOf(update.content) };
    return { kind: "other", text: null };
  }
  if (/thought|thinking|reason/i.test(type)) return { kind: "other", text: null };
  if (/delta|chunk/i.test(type)) {
    return { kind: "delta", text: textOf(event.delta) ?? textOf(event.text) ?? textOf(event.content) ?? textOf(event.data) };
  }
  if (/^(result|final|completion|done|end|turn_end|run_end)$/i.test(type) || typeof event.finalMessage === "string") {
    return {
      kind: "result",
      text: textOf(event.finalMessage) ?? textOf(event.result) ?? textOf(event.response) ?? textOf(event.text) ?? textOf(event.message),
    };
  }
  if (/error/i.test(type)) return { kind: "error", text: textOf(event.message) ?? textOf(event.error) ?? textOf(event.data) };
  if (isAssistant(event, type)) {
    return { kind: "assistant", text: textOf(event.content) ?? textOf(event.message) ?? textOf(event.text) ?? textOf(event.data) };
  }
  return { kind: "other", text: null };
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only Kiro's edits, not the relay's artifacts.
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    eventsPath: join(outDir, "events.jsonl"),
    finalPath: join(outDir, "final.txt"),
    briefPath: join(outDir, "brief.txt"),
    resultPath: join(outDir, "result.json"),
  };
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.finalPath, "", "utf8");
  return run;
}

function makeResultWriter(opts, version, run, launch) {
  // Returns writeResult(extra): merges the per-outcome fields onto the run's standing
  // metadata, persists result.json atomically, and returns the object it just wrote.
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "kiro",
      binary: launch.display,
      workdir: opts.cd,
      engine: opts.engine,
      agent: opts.agent,
      model: opts.model,
      effort: opts.effort,
      readOnly: opts.readOnly,
      trustTools: trustFlag(opts),
      resumeLast: opts.resumeLast,
      kiroVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      eventsPath: run.eventsPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      ...extra,
    };
    // Publish atomically so a polling orchestrator never reads a half-written file.
    const temporary = `${run.resultPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, run.resultPath);
    return result;
  };
}

function reportUnavailable(writeResult, resultPath, launch) {
  const result = writeResult({ status: "kiro_unavailable", exitCode: 127, signal: null, sessionId: null, finalMessage: "", interrupted: false, usage: null, touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write(`relay: \`${launch.display}\` not found. Install the Kiro CLI (curl -fsSL https://cli.kiro.dev/install | bash), set KIRO_API_KEY for headless runs, or point --kiro-path / KIRO_CLI at the binary.\n`);
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, probeTimeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  const message = timedOut
    ? `kiro-cli version preflight timed out after ${probeTimeoutMs}ms; Kiro was not dispatched`
    : `kiro-cli version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; Kiro was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    sessionId: null,
    finalMessage: "",
    interrupted: false,
    usage: null,
    touchedFiles: gitTouchedFiles(opts.cd),
    stderrTail: stderr ? stderr.split("\n").slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatchToKiro(opts, run, writeResult, launch, brief) {
  // `--trust-tools` trusts categories; it does not sandbox, and user or agent permission
  // rules can still allow a write. A --read-only run therefore snapshots the tree up front
  // and reports a violation instead of pretending to enforce.
  const relayArtifacts = [run.briefPath, run.eventsPath, run.finalPath, run.resultPath];
  const beforeTree = opts.readOnly ? gitTripwireState(opts.cd, relayArtifacts) : null;
  // Working-tree and index state for paths that are ALREADY dirty. Their porcelain lines will not
  // move if the run edits them, so the line comparison alone cannot see those writes.
  const beforeFingerprints = opts.readOnly ? fingerprintDirtyPaths(opts.cd, relayArtifacts) : null;
  // Every dispatched result that reports touchedFiles carries the verdict, aborted runs included.
  const readOnlyFlag = () =>
    opts.readOnly
      ? { readOnlyViolation: readOnlyVerdict(beforeTree, gitTripwireState(opts.cd, relayArtifacts), beforeFingerprints) }
      : {};
  const argv = buildArgv(opts);
  const child = spawn(launch.command, argv, {
    cwd: opts.cd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    shell: launch.shell,
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  });

  // The brief rides stdin. A CLI that exits before reading it closes the pipe; that EPIPE
  // is the run's outcome to report, not a relay crash.
  child.stdin.on("error", () => {});
  child.stdin.end(brief);

  let sessionId = opts.session || null;
  let usage = null;
  let interrupted = false;
  let resultText = null;
  let lastAssistant = null;
  let lastError = null;
  let deltas = [];
  const stderrTail = [];

  const scan = makeEventScanner((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const sid = extractSessionId(event);
    if (sid) sessionId = sid;
    if (event.usage && typeof event.usage === "object") usage = event.usage;
    const { kind, text } = classifyEvent(event);
    if (kind === "interrupt") interrupted = true;
    else if (kind === "delta" && text) deltas.push(text);
    else if (kind === "assistant" && text) {
      lastAssistant = text;
      deltas = [];
    } else if (kind === "result" && text) resultText = text;
    else if (kind === "error" && text) lastError = text;
  });

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk); // faithful raw record
    scan(stdoutDecoder.write(chunk));
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface Kiro progress live for the orchestrator
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    // A result-like event's text wins; else the text deltas streamed since the last full
    // assistant message (they are newer); else that last assistant message.
    const message = (resultText ?? (deltas.length ? deltas.join("") : lastAssistant) ?? "").trim();
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let watchdogTimer = null;
  let sigkillTimer = null;
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  if (timeoutMs !== null) {
    watchdogTimer = setTimeout(() => {
      watchdogFired = true;
      child.once("exit", () => {
        child.stdout.destroy();
        child.stderr.destroy();
      });
      killChild(child);
      sigkillTimer = setTimeout(() => {
        if (!settled) killChild(child, "SIGKILL");
      }, 10_000);
    }, timeoutMs);
  }

  const clearWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side writes no result.json and leaves kiro-cli running or dying mid-edit
  // with nothing recording why. SIGTERM/SIGHUP registration is a no-op on Windows.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId,
        finalMessage: assembleFinal(),
        interrupted,
        usage,
        touchedFiles: gitTouchedFiles(opts.cd),
        ...readOnlyFlag(),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; kiro-cli was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        writeResult({ ...abortedFields, touchedFiles: gitTouchedFiles(opts.cd), ...readOnlyFlag() });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      finalMessage: assembleFinal(),
      interrupted,
      usage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...readOnlyFlag(),
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    // a descendant that ignored SIGTERM must not outlive the timeout report: once the
    // parent is down, sweep the group (no-op where taskkill already felled the tree)
    if (watchdogFired) killChild(child, "SIGKILL");
    const finalMessage = assembleFinal();
    // A timed-out run is never a success even if kiro-cli exits 0 on SIGTERM, and neither is
    // a stream that ended in V3's interruption record.
    const succeeded = code === 0 && !watchdogFired && !interrupted;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const error = watchdogFired
      ? `kiro-cli did not finish within --timeout ${opts.timeout}; killed by the relay watchdog`
      : interrupted
        ? "kiro-cli reported an interrupted run (stream-json interruption record)"
        : !succeeded && lastError
          ? lastError
          : null;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 ? 1 : mapped,
      signal: signal ?? null,
      sessionId,
      finalMessage,
      interrupted,
      usage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...readOnlyFlag(),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(error ? { error } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // Prepare the run dir before probing, so a preflight that times out or fails still has
  // somewhere to publish result.json rather than exiting silently.
  const run = prepareRunDir(opts, brief);
  const launch = resolveLaunch(opts);
  const probeTimeoutMs = versionProbeTimeout(opts);
  const probe = kiroVersion(launch, probeTimeoutMs);
  const writeResult = makeResultWriter(opts, probe.version, run, launch);

  if (!probe.version && !probe.error) {
    reportUnavailable(writeResult, run.resultPath, launch);
    return;
  }
  if (probe.error) {
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs);
    return;
  }

  dispatchToKiro(opts, run, writeResult, launch, brief);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  kiro-cli ${result.kiroVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a Kiro error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated kiro-cli (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.readOnlyViolation === null) lines.push("warning: this --read-only run could not be verified - git could not report, or a submodule or unreadable path left coverage incomplete; inspect the working tree directly.");
  if (result.readOnlyViolation === true) lines.push("warning: a git-visible change was detected during this --read-only run — --trust-tools is not a sandbox; review the diff before trusting the run.");
  if (result.interrupted) lines.push("warning: kiro-cli ended the stream with an interruption record; the run did not finish.");
  lines.push(`engine: ${result.engine}  ·  tools: ${result.trustTools}${result.model ? `  ·  model: ${result.model}` : ""}${result.effort ? `  ·  effort: ${result.effort}` : ""}`);
  if (result.resumeLast) lines.push("mode: resumed the previous session in this directory (--resume)");
  else if (result.sessionId && result.status !== "kiro_unavailable") {
    lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  }
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable — inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  … and ${touched.length - 40} more`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- kiro final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
