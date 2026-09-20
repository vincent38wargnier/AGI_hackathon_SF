import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { config } from "./config.js";

// Ported from the Boson bridge (boson/bridge/server.py run_claude + APPEND_SYSTEM):
// same audio-mode contract, same --continue-with-fallback invocation, same
// scratch-dir /files/ publishing convention.
const APPEND_SYSTEM =
  "Audio mode: your answer will be read aloud to a listener who cannot " +
  "see a screen. Respond with the bare minimum — condensed, answer-first, " +
  "one or two short plain sentences. Only what is necessary, never deep " +
  "details, no enumerations of options, no caveats, unless the user " +
  "specifically asks for detail. No markdown, no code unless explicitly " +
  "asked. We need the fastest possible results: don't overload data, go to " +
  "the minimum. " +
  "You are reached through a voice bridge. Any file you save in your current " +
  "working directory is downloadable by the user at /files/<filename> " +
  "(clickable in their browser). When the user wants a link to something you " +
  "made, save it in the working directory and answer with that /files/ path. " +
  "Whenever you create or edit a file meant to be viewed (an HTML page, an " +
  "image, a document), ALWAYS include its /files/<filename> path in your " +
  "answer so it can be shown on screen. Even after building something, " +
  "report it in ONE short spoken sentence plus the /files/ path — never " +
  "list features or sections. " +
  "You DO have web access (search, fetch): when asked to find something " +
  "online, actually search for it instead of asking the user to provide it.";

function engineEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CLAUDE") || key.startsWith("ANTHROPIC")) continue;
    env[key] = value;
  }
  return env;
}

function engineLog(message) {
  try {
    fs.appendFileSync(path.join(config.claudeTaskDir, "engine.log"), `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function execClaude(args) {
  return new Promise((resolve) => {
    execFile(config.claudeBin, args, {
      cwd: config.claudeScratchDir,
      env: engineEnv(),
      timeout: config.claudeTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        timedOut: Boolean(error && (error.killed || error.signal === "SIGKILL")),
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").slice(-400),
      });
    });
  });
}

// Never throws: failures come back as speakable text (bridge semantics).
export async function runClaudeTask(task) {
  fs.mkdirSync(config.claudeScratchDir, { recursive: true });
  const started = Date.now();
  engineLog(`START ${JSON.stringify(String(task).slice(0, 200))}`);
  const baseArgs = [
    "-p",
    "--model", config.claudeModel,
    "--dangerously-skip-permissions",
    "--append-system-prompt", APPEND_SYSTEM,
  ];
  let result = await execClaude([...baseArgs, "--continue", task]);
  if (!result.ok || !result.stdout) {
    if (!result.timedOut) {
      engineLog(`continue fell back (stderr=${JSON.stringify(result.stderr)})`);
      result = await execClaude([...baseArgs, task]);
    }
  }
  const elapsedMs = Date.now() - started;
  if (!result.ok || !result.stdout) {
    const reason = result.timedOut
      ? "The build ran out of time before finishing."
      : "The build hit an error and produced no result.";
    engineLog(`FAILED ${elapsedMs}ms timedOut=${result.timedOut} stderr=${JSON.stringify(result.stderr)}`);
    return { text: `${reason} It can be retried or simplified.`, elapsedMs, model: config.claudeModel, failed: true };
  }
  engineLog(`OK ${elapsedMs}ms result=${JSON.stringify(result.stdout.slice(0, 200))}`);
  return { text: result.stdout, elapsedMs, model: config.claudeModel, failed: false };
}
