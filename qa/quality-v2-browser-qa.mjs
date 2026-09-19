import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import dotenv from "dotenv";

const REPO_ROOT = process.cwd();
const TASK_ROOT = process.env.TASK_ROOT || "/home/vincent/vince_assistant_codex/workspace/tasks/voice-quality-v2";
const EVIDENCE_ROOT = path.join(TASK_ROOT, "evidence/browser-qa");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(EVIDENCE_ROOT, RUN_ID);
const BASE_URL = process.env.QA_URL || "http://127.0.0.1:4813";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const selectedScenarioName = exactScenarioSelection();
const PLAYED_STATUSES = new Set(["played"]);
const BANNED_GAME_INVITATION = /\b(another round|switch (?:to )?(?:a )?(?:different )?game|play again|new round)\b/i;
const CRITICISM_ACK = /\b(sorry|you'?re right|i missed|i should have|that was my mistake|fair criticism|bad call|too much|overfocused|got stuck)\b/i;
const CRITICISM_FIX = /\b(clue|answer|tesla|nikola|context|question|guess|next time|should have used|missed)\b/i;
const unicodeInputs = ["ニコラテスラ", "Софья Ковалевская", "Αθηνά", "Дмитрий"];

dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

const scenarios = [
  {
    name: "voice-public-web-enrichment",
    kind: "voice",
    web: true,
    utterances: [
      "Compare onboarding activation with public SaaS benchmarks before recommending the next experiment.",
    ],
    timeoutMs: 120_000,
    checks: [
      (data) => ok(data.state.jobs.some((j) => j.source === "web" && j.status === "done"), "public web job completed"),
      (data) => ok(data.state.evidence.some((e) => e.source === "web" && e.sourceUrl), "public web evidence has URL"),
      (data) => checkWebEvidenceUsedInPlayedSpeech(data),
      (data) => ok((data.state.metrics?.latencySamples || []).some((s) => Number.isFinite(s.acousticEndToPlaybackMs)), "runtime captured acoustic-end latency"),
    ],
  },
  {
    name: "typed-uncertain-answer-retained",
    kind: "typed",
    web: false,
    turns: [
      "Let's play a guessing game. I'm thinking of a famous dead scientist. I don't know about the Nobel thing, probably yeah.",
      "Ask one yes-or-no question next.",
    ],
    checks: [
      (data) => ok(data.state.durableMemory.uncertainties.some((m) => /probably|don'?t know/i.test(m.text)), "uncertainty stored as uncertainty"),
      (data) => ok(!data.state.durableMemory.facts.some((m) => /probably|don'?t know/i.test(m.text)), "tentative answer was not promoted to fact"),
      (data) => ok(!latestAssistant(data).match(/nobel/i), "assistant did not repeat Nobel as the next question"),
    ],
  },
  {
    name: "typed-criticism-and-stale-reply",
    kind: "typed",
    web: false,
    turns: [
      "The answer was Nikola Tesla. Why did you suck so much to find it?",
    ],
    checks: [
      (data) => ok(conversationText(data).match(/Why did you suck so much/i), "criticism transcript retained"),
      (data) => checkCriticismAnswered(data),
      (data) => ok(!speechAfterCriticism(data).some((s) => BANNED_GAME_INVITATION.test(s.text || "")), "no post-criticism speech invites another round or game switch"),
    ],
  },
  {
    name: "typed-unicode-final-retained",
    kind: "typed",
    web: false,
    turns: [
      `${unicodeInputs[0]} is the answer I gave.`,
      `Held-out positive control: ${unicodeInputs[1]} is the answer I gave now.`,
      `Question negative control: is ${unicodeInputs[2]} only a question here?`,
      `Mention negative control: I am mentioning ${unicodeInputs[3]} without giving it as an answer.`,
    ],
    checks: [
      (data) => checkUnicodeRetained(data),
      (data) => checkUnicodePlayedResponse(data),
    ],
  },
  {
    name: "typed-correction-invalidates-preparation",
    kind: "typed",
    web: false,
    turns: [
      "Should we focus the pricing page on annual discounts?",
      "Actually, not pricing. Focus on enterprise security objections.",
    ],
    checks: [
      (data) => ok(data.state.durableMemory.corrections.some((m) => /not pricing/i.test(m.text)), "correction retained"),
      (data) => ok(data.state.speech.some((s) => s.status === "cancelled") || (data.state.metrics.cancelledPreparations || 0) > 0, "some stale/prepared audio was cancelled or invalidated"),
      (data) => ok(!latestAssistant(data).match(/annual discounts/i), "latest assistant did not keep stale pricing focus"),
    ],
  },
  {
    name: "typed-long-session-constraints",
    kind: "typed",
    web: false,
    turns: [
      "Let's play twenty questions. My only answers can be yes or no.",
      "The person is dead.",
      "The person is famous.",
      "The field is technology.",
      "No.",
      "Yes.",
      "Keep asking yes-or-no questions and don't ask for hints.",
    ],
    checks: [
      (data) => ok(data.state.durableMemory.constraints.some((m) => /yes|no/i.test(m.text)), "yes/no constraint durable"),
      (data) => ok(!latestAssistant(data).match(/hint|tell me|give me/i), "latest question did not ask for a hint"),
      (data) => ok(latestAssistant(data).trim().endsWith("?"), "latest assistant yielded after one question"),
    ],
  },
];

await fs.mkdir(RUN_DIR, { recursive: true });
await heartbeat(`browser QA start ${RUN_ID}`);

const selectedScenarios = scenarios.filter((scenario) => scenario.name === selectedScenarioName);
if (selectedScenarios.length !== 1) {
  throw new Error(`Unknown QA scenario "${selectedScenarioName}". Valid scenarios: ${scenarios.map((s) => s.name).join(", ")}`);
}

const results = [];
for (const scenario of selectedScenarios) {
  const result = await runScenario(scenario).catch((error) => ({ name: scenario.name, ok: false, error: error.message }));
  results.push(result);
  await heartbeat(`browser QA ${scenario.name} ${result.ok ? "ok" : "failed"}`);
}

const summary = {
  runDir: RUN_DIR,
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  results,
  latency: summarizeLatency(results),
};
await fs.writeFile(path.join(RUN_DIR, "summary.json"), JSON.stringify(summary, null, 2));
await fs.writeFile(path.join(RUN_DIR, "SUMMARY.md"), renderSummary(summary));
console.log(JSON.stringify(summary, null, 2));
if (summary.passed !== summary.total) process.exitCode = 1;

async function runScenario(scenario) {
  const dir = path.join(RUN_DIR, scenario.name);
  await fs.mkdir(dir, { recursive: true });
  const audioPath = scenario.kind === "voice" ? await buildMicAudio(scenario, dir) : null;
  const browser = await chromium.launch({
    headless: false,
    executablePath: CHROME,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      ...(audioPath ? [`--use-file-for-fake-audio-capture=${audioPath}`] : []),
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1360, height: 920 },
    permissions: ["microphone"],
    recordVideo: { dir, size: { width: 1360, height: 920 } },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.request.post(`${BASE_URL}/api/reset`);
    await page.request.post(`${BASE_URL}/api/web`, { data: { enabled: Boolean(scenario.web) } });
    await page.request.post(`${BASE_URL}/api/faults`, { data: {} });
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(dir, "01-initial.png"), fullPage: true });
    if (scenario.kind === "voice") await runVoice(page, scenario);
    else await runTyped(page, scenario);
    await page.screenshot({ path: path.join(dir, "02-final.png"), fullPage: true });
    const data = await collect(page);
    await fs.writeFile(path.join(dir, "raw.json"), JSON.stringify(data, null, 2));
    const checks = [];
    for (const check of scenario.checks) checks.push(check(data));
    const video = page.video() ? await page.video().path().catch(() => null) : null;
    return {
      name: scenario.name,
      ok: checks.every((c) => c.ok),
      checks,
      screenshot: path.join(dir, "02-final.png"),
      raw: path.join(dir, "raw.json"),
      video,
      latencySamples: data.state.metrics?.latencySamples || [],
      qualityCounters: data.state.metrics?.qualityCounters || {},
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function runTyped(page, scenario) {
  for (const [index, turn] of scenario.turns.entries()) {
    const before = await page.evaluate(() => window.__liveVoiceQa?.getState?.()?.speech?.length || 0);
    await page.fill("#typedInput", turn);
    await page.click(".send-button");
    await waitForActualPlaybackCompletion(page, before, index === scenario.turns.length - 1 ? scenario.timeoutMs || 90_000 : 90_000);
    await page.waitForTimeout(800);
  }
}

async function runVoice(page, scenario) {
  await page.click("#startBtn");
  const deadline = Date.now() + (scenario.timeoutMs || 120_000);
  while (Date.now() < deadline) {
    const data = await collect(page);
    const hasCompletedAudio = playedSpeechUnits(data).length > 0;
    const webDone = !scenario.web || data.state.jobs.some((j) => j.source === "web" && j.status === "done");
    if (hasCompletedAudio && webDone) break;
    await page.waitForTimeout(700);
  }
  await page.evaluate(() => window.__liveVoiceQa?.stopMicOnly?.()).catch(() => {});
  await page.waitForTimeout(1200);
}

async function waitForActualPlaybackCompletion(page, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    lastSnapshot = await collect(page);
    const speech = lastSnapshot.state?.speech || [];
    const completed = speech
      .filter((s, i) => i >= before && PLAYED_STATUSES.has(s.status))
      .find((s) => hasPlaybackStart(lastSnapshot, s.id) && hasPlaybackEnd(lastSnapshot, s.id));
    if (completed) return completed;
    await page.waitForTimeout(500);
  }
  const recentSpeech = (lastSnapshot?.state?.speech || []).slice(before).map((s) => `${s.id}:${s.status}:${s.text}`).join(" | ") || "none";
  const recentEvents = (lastSnapshot?.browserEvents || []).filter((e) => /^browser_audio/.test(e.type)).slice(-8).map((e) => `${e.type}:${e.speechId}`).join(" | ") || "none";
  throw new Error(`Timed out waiting for actual browser playback completion after ${timeoutMs}ms; speech=${recentSpeech}; audioEvents=${recentEvents}`);
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
  const pieces = [];
  pieces.push(await silence(dir, 0, 0.8));
  let index = 1;
  for (const utterance of scenario.utterances || []) {
    pieces.push(await speechClip(dir, index++, utterance));
    pieces.push(await silence(dir, index++, 7.5));
  }
  const listPath = path.join(dir, "concat.txt");
  await fs.writeFile(listPath, pieces.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
  const output = path.join(dir, "mic.wav");
  ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-ac", "1", "-ar", "48000", output]);
  return output;
}

async function speechClip(dir, index, text) {
  const key = process.env.OPENAI_API_KEY || process.env.OPENAI_PLATFORM_API_KEY;
  if (!key) throw new Error("OpenAI API key is required to synthesize QA mic audio");
  const mp3 = path.join(dir, `${String(index).padStart(2, "0")}-speech.mp3`);
  const wav = path.join(dir, `${String(index).padStart(2, "0")}-speech.wav`);
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voice: process.env.OPENAI_TTS_VOICE || "alloy", input: text, response_format: "mp3", speed: 1.08 }),
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

function latestAssistant(data) {
  return [...(data.state.conversation || [])].reverse().find((entry) => entry.role === "assistant")?.content || "";
}

function conversationText(data) {
  return (data.state.conversation || []).map((entry) => entry.content || "").join("\n");
}

function ok(condition, message) {
  return { ok: Boolean(condition), message };
}

function exactScenarioSelection() {
  const scenarioIndex = process.argv.indexOf("--scenario");
  const fromSplitArg = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=").slice(1).join("=");
  const fromSeparateArg = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : "";
  if (scenarioIndex >= 0 && (!fromSeparateArg || fromSeparateArg.startsWith("--"))) {
    throw new Error("Missing value for --scenario. Pass one exact scenario name.");
  }
  const fromArg = fromSplitArg || fromSeparateArg;
  const name = (process.env.QA_SCENARIO || fromArg || "").trim();
  if (!name) throw new Error("Refusing to run the full QA suite. Pass one exact scenario with --scenario <name> or QA_SCENARIO=<name>.");
  if (/^(all|full|suite|\*)$/i.test(name) || name.includes(",")) {
    throw new Error(`Refusing broad QA scenario selection "${name}". Pass exactly one scenario name.`);
  }
  return name;
}

function playedSpeechUnits(data) {
  const speech = data.state?.speech || [];
  return speech.filter((s) => PLAYED_STATUSES.has(s.status) && hasPlaybackStart(data, s.id) && hasPlaybackEnd(data, s.id));
}

function hasPlaybackStart(data, speechId) {
  return Boolean(speechId) && (data.browserEvents || []).some((e) => e.type === "browser_audio_start" && e.speechId === speechId);
}

function hasPlaybackEnd(data, speechId) {
  return Boolean(speechId) && (data.browserEvents || []).some((e) => e.type === "browser_audio_end" && e.speechId === speechId);
}

function speechAfterCriticism(data) {
  const criticizedAt = (data.state?.conversation || []).find((entry) => /Why did you suck so much/i.test(entry.content || ""))?.at;
  const speech = data.state?.speech || [];
  if (!criticizedAt) return speech;
  const cutoff = new Date(criticizedAt).getTime();
  if (!Number.isFinite(cutoff)) return speech;
  return speech.filter((s) => !s.createdAt || new Date(s.createdAt).getTime() >= cutoff);
}

function checkCriticismAnswered(data) {
  const afterCriticismIds = new Set(speechAfterCriticism(data).map((s) => s.id).filter(Boolean));
  const played = playedSpeechUnits(data)
    .filter((s) => afterCriticismIds.has(s.id))
    .map((s) => s.text || "")
    .filter(Boolean);
  if (!played.length) return ok(false, "criticism received no completed played speech");
  const combined = played.join("\n");
  const answered = CRITICISM_ACK.test(combined) && CRITICISM_FIX.test(combined) && !BANNED_GAME_INVITATION.test(combined);
  return ok(answered, `played speech positively answered criticism: ${JSON.stringify(combined)}`);
}

function checkUnicodeRetained(data) {
  const convo = conversationText(data);
  const durable = [
    ...(data.state?.durableMemory?.facts || []),
    ...(data.state?.durableMemory?.corrections || []),
    ...(data.state?.durableMemory?.constraints || []),
    ...(data.state?.durableMemory?.uncertainties || []),
  ].map((m) => m.text || "").join("\n");
  const missingConversation = unicodeInputs.filter((input) => !convo.includes(input));
  const missingDurable = unicodeInputs.filter((input) => !durable.includes(input));
  return ok(!missingConversation.length && !missingDurable.length, `exact non-Latin inputs retained; missingConversation=${missingConversation.join(",") || "none"} missingDurable=${missingDurable.join(",") || "none"}`);
}

function checkUnicodePlayedResponse(data) {
  const playedUnits = playedSpeechUnits(data);
  const played = playedUnits.map((s) => s.text || "").filter(Boolean);
  if (!played.length) return ok(false, "Unicode turn received no completed played speech");
  const combined = played.join("\n");
  const positiveOne = playedUnits.filter((s) => s.inputVersion === 1).map((s) => s.text || "").join("\n");
  const positiveTwo = playedUnits.filter((s) => s.inputVersion === 2).map((s) => s.text || "").join("\n");
  const negativeSpeech = playedUnits.filter((s) => s.inputVersion >= 3).map((s) => s.text || "").join("\n");
  const positivesOk = positiveOne.includes(unicodeInputs[0]) && positiveTwo.includes(unicodeInputs[1]) && /\b(answer(?:ed|ing)?|got it|noted|keep|gave|acknowledged)\b/i.test(`${positiveOne}\n${positiveTwo}`);
  const declaredAnswer = /\b(?:is|was|as|that'?s|your|the)\s+(?:the\s+)?answer\b|\banswer\s+(?:you\s+)?gave\b/i;
  const negatedAnswer = /\bnot\s+(?:an?\s+|the\s+)?answer\b|\bnot\s+(?:an?\s+)?answer\s+(?:you\s+)?gave\b|\bwithout\s+giving\s+it\s+as\s+an?\s+answer\b/i;
  const negativesOk = negativeSpeech && (!declaredAnswer.test(negativeSpeech) || negatedAnswer.test(negativeSpeech));
  return ok(positivesOk && negativesOk, `played Unicode speech positives=${JSON.stringify([positiveOne, positiveTwo])} negatives=${JSON.stringify(negativeSpeech)} all=${JSON.stringify(combined)}`);
}

function checkWebEvidenceUsedInPlayedSpeech(data) {
  const evidence = data.state?.evidence || [];
  const webEvidenceById = new Map(evidence.filter((e) => e.source === "web" && e.sourceUrl).map((e) => [e.id, e]));
  const played = playedSpeechUnits(data);
  if (!played.length) return ok(false, "no completed played speech");
  for (const unit of played) {
    const webRefs = (unit.evidenceIds || []).map((id) => webEvidenceById.get(id)).filter(Boolean);
    if (!webRefs.length) continue;
    const match = webRefs.map((ev) => webFactMatch(unit.text || "", ev)).find((item) => item.ok);
    if (match) {
      return ok(true, `played speech ${unit.id} used web source ${match.sourceUrl} with quote ${JSON.stringify(match.quote)}`);
    }
  }
  const playedSummary = played.map((s) => `${s.id}:${s.text}`).join(" | ");
  return ok(false, `no completed played speech linked a specific retrieved web fact/source; played=${JSON.stringify(playedSummary)}`);
}

function webFactMatch(text, evidence) {
  const speech = normalizeComparable(text);
  if (!speech) return { ok: false };
  const sourceUrl = evidence.sourceUrl || "";
  const sourceName = sourceNameFromUrl(sourceUrl);
  const sourceMentioned = sourceName && speech.includes(normalizeComparable(sourceName));
  const numericFacts = [...String(evidence.content || "").matchAll(/\b(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?%?|\d{4})\b/g)]
    .map((m) => ({ value: m[0], quote: surroundingQuote(evidence.content || "", m.index || 0) }))
    .filter((item) => normalizeComparable(item.value).length > 0);
  for (const fact of numericFacts) {
    if (speech.includes(normalizeComparable(fact.value)) && (sourceMentioned || exactPhraseOverlap(speech, fact.quote))) {
      return { ok: true, sourceUrl, quote: fact.quote };
    }
  }
  for (const quote of meaningfulQuotes(evidence.content || "")) {
    if (exactPhraseOverlap(speech, quote) && sourceMentioned) return { ok: true, sourceUrl, quote };
  }
  return { ok: false };
}

function sourceNameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    return "";
  }
}

function surroundingQuote(text, index) {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + 100);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function meaningfulQuotes(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 40 && part.length <= 220)
    .slice(0, 8);
}

function exactPhraseOverlap(speech, quote) {
  const quoteTerms = terms(quote).filter((term) => term.length > 2);
  if (quoteTerms.length < 4) return false;
  for (let i = 0; i <= quoteTerms.length - 4; i += 1) {
    if (speech.includes(quoteTerms.slice(i, i + 4).join(" "))) return true;
  }
  return false;
}

function normalizeComparable(value) {
  return String(value || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}%]+/gu, " ").replace(/\s+/g, " ").trim();
}

function terms(value) {
  return normalizeComparable(value).split(" ").filter(Boolean);
}

function summarizeLatency(results) {
  const values = results
    .flatMap((r) => r.latencySamples || [])
    .map((s) => s.acousticEndToPlaybackMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.at(-1) ?? null,
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
}

function renderSummary(summary) {
  return `# Quality v2 browser QA

Run: ${summary.runDir}
Passed: ${summary.passed}/${summary.total}

${summary.results.map((r) => `## ${r.name}
- Verdict: ${r.ok ? "PASS" : "FAIL"}
- Screenshot: ${r.screenshot || "none"}
- Raw: ${r.raw || "none"}
- Checks: ${(r.checks || []).map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.message}`).join("; ") || r.error}
`).join("\n")}
`;
}

async function heartbeat(message) {
  await fs.appendFile(path.join(TASK_ROOT, "progress.log"), `${new Date().toISOString()} ${message}\n`);
  await fs.writeFile(path.join(TASK_ROOT, "LEG_HB"), new Date().toISOString());
}
