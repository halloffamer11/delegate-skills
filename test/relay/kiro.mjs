import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const SESSION = "22222222-2222-4222-8222-222222222222";
const BASE = ["chat", "--no-interactive", "--v3", "--output-format", "stream-json"];

function dispatchKiro(h, name, relayArgs, env = {}) {
  const outDir = join(h.scratch, `out-kiro-${name}`);
  const workDir = h.freshRepo(`work-kiro-${name}`);
  const argsFile = join(h.scratch, `args-kiro-${name}`);
  const run = spawnSync(process.execPath, [
    h.relayPath("kiro"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...relayArgs,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "kiro-success", SMOKE_ARGS_FILE: argsFile, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  const captured = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : null;
  const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : null;
  return { run, captured, result, outDir, workDir };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function runKiro(h) {
  // Argv exactness: every flag here is from kiro.dev/docs/cli/headless and
  // kiro.dev/docs/reference/cli-commands; the brief rides stdin with no positional.
  for (const scenario of [
    { name: "default", relayArgs: [], forwarded: [...BASE, "--trust-all-tools"], readOnly: false },
    { name: "read-only", relayArgs: ["--read-only"], forwarded: [...BASE, "--trust-tools=read,grep"], readOnly: true },
    {
      name: "model-effort",
      relayArgs: ["--model", "fake-model-a", "--effort", "xhigh"],
      forwarded: [...BASE, "--model", "fake-model-a", "--effort", "xhigh", "--trust-all-tools"],
      readOnly: false,
    },
    {
      name: "read-only-model",
      relayArgs: ["--read-only", "--model", "fake-model-b", "--effort", "low"],
      forwarded: [...BASE, "--model", "fake-model-b", "--effort", "low", "--trust-tools=read,grep"],
      readOnly: true,
    },
    {
      name: "agent-engine-trust",
      relayArgs: ["--agent", "team/reviewer", "--engine", "v2", "--trust-tools", "read,grep,write"],
      forwarded: ["chat", "--no-interactive", "--v2", "--output-format", "stream-json", "--agent", "team/reviewer", "--trust-tools=read,grep,write"],
      readOnly: false,
    },
    { name: "session", relayArgs: ["--session", SESSION], forwarded: [...BASE, "--trust-all-tools", "--resume-id", SESSION], readOnly: false },
    { name: "resume-last", relayArgs: ["--resume-last"], forwarded: [...BASE, "--trust-all-tools", "--resume"], readOnly: false },
  ]) {
    const { run, captured, result, outDir } = dispatchKiro(h, scenario.name, scenario.relayArgs);
    h.check(`kiro ${scenario.name}: relay exits 0`, run.status === 0);
    h.check(`kiro ${scenario.name}: argv is exact (got ${JSON.stringify(captured?.args)})`,
      same(captured?.args, scenario.forwarded));
    h.check(`kiro ${scenario.name}: brief arrives on stdin, not argv`,
      captured?.brief === readFileSync(h.briefPath, "utf8") &&
      !captured.args.some((arg) => arg.includes("smoke brief")));
    h.check(`kiro ${scenario.name}: result is completed with the contract fields`,
      result?.schema === "delegate-relay.result.v1" &&
      result.status === "completed" &&
      result.exitCode === 0 &&
      result.signal === null &&
      result.sessionId === SESSION &&
      result.finalMessage === "fake kiro completed" &&
      Array.isArray(result.touchedFiles) && result.touchedFiles.length === 0 &&
      result.readOnly === scenario.readOnly &&
      result.kiroVersion === "fake-cli 0.0.0-smoke");
    h.check(`kiro ${scenario.name}: brief.txt, events.jsonl, final.txt are written`,
      readFileSync(join(outDir, "brief.txt"), "utf8") === readFileSync(h.briefPath, "utf8") &&
      readFileSync(join(outDir, "events.jsonl"), "utf8").includes('"session_start"') &&
      readFileSync(join(outDir, "final.txt"), "utf8") === "fake kiro completed");
    h.check(`kiro ${scenario.name}: read-only verdict ${scenario.readOnly ? "is false on a clean run" : "is absent"}`,
      scenario.readOnly ? result?.readOnlyViolation === false : result !== null && !("readOnlyViolation" in result));
    if (scenario.name === "model-effort") {
      h.check("kiro model-effort: result records model and effort",
        result?.model === "fake-model-a" && result?.effort === "xhigh" && result?.trustTools === "--trust-all-tools");
    }
  }

  // Report fallbacks: no result text means the deltas streamed after the last assistant message.
  {
    const { run, result } = dispatchKiro(h, "deltas", [], { SMOKE_MODE: "kiro-deltas" });
    h.check("kiro deltas: completed with the streamed text as the report",
      run.status === 0 && result?.status === "completed" && result.finalMessage === "fake kiro streamed ✅");
  }
  // The real V3 stream (kiro-cli 2.27.1): ACP sessionUpdate events, then runFinished
  // carrying the report in data.finalText and the session id in data.sessionId.
  {
    const { run, result } = dispatchKiro(h, "acp", [], { SMOKE_MODE: "kiro-acp" });
    h.check("kiro acp: runFinished finalText is the report",
      run.status === 0 && result?.status === "completed" && result.finalMessage === "fake kiro final ✅" &&
      result.sessionId === "sess_22222222-2222-4222-8222-222222222222");
  }
  {
    const { run, result } = dispatchKiro(h, "acp-chunks", [], { SMOKE_MODE: "kiro-acp-chunks" });
    h.check("kiro acp chunks: without finalText, the agent_message_chunk text is the report",
      run.status === 0 && result?.status === "completed" && result.finalMessage === "fake kiro acp ✅");
  }
  // V3's interruption record ends the run as failed even when kiro-cli exits 0.
  {
    const { run, result } = dispatchKiro(h, "interrupted", [], { SMOKE_MODE: "kiro-interrupted" });
    h.check("kiro interrupted: exit 1 and status failed",
      run.status === 1 && result?.status === "failed" && result.exitCode === 1 && result.interrupted === true &&
      /interrupt/.test(result.error ?? ""));
  }
  // A CLI that exits without reading stdin (e.g. no KIRO_API_KEY): EPIPE must not crash the relay.
  {
    const { run, result } = dispatchKiro(h, "exit-early", [], { SMOKE_MODE: "kiro-exit-early" });
    h.check("kiro exit-early: CLI failure is reported, not a relay crash",
      run.status === 1 && result?.status === "failed" && result.exitCode === 1 &&
      Array.isArray(result.stderrTail) && result.stderrTail.some((line) => line.includes("authentication failed")) &&
      /KIRO_API_KEY/.test(result.error ?? ""));
  }

  // Usage errors exit 2 before any artifact.
  for (const [name, args] of [
    ["bad-model", ["--model", "claude;rm -rf /"]],
    ["blank-model", ["--model", ""]],
    ["bad-effort", ["--effort", "extreme"]],
    ["bad-engine", ["--engine", "v1"]],
    ["read-only-plus-trust", ["--read-only", "--trust-tools", "read,write"]],
    ["bad-trust-tools", ["--trust-tools", "read;shell"]],
    ["resume-conflict", ["--resume-last", "--session", SESSION]],
    ["unknown-flag", ["--trust-all-tools"]],
  ]) {
    const { run, outDir } = dispatchKiro(h, `usage-${name}`, args);
    h.check(`kiro usage ${name}: exits 2 before writing a result`, run.status === 2 && !existsSync(join(outDir, "result.json")));
  }

  // --kiro-path and KIRO_CLI select the binary; PATH is then irrelevant.
  if (!h.WIN) {
    const shimDir = h.baseEnv.PATH.split(delimiter)[0];
    const custom = join(h.scratch, "custom-kiro");
    writeFileSync(custom, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(shimDir, "fake-cli.cjs"))} "$@"\n`);
    chmodSync(custom, 0o755);
    const viaFlag = dispatchKiro(h, "kiro-path", ["--kiro-path", custom], { PATH: "/usr/bin:/bin" });
    h.check("kiro --kiro-path: launches the named binary",
      viaFlag.run.status === 0 && viaFlag.result?.status === "completed" && viaFlag.result.binary === custom);
    const viaEnv = dispatchKiro(h, "kiro-env", [], { PATH: "/usr/bin:/bin", KIRO_CLI: custom });
    h.check("kiro KIRO_CLI: launches the named binary",
      viaEnv.run.status === 0 && viaEnv.result?.status === "completed" && viaEnv.result.binary === custom);
    const missing = dispatchKiro(h, "kiro-path-missing", ["--kiro-path", join(h.scratch, "no-such-kiro")]);
    h.check("kiro --kiro-path missing: kiro_unavailable with exit 127 and a result file",
      missing.run.status === 127 && missing.result?.status === "kiro_unavailable" && missing.result.touchedFiles === null);
  } else {
    console.log("  skip  kiro --kiro-path/KIRO_CLI: the POSIX sh shim cannot run on Windows");
  }

  // The relay passes KIRO_API_KEY through untouched and never writes it into an artifact.
  {
    const { run, outDir } = dispatchKiro(h, "api-key-passthrough", [], { KIRO_API_KEY: "smoke-kiro-key-not-a-secret" });
    const artifacts = ["result.json", "brief.txt", "events.jsonl", "final.txt"]
      .map((file) => readFileSync(join(outDir, file), "utf8")).join("\n");
    h.check("kiro api key: run completes and no artifact contains the key",
      run.status === 0 && !artifacts.includes("smoke-kiro-key-not-a-secret") && !run.stdout.includes("smoke-kiro-key-not-a-secret"));
  }
}
