import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const baseUrl = process.env.QA_URL || "http://127.0.0.1:4793";
const artifacts = path.resolve(process.cwd(), "artifacts/qa");
const fakeAudio = path.resolve(artifacts, "fake-mic-annual.wav");
const fakeAudioDurationMs = Math.round(Number(execFileSync("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1",
  fakeAudio,
], { encoding: "utf8" }).trim()) * 1000);
fs.mkdirSync(artifacts, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${fakeAudio}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  recordVideo: { dir: artifacts, size: { width: 1440, height: 950 } },
});
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const consoleLines = [];
page.on("console", (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));
page.on("pageerror", (err) => consoleLines.push(`pageerror: ${err.message}`));

const results = [];
const assertions = [];

await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await refreshRag();
results.push({ scenario: "initial desktop", screenshot: await shot("01-initial-desktop") });
await page.setViewportSize({ width: 390, height: 900 });
results.push({ scenario: "initial mobile no control overflow", screenshot: await shot("01b-initial-mobile") });
await page.setViewportSize({ width: 1440, height: 950 });

await scenario("direct simple question", async () => {
  await askTyped("What is two plus two?");
  await waitForTimeline(/Audio playback confirmed|Browser started actual playback/, 60_000);
  const data = await qaData();
  assert(!data.state.jobs.length, "simple question should not start retrieval");
  assert(data.state.speech.some((s) => /four|4/i.test(s.text) && ["playing", "played", "audio_generated"].includes(s.status)), "simple answer should resolve two plus two");
  results.push({ scenario: "direct simple answer", screenshot: await shot("02-direct-simple") });
});

await scenario("typed local rag answer", async () => {
  await askTyped("I run a B2B onboarding product. Should we push annual pricing harder if we want paid conversion without increasing support load?");
  await waitForTimeline(/local_rag search completed/, 60_000);
  await waitForTimeline(/Audio playback confirmed|Browser started actual playback|Audio generated/, 90_000);
  const data = await qaData();
  assert(data.state.jobs.some((j) => j.source === "local_rag" && j.cause?.modelMode === "respond"), "local RAG job must be caused by communicator response");
  assert(data.state.evidence.some((e) => e.source === "local_rag" && e.fileName), "local RAG evidence should include file/chunk citation");
  assert(data.state.speech.some((s) => (s.evidenceIds || []).length > 0 && String(s.text || "").length > 40), "answer should use business evidence");
  results.push({ scenario: "typed local RAG with citations", screenshot: await shot("03-typed-rag") });
});

await scenario("voice early model-selected RAG", async () => {
  await page.click("text=Live scheduling");
  const voiceStartWall = Date.now();
  await page.click("text=Start mic");
  await waitForTimelineAfter(/Realtime transcript delta/, voiceStartWall, 45_000);
  await waitForTimelineAfter(/Communicator plan completed/, voiceStartWall, 60_000);
  await waitForTimelineAfter(/local_rag search scheduled|local_rag search running|local_rag search completed/, voiceStartWall, 80_000);
  const duringVoice = await qaData();
  const asc = sortAsc(duringVoice.timeline);
  const firstRag = asc.find((e) => /local_rag search (scheduled|running|completed)/i.test(e.label) && wall(e) >= voiceStartWall);
  assert(firstRag && wall(firstRag) < voiceStartWall + fakeAudioDurationMs, "local RAG must start before fake speech audio ends");
  assert(duringVoice.state.jobs.some((j) => j.source === "local_rag" && j.cause?.modelMode === "plan"), "early RAG must be caused by communicator plan decision");
  results.push({ scenario: "voice early RAG before waveform end", screenshot: await shot("05-voice-early") });
  await page.click("text=Stop session");
});

await scenario("public web opt-in", async () => {
  await page.check("#webToggle");
  await askTyped("Use public web evidence: what OpenAI API tool parameter controls live internet access for web search?");
  await waitForTimeline(/web search completed|web search failed/, 120_000);
  const data = await qaData();
  const webJob = data.state.jobs.find((j) => j.source === "web");
  assert(webJob, "model should schedule web search with web opt-in on");
  assert(webJob.status === "done", `web search should complete, got ${webJob.status}`);
  assert(data.state.evidence.some((e) => e.source === "web" && e.sourceUrl), "web evidence should include source URL");
  results.push({ scenario: "public web search with source URLs", screenshot: await shot("04-web") });
});

await scenario("correction excludes stale recommendation", async () => {
  await askTyped("Should I push annual pricing harder?");
  await waitForTimeline(/local_rag search completed/, 60_000);
  await askTyped("Actually make it about enterprise security blockers instead.");
  await waitForTimeline(/local_rag search completed/, 60_000);
  const data = await qaData();
  assert(data.state.evidence.some((e) => e.state === "stale"), "old evidence should become stale after correction");
  assert(data.state.evidence.some((e) => /enterprise|security/i.test(`${e.title} ${e.content}`)), "new topic evidence should be enterprise/security");
  results.push({ scenario: "corrected topic retires stale evidence", screenshot: await shot("06-correction") });
});

