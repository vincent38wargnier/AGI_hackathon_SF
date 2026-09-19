import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import dotenv from "dotenv";

const APP_ROOT = "/home/vincent/vince_assistant_codex/workspace/live-voice-prototype";
const TASK_ROOT = "/home/vincent/vince_assistant_codex/workspace/tasks/voice-conversation-first";
const EVIDENCE_ROOT = path.join(TASK_ROOT, "evidence");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(EVIDENCE_ROOT, "fresh-qa", RUN_ID);
const BASE_URL = process.env.LIVE_VOICE_URL || "http://127.0.0.1:4793";

dotenv.config({ path: path.join(APP_ROOT, ".env"), quiet: true });

const scenarios = {
  baseline: [
    {
      name: "baseline-local-pricing",
      utterances: ["Should we push annual pricing harder, or fix onboarding first?"],
      web: false,
      expectedAudioStarts: 1,
      timeoutMs: 45_000,
    },
  ],
  heldout: [
    {
      name: "quiet-yes-no-dunno",
      utterances: ["Yes.", "No.", "I don't know."],
      web: false,
      expectedAudioStarts: 3,
      timeoutMs: 70_000,
    },
    {
      name: "skeptical-busy",
      utterances: ["I'm busy. What is this for?", "Maybe, but be quick."],
      web: false,
      expectedAudioStarts: 2,
      timeoutMs: 65_000,
    },
    {
      name: "engaged-rag-web",
      utterances: ["Compare our onboarding problem with public SaaS benchmarks before recommending the next experiment.", "Okay, what would you test first?"],
      web: true,
      expectedAudioStarts: 2,
      timeoutMs: 90_000,
    },
    {
      name: "correction",
      utterances: ["Should we focus the pricing page on annual discounts?", "Actually, not pricing. Focus on enterprise security objections."],
      web: false,
      expectedAudioStarts: 2,
      timeoutMs: 75_000,
    },
    {
      name: "explicit-refusal",
      utterances: ["No thanks. I'm not interested."],
      web: false,
      expectedAudioStarts: 1,
      timeoutMs: 45_000,
    },
  ],
  webcheck: [
    {
      name: "engaged-rag-web",
      utterances: ["Compare our onboarding problem with public SaaS benchmarks before recommending the next experiment.", "Okay, what would you test first?"],
      web: true,
      expectedAudioStarts: 2,
      timeoutMs: 90_000,
    },
  ],
  faults: [
    {
      name: "slow-rag-nonblocking",
      utterances: ["Should we fix onboarding first while local research is slow?"],
      web: false,
      faults: { local_rag: { delayMs: 7000, fail: false } },
      expectedAudioStarts: 1,
      timeoutMs: 45_000,
    },
    {
      name: "failed-web-nonblocking",
      utterances: ["Search the public web for SaaS onboarding benchmarks, but keep talking if web search fails."],
      web: true,
      faults: { web: { delayMs: 1200, fail: true } },
      expectedAudioStarts: 1,
      timeoutMs: 45_000,
    },
  ],
  silence: [
    {
      name: "silence-check",
      utterances: [],
      silenceOnlyMs: 7000,
      web: false,
      expectedAudioStarts: 1,
      timeoutMs: 35_000,
    },
  ],
};

const mode = process.argv[2] || "baseline";
const selected = scenarios[mode] || scenarios.baseline;

await fs.mkdir(RUN_DIR, { recursive: true });
await fs.appendFile(path.join(EVIDENCE_ROOT, "LEG_HB"), `${new Date().toISOString()} fresh QA ${mode} start\n`);

const results = [];
for (const scenario of selected) {
  try {
    results.push(await runScenario(scenario));
  } catch (error) {
    results.push({
      name: scenario.name,
      web: Boolean(scenario.web),
      faults: scenario.faults || {},
      utterances: scenario.utterances,
      error: error.message,
      analysis: { scenario: scenario.name, passedMinimum: false, transcripts: [], speech: [], turns: [], jobs: [], nonblocking: false },
    });
  }
  await fs.appendFile(path.join(EVIDENCE_ROOT, "LEG_HB"), `${new Date().toISOString()} fresh QA ${scenario.name} done\n`);
}

const summary = summarize(results);
await fs.writeFile(path.join(RUN_DIR, "results.json"), JSON.stringify({ runId: RUN_ID, mode, summary, results }, null, 2));
await fs.writeFile(path.join(RUN_DIR, "SUMMARY.md"), renderSummary({ mode, runDir: RUN_DIR, summary, results }));
console.log(JSON.stringify({ runDir: RUN_DIR, summary }, null, 2));

