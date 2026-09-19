import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const baseUrl = process.env.QA_URL || "http://127.0.0.1:4793";
const artifacts = path.resolve(process.cwd(), "artifacts/qa-focused");
const fakeAudio = path.resolve(process.cwd(), "artifacts/qa/fake-mic-annual.wav");
const fakeAudioDurationMs = Math.round(Number(execFileSync("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1",
  fakeAudio,
], { encoding: "utf8" }).trim()) * 1000);
fs.mkdirSync(artifacts, { recursive: true });

const assertions = [];
const results = [];

await call("/api/rag/refresh", { method: "POST" });
await runScenario("typed-local-rag", async ({ page, shot }) => {
  await askTyped(page, "I run a B2B onboarding product. Should we push annual pricing harder if we want paid conversion without increasing support load?");
  await wait(page, /local_rag search completed/, 90_000);
  await wait(page, /Browser started actual playback|Audio generated/, 120_000);
  await page.waitForFunction(() => window.__liveVoiceQa?.getState()?.speech?.some((s) => (s.evidenceIds || []).length > 0), null, { timeout: 20_000 });
  const data = await qaData(page);
  assert(data.state.jobs.some((j) => j.source === "local_rag" && j.cause?.modelMode === "respond"), "typed local RAG job is model-caused");
  assert(data.state.evidence.some((e) => e.source === "local_rag" && e.fileName), "typed local RAG has file citations");
  assert(data.state.speech.some((s) => (s.evidenceIds || []).length > 0), "typed answer carries local evidence IDs");
  results.push({ scenario: "typed local RAG", screenshot: await shot("typed-local-rag") });
});

await runScenario("web-search", async ({ page, shot }) => {
  await page.check("#webToggle");
  await askTyped(page, "Use public web evidence: what OpenAI API tool parameter controls live internet access for web search?");
  await wait(page, /web search completed|web search failed/, 140_000);
  const data = await qaData(page);
  const webJob = data.state.jobs.find((j) => j.source === "web");
  assert(webJob?.status === "done", `web search completes, got ${webJob?.status}`);
  assert(data.state.evidence.some((e) => e.source === "web" && e.sourceUrl), "web evidence has source URL");
  results.push({ scenario: "public web", screenshot: await shot("web-search") });
});

await runScenario("voice-early-rag", async ({ page, shot }) => {
  const voiceStartWall = Date.now();
  await page.click("text=Start mic");
  await waitAfter(page, /Realtime transcript delta/, voiceStartWall, 45_000);
  await waitAfter(page, /Communicator plan completed/, voiceStartWall, 60_000);
  await waitAfter(page, /local_rag search scheduled|local_rag search running|local_rag search completed/, voiceStartWall, 80_000);
  const data = await qaData(page);
  const firstRag = sortAsc(data.timeline).find((e) => /local_rag search (scheduled|running|completed)/i.test(e.label) && wall(e) >= voiceStartWall);
  assert(firstRag && wall(firstRag) < voiceStartWall + fakeAudioDurationMs, "voice local RAG starts before fake speech ends");
  assert(data.state.jobs.some((j) => j.source === "local_rag" && j.cause?.modelMode === "plan"), "voice local RAG is model-plan caused");
  results.push({ scenario: "voice early RAG", screenshot: await shot("voice-early-rag") });
  await page.click("text=Stop session");
});

await runScenario("barge-in", async ({ page, shot }) => {
  await askTyped(page, "Should we push annual pricing harder? Give a spoken recommendation that also weighs retention and enterprise security risks.");
  await wait(page, /Browser started actual playback/, 140_000);
  await page.click("text=Start mic");
  await wait(page, /Playback stopped and generation epoch advanced|browser_barge_in_stop/, 25_000);
  await page.click("text=Stop session");
  const data = await qaData(page);
  assert(data.browserEvents.some((e) => e.type === "browser_barge_in_stop"), "browser stopped audio on detected speech");
  assert(data.state.speech.some((s) => ["cancelled", "playing", "played"].includes(s.status)), "speech ledger records interrupted playback");
  results.push({ scenario: "speech barge-in", screenshot: await shot("barge-in") });
});

fs.writeFileSync(path.join(artifacts, "focused-results.json"), JSON.stringify({ assertions, results, generatedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ artifacts, assertions, results }, null, 2));
const failed = assertions.filter((a) => !a.ok);
if (failed.length) throw new Error(failed.map((a) => a.message).join("; "));

async function runScenario(name, fn) {
  await call("/api/stop", { method: "POST" }).catch(() => {});
  await call("/api/reset", { method: "POST" });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fakeAudio}`, "--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, recordVideo: { dir: artifacts, size: { width: 1440, height: 950 } } });
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await fn({ page, shot: async (label) => {
      const file = path.join(artifacts, `${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      return file;
    } });
  } catch (error) {
    assertions.push({ ok: false, scenario: name, message: error.message });
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

function assert(condition, message) {
  assertions.push({ ok: Boolean(condition), message });
  if (!condition) throw new Error(message);
}

async function askTyped(page, text) {
  await page.waitForFunction(() => window.__liveVoiceQa?.getState()?.sessionId, null, { timeout: 10_000 });
  await page.fill("#typedInput", text);
  await page.click("text=Send typed");
}

async function wait(page, pattern, timeout) {
  await page.waitForFunction(
    (source) => window.__liveVoiceQa?.timeline?.some((e) => new RegExp(source, "i").test(`${e.type} ${e.label}`)) ||
      window.__liveVoiceQa?.browserEvents?.some((e) => new RegExp(source, "i").test(e.type)),
    pattern.source,
    { timeout },
  );
}

async function waitAfter(page, pattern, afterMs, timeout) {
  await page.waitForFunction(
    ({ source, afterIso }) => window.__liveVoiceQa?.timeline?.some((e) => new Date(e.at) > new Date(afterIso) && new RegExp(source, "i").test(`${e.type} ${e.label}`)),
    { source: pattern.source, afterIso: new Date(afterMs).toISOString() },
    { timeout },
  );
}

async function qaData(page) {
  return page.evaluate(() => ({ timeline: window.__liveVoiceQa.timeline, browserEvents: window.__liveVoiceQa.browserEvents, state: window.__liveVoiceQa.getState() }));
}

async function call(route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, options);
  return res.json().catch(() => ({}));
}

function sortAsc(events) {
  return [...events].sort((a, b) => new Date(a.at) - new Date(b.at));
}

function wall(event) {
  return event ? new Date(event.at).getTime() : null;
}