await scenario("speech interruption by detected user speech", async () => {
  await askTyped("Should we push annual pricing harder? Give a spoken recommendation that also weighs retention and enterprise security risks.");
  await waitForTimeline(/Browser started actual playback/, 120_000);
  await page.click("text=Start mic");
  await waitForTimeline(/Playback stopped and generation epoch advanced|browser_barge_in_stop/, 20_000);
  await page.waitForTimeout(600);
  await page.click("text=Stop session");
  const data = await qaData();
  const browserBarge = data.browserEvents.some((event) => event.type === "browser_barge_in_stop");
  assert(browserBarge, "fake mic speech should be detected as barge-in while audio is active");
  assert(data.state.speech.some((s) => s.status === "cancelled" || s.status === "playing" || s.status === "played"), "speech ledger should reflect interruption/playback state");
  results.push({ scenario: "voice barge-in stops playback", screenshot: await shot("07-barge-in") });
});

const finalData = await qaData();
await context.tracing.stop({ path: path.join(artifacts, "trace.zip") });
await browser.close();

const failed = assertions.filter((a) => !a.ok);
const output = {
  baseUrl,
  fakeAudio,
  fakeAudioDurationMs,
  results,
  assertions,
  consoleLines,
  consoleErrors: consoleLines.filter((line) => /error|fail|exception/i.test(line) && !/favicon/i.test(line)),
  finalState: sanitizeState(finalData.state),
  timeline: finalData.timeline,
  browserEvents: finalData.browserEvents,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(artifacts, "scenario-results.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ artifacts, assertions, consoleErrors: output.consoleErrors }, null, 2));
if (failed.length) throw new Error(`Scenario assertions failed: ${failed.map((a) => a.message).join("; ")}`);
if (output.consoleErrors.length) throw new Error(`Console errors: ${output.consoleErrors.join("; ")}`);

async function scenario(name, fn) {
  await page.evaluate(() => fetch("/api/stop", { method: "POST" })).catch(() => {});
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => fetch("/api/reset", { method: "POST" }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(250);
  try {
    await fn();
  } catch (error) {
    assertions.push({ ok: false, scenario: name, message: error.message });
    results.push({ scenario: `${name} FAILED`, screenshot: await shot(`failed-${slug(name)}`) });
  }
}

async function refreshRag() {
  const resp = await page.evaluate(async () => {
    const res = await fetch("/api/rag/refresh", { method: "POST" });
    return res.json();
  });
  assert(resp.ok, `RAG refresh should succeed: ${JSON.stringify(resp)}`);
}

function assert(condition, message) {
  assertions.push({ ok: Boolean(condition), message });
  if (!condition) throw new Error(message);
}

async function shot(name) {
  const file = path.join(artifacts, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function waitForTimeline(pattern, timeout = 30_000) {
  await page.waitForFunction(
    (source) => window.__liveVoiceQa?.timeline?.some((event) => new RegExp(source, "i").test(`${event.type} ${event.label}`)) ||
      window.__liveVoiceQa?.browserEvents?.some((event) => new RegExp(source, "i").test(event.type)),
    pattern.source,
    { timeout },
  );
}

async function waitForTimelineAfter(pattern, afterMs, timeout = 30_000) {
  await page.waitForFunction(
    ({ source, afterIso }) => window.__liveVoiceQa?.timeline?.some((event) => (
      new Date(event.at) > new Date(afterIso) &&
      new RegExp(source, "i").test(`${event.type} ${event.label}`)
    )),
    { source: pattern.source, afterIso: new Date(afterMs).toISOString() },
    { timeout },
  );
}

async function askTyped(text) {
  await page.fill("#typedInput", text);
  await page.click("text=Send typed");
}

async function qaData() {
  return page.evaluate(() => ({
    timeline: window.__liveVoiceQa.timeline,
    browserEvents: window.__liveVoiceQa.browserEvents,
    state: window.__liveVoiceQa.getState(),
  }));
}

function sanitizeState(state) {
  return {
    ...state,
    speech: state.speech?.map(({ audioBase64, ...speech }) => ({
      ...speech,
      audioBytesApprox: audioBase64 ? Math.floor(audioBase64.length * 0.75) : 0,
    })),
  };
}

function sortAsc(events) {
  return [...events].sort((a, b) => new Date(a.at) - new Date(b.at));
}

function wall(event) {
  return event ? new Date(event.at).getTime() : null;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