async function runScenario(scenario) {
  const scenarioDir = path.join(RUN_DIR, scenario.name);
  await fs.mkdir(scenarioDir, { recursive: true });
  const audioPath = await buildMicAudio(scenario, scenarioDir);
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome-stable",
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${audioPath}`,
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
    ],
  });
  const context = await browser.newContext({
    recordVideo: { dir: scenarioDir, size: { width: 1280, height: 900 } },
    viewport: { width: 1280, height: 900 },
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  await page.context().grantPermissions(["microphone"], { origin: BASE_URL });
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.localStorage?.clear?.());
  await page.request.post(`${BASE_URL}/api/reset`);
  await page.request.post(`${BASE_URL}/api/web`, { data: { enabled: Boolean(scenario.web) } });
  await page.request.post(`${BASE_URL}/api/faults`, { data: scenario.faults || {} });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  if (audioPath) {
    const client = await context.newCDPSession(page);
    await client.send("Browser.grantPermissions", { origin: BASE_URL, permissions: ["audioCapture"] }).catch(() => {});
  }

  await page.screenshot({ path: path.join(scenarioDir, "initial.png"), fullPage: true });
  await page.click("#startBtn");
  await waitForScenario(page, scenario);
  await page.screenshot({ path: path.join(scenarioDir, "final.png"), fullPage: true });
  const data = await collect(page);
  await fs.writeFile(path.join(scenarioDir, "raw.json"), JSON.stringify(data, null, 2));
  await context.close();
  await browser.close();
  const video = page.video() ? await page.video().path().catch(() => null) : null;
  const analysis = analyzeScenario(scenario, data);
  await fs.writeFile(path.join(scenarioDir, "analysis.json"), JSON.stringify(analysis, null, 2));
  return {
    name: scenario.name,
    web: Boolean(scenario.web),
    faults: scenario.faults || {},
    utterances: scenario.utterances,
    screenshot: path.join(scenarioDir, "final.png"),
    initialScreenshot: path.join(scenarioDir, "initial.png"),
    video,
    raw: path.join(scenarioDir, "raw.json"),
    analysis,
  };
}

async function waitForScenario(page, scenario) {
  const expected = scenario.expectedAudioStarts || 1;
  const deadline = Date.now() + (scenario.timeoutMs || 45_000);
  while (Date.now() < deadline) {
    const starts = await page.evaluate(() => window.__liveVoiceQa?.browserEvents?.filter((e) => e.type === "browser_audio_start").length || 0);
    const active = await page.evaluate(() => window.__liveVoiceQa?.getState?.()?.floor);
    if (starts >= expected) {
      await page.evaluate(() => window.__liveVoiceQa?.stopMicOnly?.()).catch(() => {});
      if (active === "awaiting_user") return;
    }
    await page.waitForTimeout(500);
  }
}

async function collect(page) {
  return page.evaluate(() => ({
    timeline: window.__liveVoiceQa?.timeline || [],
    browserEvents: window.__liveVoiceQa?.browserEvents || [],
    state: window.__liveVoiceQa?.getState?.() || null,
    text: document.body.innerText,
  }));
}

async function buildMicAudio(scenario, dir) {
  const audioPath = path.join(dir, "mic.wav");
  if (scenario.silenceOnlyMs) {
    ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `anullsrc=channel_layout=mono:sample_rate=48000`, "-t", String(scenario.silenceOnlyMs / 1000), audioPath]);
    return audioPath;
  }
  const utterances = scenario.utterances || [];
  const pieces = [];
  let index = 0;
  pieces.push(await silence(dir, index++, 0.8));
  for (const utterance of utterances) {
    pieces.push(await speechClip(dir, index++, utterance));
    pieces.push(await silence(dir, index++, 9.0));
  }
  const listPath = path.join(dir, "concat.txt");
  await fs.writeFile(listPath, pieces.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
  ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-ac", "1", "-ar", "48000", audioPath]);
  return audioPath;
}

async function speechClip(dir, index, text) {
  const key = process.env.OPENAI_API_KEY || process.env.OPENAI_PLATFORM_API_KEY;
  if (!key) throw new Error("OpenAI API key is required to synthesize QA mic audio");
  const mp3 = path.join(dir, `${String(index).padStart(2, "0")}-speech.mp3`);
  const wav = path.join(dir, `${String(index).padStart(2, "0")}-speech.wav`);
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE || "alloy",
      input: text,
      response_format: "mp3",
      speed: 1.08,
    }),
  });
  if (!response.ok) throw new Error(`QA speech synthesis failed ${response.status}`);
  await fs.writeFile(mp3, Buffer.from(await response.arrayBuffer()));
  ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", mp3, "-ac", "1", "-ar", "48000", wav]);
  return wav;
}

async function silence(dir, index, seconds) {
  const wav = path.join(dir, `${String(index).padStart(2, "0")}-silence.wav`);
  ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=48000", "-t", String(seconds), wav]);
  return wav;
}

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", args, { stdio: "pipe" });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.toString()}`);
}

function analyzeScenario(scenario, data) {
  const browserEvents = data.browserEvents || [];
  const timeline = [...(data.timeline || [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const speech = data.state?.speech || [];
  const finals = timeline.filter((e) => /Final transcript/i.test(e.label));
  const commits = browserEvents.filter((e) => e.type === "browser_silence_finalized");
  const starts = browserEvents.filter((e) => e.type === "browser_audio_start");
  const firstChunks = browserEvents.filter((e) => e.type === "browser_audio_first_chunk");
  const turns = starts.map((start, index) => {
    const acoustic = [...commits].reverse().find((e) => e.wallMs <= start.wallMs);
    const finalTranscript = finals.find((e) => acoustic && Date.parse(e.at) >= acoustic.wallMs - 100 && Date.parse(e.at) <= start.wallMs + 5000);
    const unit = speech.find((s) => s.id === start.speechId);
    const firstChunk = firstChunks.find((e) => e.speechId === start.speechId);
    return {
      index: index + 1,
      speechId: start.speechId,
      userPerceivedLatencyMs: acoustic ? Math.round(start.wallMs - acoustic.acousticEndWallMs) : null,
      endpointDelayMs: acoustic?.endpointDelayMs ?? null,
      finalTranscriptAt: finalTranscript?.at || null,
      finalToPlaybackMs: finalTranscript ? Math.round(start.wallMs - Date.parse(finalTranscript.at)) : null,
      serverTtsFirstChunkMs: unit?.ttsFirstChunkMs ?? null,
      browserFirstChunkToPlaybackMs: firstChunk ? Math.round(start.wallMs - firstChunk.wallMs) : null,
      text: unit?.text || "",
      evidenceIds: unit?.evidenceIds || [],
    };
  });
  const jobs = data.state?.jobs || [];
  return {
    scenario: scenario.name,
    passedMinimum: starts.length >= (scenario.expectedAudioStarts || 1),
    transcripts: data.state?.conversation || [],
    speech: speech.map(({ id, text, status, kind, ttsFirstChunkMs, ttsElapsedMs, playbackStartedAt, evidenceIds }) => ({ id, text, status, kind, ttsFirstChunkMs, ttsElapsedMs, playbackStartedAt, evidenceIds })),
    turns,
    jobs: jobs.map(({ id, source, query, status, durationMs, required, resultCount, error }) => ({ id, source, query, status, durationMs, required, resultCount, error })),
    nonblocking: jobs.some((j) => ["scheduled", "running"].includes(j.status)) ? starts.length > 0 : true,
  };
}

function summarize(results) {
  const latencies = results.flatMap((r) => r.analysis.turns.map((t) => t.userPerceivedLatencyMs).filter(Number.isFinite)).sort((a, b) => a - b);
  return {
    scenarioCount: results.length,
    turnCount: latencies.length,
    p50UserPerceivedLatencyMs: percentile(latencies, 0.5),
    p95UserPerceivedLatencyMs: percentile(latencies, 0.95),
    minUserPerceivedLatencyMs: latencies[0] ?? null,
    maxUserPerceivedLatencyMs: latencies.at(-1) ?? null,
    passCount: results.filter((r) => r.analysis.passedMinimum).length,
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index];
}

function renderSummary({ mode, runDir, summary, results }) {
  return `# Fresh voice QA ${mode}

Run: ${runDir}

- Scenarios: ${summary.scenarioCount}
- Turns with acoustic-end/playback latency: ${summary.turnCount}
- p50 acoustic end -> browser playback: ${summary.p50UserPerceivedLatencyMs ?? "n/a"} ms
- p95 acoustic end -> browser playback: ${summary.p95UserPerceivedLatencyMs ?? "n/a"} ms
- Range: ${summary.minUserPerceivedLatencyMs ?? "n/a"}-${summary.maxUserPerceivedLatencyMs ?? "n/a"} ms
- Minimum scenario pass count: ${summary.passCount}/${summary.scenarioCount}

${results.map((r) => `## ${r.name}

- Screenshot: ${r.screenshot}
- Video: ${r.video || "unavailable"}
- Raw: ${r.raw}
- Turns: ${r.analysis.turns.map((t) => `${t.userPerceivedLatencyMs ?? "n/a"}ms "${t.text}"`).join("; ") || "none"}
- Jobs: ${r.analysis.jobs.map((j) => `${j.source}:${j.status}:${j.durationMs ?? "n/a"}ms`).join(", ") || "none"}
`).join("\n")}
`;
}
