import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

const execFileAsync = promisify(execFile);
const baseUrl = process.env.QA_URL || "http://127.0.0.1:4793";
const artifacts = path.resolve(process.cwd(), "artifacts/recovery7-adaptive");
const audioDir = path.join(artifacts, "mic");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_PLATFORM_API_KEY });
const assertions = [];
const scenarios = [];
const benchmarkRows = [];
const consoleLines = [];

await fsp.mkdir(audioDir, { recursive: true });
await call("/api/rag/refresh", { method: "POST" });

const audio = {
  late: await makeMicWav("late-retention-public-benchmark-v3", [
    { text: "For retention planning answer local first from our customer interview notes on whether team templates or annual discounts should come first, and if public SaaS onboarding benchmarks add anything useful, bring that in after.", gapAfterSec: 120 },
  ]),
  clarifyResearch: await makeMicWav("clarify-while-research-v2", [
    { text: "Please search public SaaS pricing benchmarks in the background and check our local pricing notes, but I have not specified the goal for changing onboarding pricing yet.", gapAfterSec: 15 },
    { text: "The goal is higher paid conversion without increasing support tickets.", gapAfterSec: 44 },
  ]),
  correction: await makeMicWav("correction-security", [
    { text: "Actually stop and make the recommendation about enterprise security blockers instead.", gapAfterSec: 24 },
  ]),
  quietTerse: await makeMicWav("adaptive-quiet-terse-v2", [
    { text: "We sell onboarding software.", gapAfterSec: 18 },
    { text: "I don't know.", gapAfterSec: 18 },
    { text: "Paid conversion, I guess.", gapAfterSec: 32 },
  ]),
  skeptical: await makeMicWav("adaptive-skeptical", [
    { text: "What is this for?", gapAfterSec: 9 },
    { text: "Maybe. Keep it short.", gapAfterSec: 28 },
  ]),
  busy: await makeMicWav("adaptive-busy", [
    { text: "I'm busy. Give me the value in ten seconds.", gapAfterSec: 26 },
  ]),
  uncertain: await makeMicWav("adaptive-uncertain", [
    { text: "Can you help with onboarding?", gapAfterSec: 9 },
    { text: "Activation after signup.", gapAfterSec: 30 },
  ]),
  changeMind: await makeMicWav("adaptive-change-mind", [
    { text: "Let's talk pricing nudges.", gapAfterSec: 10 },
    { text: "Actually no, focus on enterprise security objections.", gapAfterSec: 30 },
  ]),
  engaged: await makeMicWav("adaptive-engaged", [
    { text: "We're a B2B onboarding SaaS and I want a sharper discovery pitch for teams stuck after signup.", gapAfterSec: 9 },
    { text: "Yes, focus on team templates and reducing confusion.", gapAfterSec: 36 },
  ]),
  refusal: await makeMicWav("adaptive-refusal", [
    { text: "Not interested. Please stop.", gapAfterSec: 18 },
  ]),
  silence: await makeSilenceWav("adaptive-silence", 12),
};

await runScenario("late-evidence-two-contributions", audio.late, async ({ page, shot, saveRaw }) => {
  await page.check("#webToggle");
  await page.click("text=Start mic");
  await wait(page, /Browser started actual playback/i, 170_000);
  await wait(page, /web search completed/i, 190_000);
  await page.waitForFunction(() => {
    const state = window.__liveVoiceQa?.getState();
    const evidence = state?.evidence || [];
    const ended = window.__liveVoiceQa?.browserEvents?.filter((e) => e.type === "browser_audio_end") || [];
    return state?.speech?.some((s) => s.status === "played" && s.kind === "answer" && (s.evidenceIds || []).some((id) => evidence.find((e) => e.id === id && e.source === "web"))) && ended.length >= 2;
  }, null, { timeout: 220_000 });
  const data = await qaData(page);
  const order = orderedLateEvidence(data);
  assert(order.ok, `late evidence behavior: ${order.reason}`);
  assert(noOverlappingPlayback(data), "late evidence has no overlapping browser playback");
  const raw = await saveRaw("late-evidence-two-contributions");
  scenarios.push({ name: "true late evidence continuation", screenshot: await shot("late-evidence-two-contributions"), rawJson: raw, order });
  await page.click("text=Stop session").catch(() => {});
});

await runScenario("clarification-during-active-research", audio.clarifyResearch, async ({ page, shot, saveRaw }) => {
  await page.check("#webToggle");
  await page.click("text=Start mic");
  await wait(page, /local_rag search (scheduled|running)/i, 90_000);
  await wait(page, /Browser started actual playback/i, 160_000);
  await page.waitForFunction(() => {
    const state = window.__liveVoiceQa?.getState();
    return state?.speech?.some((s) => s.kind === "clarification" && s.status === "played");
  }, null, { timeout: 190_000 });
  await page.waitForFunction(() => {
    const state = window.__liveVoiceQa?.getState();
    return state?.speech?.some((s) => s.kind === "answer" && s.status === "played" && /conversion|support|pricing|annual/i.test(s.text || ""));
  }, null, { timeout: 230_000 });
  const data = await qaData(page);
  const proof = clarificationWhileResearch(data);
  assert(proof.ok, `clarification while research active: ${proof.reason}`);
  assert(data.state.conversation.some((e) => e.role === "assistant" && /conversion|support/i.test(e.content || "")), "final answer integrates spoken clarification goal");
  assert(data.state.conversation.some((e) => e.role === "assistant" && /annual savings|savings.*earlier|monthly.*clarity|support.*guardrail|billing confusion/i.test(e.content || "")), "clarification answer faithfully uses pricing evidence semantics");
  const raw = await saveRaw("clarification-during-active-research");
  scenarios.push({ name: "clarification while research running", screenshot: await shot("clarification-during-active-research"), rawJson: raw, proof });
  await page.click("text=Stop session").catch(() => {});
});

const adaptiveScenarios = [
  {
    name: "quiet-terse-low-info",
    audio: audio.quietTerse,
    web: true,
    expect: /conversion|onboarding|goal|templates|annual|support/i,
    minAssistant: 2,
    check: (data) => {
      const assistant = assistantTexts(data);
      return assistant.length >= 2 &&
        assistant.every((text) => wordCount(text) <= 45) &&
	        assistant.some((text) => /conversion/i.test(text)) &&
        noRepeatedQuestions(assistant);
    },
  },
  {
    name: "skeptical-what-for",
    audio: audio.skeptical,
    expect: /short|onboarding|help|useful|check/i,
    check: (data) => assistantTexts(data).some((text) => /help|useful|onboarding|short/i.test(text)) && noRepeatedQuestions(assistantTexts(data)),
  },
  {
    name: "busy-concise-value",
    audio: audio.busy,
    expect: /short|conversion|support|onboarding|value/i,
    check: (data) => assistantTexts(data).some((text) => wordCount(text) <= 35 && /conversion|support|onboarding|value/i.test(text)),
  },
  {
    name: "uncertain-focused-choice",
    audio: audio.uncertain,
    expect: /activation|signup|onboarding|template|confusion/i,
    check: (data) => assistantTexts(data).some((text) => /activation|signup|template|confusion/i.test(text)) && noRepeatedQuestions(assistantTexts(data)),
  },
  {
    name: "change-of-mind-adapts",
    audio: audio.changeMind,
    expect: /enterprise|security|SSO|audit/i,
    check: (data) => assistantTexts(data).some((text) => /enterprise|security|SSO|audit/i.test(text)) && !assistantTexts(data).at(-1)?.match(/annual discount appeared too late/i),
  },
  {
    name: "engaged-positive-control",
    audio: audio.engaged,
    expect: /team templates|activation|confusion|signup/i,
    check: (data) => assistantTexts(data).some((text) => /team templates|activation|confusion|signup/i.test(text)) && assistantTexts(data).some((text) => wordCount(text) >= 15),
  },
  {
    name: "explicit-refusal-close",
    audio: audio.refusal,
    expect: /stop|no problem|understood|won't|leave/i,
    check: (data) => {
      const texts = assistantTexts(data);
      return texts.length <= 1 && texts.some((text) => /understood|stop|leave|no problem|won't/i.test(text));
    },
  },
  {
    name: "silence-one-checkin",
    audio: audio.silence,
    expect: /still there|leave|space|specific|goal|pause/i,
    check: (data) => {
      const texts = assistantTexts(data);
      return data.browserEvents.some((e) => e.type === "browser_silence_check") && texts.length <= 1 && texts.some((text) => /still there|leave|space|specific|goal|pause/i.test(text));
    },
  },
];

for (const scenario of adaptiveScenarios) {
  await runAdaptiveScenario(scenario);
}

await runScenario("interrupt-correction-still-working", audio.correction, async ({ page, shot, saveRaw }) => {
  await askTyped(page, "Give a spoken recommendation about pushing annual pricing harder. Keep it long enough that I can interrupt.");
  await wait(page, /Browser started actual playback/i, 130_000);
  await page.click("text=Start mic");
  await waitBrowser(page, "browser_barge_in_stop", 45_000);
  await wait(page, /Final transcript/i, 120_000);
  await page.waitForFunction(() => {
    const speech = window.__liveVoiceQa?.getState()?.speech || [];
    return speech.some((s) => /enterprise|security|SSO|audit/i.test(String(s.text || "")) && s.status === "played");
  }, null, { timeout: 190_000 });
  const data = await qaData(page);
  const stop = bargeInStopMetric(data, audio.correction.speech);
  assert(Number.isFinite(stop.bargeInStopMs) && stop.bargeInStopMs >= 0 && stop.bargeInStopMs < 1200, `barge-in detected speech to audio stop is ${stop.bargeInStopMs}ms`);
  assert(data.state.speech.some((s) => /enterprise|security|SSO|audit/i.test(String(s.text || "")) && s.status === "played"), "post-interrupt spoken answer addresses correction");
  const raw = await saveRaw("interrupt-correction-still-working");
  scenarios.push({ name: "voice correction/interrupt still working", screenshot: await shot("interrupt-correction-still-working"), rawJson: raw, stop });
  await page.click("text=Stop session").catch(() => {});
});

const benchInputs = [
  {
    name: "local-pricing",
    audio: await makeMicWav("bench-local-pricing", [
      { text: "For our onboarding product, should we push annual pricing harder if the goal is paid conversion without raising support load?", gapAfterSec: 34 },
    ]),
    prompt: "For our onboarding product, should we push annual pricing harder if the goal is paid conversion without raising support load?",
    wantsWeb: false,
    content: /annual|pricing|conversion|support/i,
  },
  {
	    name: "retention-public",
	    audio: audio.late,
	    prompt: "For retention planning answer local first from our customer interview notes on whether team templates or annual discounts should come first, and if public SaaS onboarding benchmarks add anything useful, bring that in after.",
    wantsWeb: true,
    content: /retention|template|discount|onboarding/i,
  },
  {
    name: "enterprise-security",
    audio: await makeMicWav("bench-enterprise-security", [
      { text: "Based on our local enterprise notes, what should I fix before asking prospects for annual commitments?", gapAfterSec: 30 },
    ]),
    prompt: "Based on our local enterprise notes, what should I fix before asking prospects for annual commitments?",
    wantsWeb: false,
    content: /enterprise|security|SSO|audit|annual/i,
  },
];

for (let i = 0; i < benchInputs.length; i += 1) {
  const order = i % 2 === 0 ? ["live", "sequential"] : ["sequential", "live"];
  for (const mode of order) {
    const row = await benchmarkRun(benchInputs[i], mode, i === 0 ? "cold-or-first" : "warm");
    if (row) benchmarkRows.push(row);
  }
}

const output = {
  baseUrl,
  scenarios,
  benchmarkRows,
  medians: {
    liveSpeechEndToFirstUsefulAudioMs: median(benchmarkRows.filter((r) => r.mode === "live").map((r) => r.speechEndToFirstUsefulAudioMs).filter(Number.isFinite)),
    sequentialSpeechEndToFirstUsefulAudioMs: median(benchmarkRows.filter((r) => r.mode === "sequential").map((r) => r.speechEndToFirstUsefulAudioMs).filter(Number.isFinite)),
    liveTotalResolutionFromSpeechEndMs: median(benchmarkRows.filter((r) => r.mode === "live").map((r) => r.totalResolutionFromSpeechEndMs).filter(Number.isFinite)),
    sequentialTotalResolutionFromSpeechEndMs: median(benchmarkRows.filter((r) => r.mode === "sequential").map((r) => r.totalResolutionFromSpeechEndMs).filter(Number.isFinite)),
  },
  assertions,
  consoleLines,
  consoleErrors: consoleLines.filter((line) => /error|exception/i.test(line) && !/favicon|Audio playback was not started automatically/i.test(line)),
  generatedAt: new Date().toISOString(),
};
await fsp.writeFile(path.join(artifacts, "recovery7-results.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ artifacts, assertions, medians: output.medians, consoleErrors: output.consoleErrors }, null, 2));
const failed = assertions.filter((a) => !a.ok);
if (failed.length) throw new Error(failed.map((a) => a.message).join("; "));
if (output.consoleErrors.length) throw new Error(output.consoleErrors.join("; "));

async function benchmarkRun(input, mode, cacheLabel) {
  let captured = null;
  await runScenario(`bench-${mode}-${input.name}`, input.audio, async ({ page, shot, saveRaw }) => {
    if (mode === "sequential") await page.click("text=Sequential baseline");
    else await page.click("text=Live scheduling");
    if (input.wantsWeb) await page.check("#webToggle");
    await page.click("text=Start mic");
    await page.waitForFunction((source) => {
      const qa = window.__liveVoiceQa;
      const state = qa?.getState();
      const pending = state?.jobs?.some((j) => ["scheduled", "running"].includes(j.status));
      const played = state?.speech?.some((s) => s.status === "played" && new RegExp(source, "i").test(s.text || ""));
      const refs = state?.speech?.some((s) => s.status === "played" && (s.evidenceIds || []).length > 0);
      const needsWeb = state?.jobs?.some((j) => j.source === "web");
      const hasWebSpeech = state?.speech?.some((s) => s.status === "played" && (s.evidenceIds || []).some((id) => state?.evidence?.find((e) => e.id === id && e.source === "web")));
      const ended = qa?.browserEvents?.some((e) => e.type === "browser_audio_end");
      return played && refs && ended && !pending && (!needsWeb || hasWebSpeech);
    }, input.content.source, { timeout: 230_000 });
    const data = await qaData(page);
    const metrics = deriveMetrics(data, input.audio.speech, input.content);
    assert(Number.isFinite(metrics.speechEndToFirstUsefulAudioMs), `${mode}/${input.name} has actual browser first useful playback`);
    assert(Number.isFinite(metrics.totalResolutionFromSpeechEndMs), `${mode}/${input.name} has final playback-ended total resolution`);
    const raw = await saveRaw(`bench-${mode}-${input.name}`);
    captured = { input: input.name, mode, cacheLabel, prompt: input.prompt, ...metrics, screenshot: await shot(`bench-${mode}-${input.name}`), rawJson: raw, speech: input.audio.speech };
    await page.click("text=Stop session").catch(() => {});
  });
  return captured;
}

async function runAdaptiveScenario(scenario) {
  await runScenario(`adaptive-${scenario.name}`, scenario.audio, async ({ page, shot, saveRaw }) => {
    if (scenario.web) await page.check("#webToggle");
    await page.click("text=Start mic");
    await page.waitForFunction(({ source, minAssistant }) => {
      const state = window.__liveVoiceQa?.getState();
      const speech = state?.speech || [];
      const played = speech.filter((s) => s.status === "played");
      return played.length >= minAssistant && played.some((s) => new RegExp(source, "i").test(s.text || ""));
    }, { source: scenario.expect.source, minAssistant: scenario.minAssistant || 1 }, { timeout: 240_000 });
    const data = await qaData(page);
    assert(scenario.check(data), `adaptive behavior passed: ${scenario.name}`);
    const raw = await saveRaw(`adaptive-${scenario.name}`);
    scenarios.push({ name: `adaptive ${scenario.name}`, screenshot: await shot(`adaptive-${scenario.name}`), rawJson: raw, assistantTexts: assistantTexts(data) });
    await page.click("text=Stop session").catch(() => {});
  });
}

async function runScenario(name, micAudio, fn) {
  await call("/api/stop", { method: "POST" }).catch(() => {});
  await call("/api/reset", { method: "POST" });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${micAudio.path}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, recordVideo: { dir: artifacts, size: { width: 1440, height: 950 } } });
  const page = await context.newPage();
  page.on("console", (msg) => consoleLines.push(`${name}: ${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => consoleLines.push(`${name}: pageerror: ${err.message}`));
  async function saveRaw(label) {
    const file = path.join(artifacts, `${label}.raw.json`);
    const data = await qaData(page);
    await fsp.writeFile(file, JSON.stringify({ scenario: name, capturedAt: new Date().toISOString(), speech: micAudio.speech, ...data }, null, 2));
    return file;
  }
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await fn({ page, speech: micAudio.speech, saveRaw, shot: async (label) => {
      const file = path.join(artifacts, `${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      return file;
    } });
  } catch (error) {
    assertions.push({ ok: false, scenario: name, message: error.message });
    await saveRaw(`failed-${slug(name)}`).catch(() => {});
    const file = path.join(artifacts, `failed-${slug(name)}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function makeMicWav(name, utterances) {
  const out = path.join(audioDir, `${name}.wav`);
  const metaPath = path.join(audioDir, `${name}.json`);
  if (fs.existsSync(out) && fs.existsSync(metaPath)) {
    return { path: out, speech: JSON.parse(await fsp.readFile(metaPath, "utf8")) };
  }
  const inputs = [];
  const filterParts = [];
  const concatRefs = [];
  let inputIndex = 0;
  for (let i = 0; i < utterances.length; i += 1) {
    const mp3 = path.join(audioDir, `${name}-${i + 1}.mp3`);
    const response = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: "alloy",
      input: utterances[i].text,
      response_format: "mp3",
    });
    await fsp.writeFile(mp3, Buffer.from(await response.arrayBuffer()));
    inputs.push("-i", mp3);
    filterParts.push(`[${inputIndex}:a]aformat=sample_rates=24000:channel_layouts=mono[s${i}]`);
    inputIndex += 1;
    concatRefs.push(`[s${i}]`);
    const gap = Number(utterances[i].gapAfterSec || 0);
    if (gap > 0) {
      inputs.push("-f", "lavfi", "-t", String(gap), "-i", "anullsrc=r=24000:cl=mono");
      filterParts.push(`[${inputIndex}:a]aformat=sample_rates=24000:channel_layouts=mono[g${i}]`);
      inputIndex += 1;
      concatRefs.push(`[g${i}]`);
    }
  }
  const filter = `${filterParts.join(";")};${concatRefs.join("")}concat=n=${concatRefs.length}:v=0:a=1[out]`;
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-ac", "1", "-ar", "24000", "-acodec", "pcm_s16le", out]);
  const speech = analyzeWavSpeech(out);
  speech.utterances = utterances.map((u) => u.text);
  await fsp.writeFile(metaPath, JSON.stringify(speech, null, 2));
  return { path: out, speech };
}

async function makeSilenceWav(name, seconds) {
  const out = path.join(audioDir, `${name}.wav`);
  const metaPath = path.join(audioDir, `${name}.json`);
  if (!fs.existsSync(out)) {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=r=24000:cl=mono", "-ac", "1", "-ar", "24000", "-acodec", "pcm_s16le", out]);
  }
  const speech = analyzeWavSpeech(out);
  speech.utterances = ["[silence]"];
  await fsp.writeFile(metaPath, JSON.stringify(speech, null, 2));
  return { path: out, speech };
}

function analyzeWavSpeech(filePath) {
  const buf = fs.readFileSync(filePath);
  const sampleRate = buf.readUInt32LE(24);
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 < buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error(`No WAV data chunk in ${filePath}`);
  const samples = dataSize / 2;
  const windowSamples = Math.max(1, Math.floor(sampleRate * 0.05));
  const voiced = [];
  for (let start = 0; start < samples; start += windowSamples) {
    let sum = 0;
    let count = 0;
    for (let i = start; i < Math.min(samples, start + windowSamples); i += 1) {
      const s = buf.readInt16LE(dataOffset + i * 2);
      sum += s * s;
      count += 1;
    }
    const rms = Math.sqrt(sum / Math.max(1, count));
    if (rms > 350) voiced.push({ startMs: (start / sampleRate) * 1000, endMs: (Math.min(samples, start + windowSamples) / sampleRate) * 1000, rms });
  }
  const durationMs = (samples / sampleRate) * 1000;
  return {
    file: filePath,
    sampleRate,
    durationMs: Math.round(durationMs),
    speechStartMs: voiced.length ? Math.round(voiced[0].startMs) : null,
    speechEndMs: voiced.length ? Math.round(voiced.at(-1).endMs) : null,
    voicedWindows: voiced.length,
  };
}

function deriveMetrics(data, speech, contentPattern) {
  const asc = [...data.timeline].sort((a, b) => a.monoMs - b.monoMs);
  const micStart = data.browserEvents.find((e) => e.type === "browser_mic_pcm_start");
  const speechEndBrowserWallMs = micStart?.wallMs && Number.isFinite(speech.speechEndMs) ? micStart.wallMs + speech.speechEndMs : null;
  const usefulSpeechIds = new Set((data.state.speech || [])
    .filter((s) => s.kind === "answer" && (s.evidenceIds || []).length > 0 && contentPattern.test(s.text || ""))
    .map((s) => s.id));
  const starts = data.browserEvents.filter((e) => e.type === "browser_audio_start" && usefulSpeechIds.has(e.speechId)).sort((a, b) => a.wallMs - b.wallMs);
  const ends = data.browserEvents.filter((e) => e.type === "browser_audio_end" && usefulSpeechIds.has(e.speechId)).sort((a, b) => a.wallMs - b.wallMs);
  const lastUsefulEnd = ends.at(-1);
  const finalTranscript = asc.find((e) => /Final transcript/i.test(e.label));
  const realtimeFinal = [...asc].reverse().find((e) => /Realtime transcription finalized/i.test(e.label));
  const firstRag = asc.find((e) => /local_rag search scheduled/i.test(e.label));
  const firstWeb = asc.find((e) => /web search scheduled/i.test(e.label));
  return {
    speechEndMs: speech.speechEndMs,
    speechEndBrowserWallMs,
    sttSpeechEndToTranscriptFinalMs: speechEndBrowserWallMs && realtimeFinal ? Math.round(new Date(realtimeFinal.at).getTime() - speechEndBrowserWallMs) : null,
    firstUsefulPlaybackSpeechId: starts[0]?.speechId || null,
    speechEndToFirstUsefulAudioMs: speechEndBrowserWallMs && starts[0] ? Math.round(starts[0].wallMs - speechEndBrowserWallMs) : null,
    startToFirstUsefulAudioMs: micStart && starts[0] ? Math.round(starts[0].wallMs - micStart.wallMs) : null,
    totalResolutionFromSpeechEndMs: speechEndBrowserWallMs && lastUsefulEnd ? Math.round(lastUsefulEnd.wallMs - speechEndBrowserWallMs) : null,
    taskResolvedSpeechId: lastUsefulEnd?.speechId || null,
    earlyRagLeadMs: firstRag && speechEndBrowserWallMs ? Math.round(speechEndBrowserWallMs - new Date(firstRag.at).getTime()) : null,
    earlyWebLeadMs: firstWeb && speechEndBrowserWallMs ? Math.round(speechEndBrowserWallMs - new Date(firstWeb.at).getTime()) : null,
    finalTranscriptToFirstUsefulAudioMs: finalTranscript && starts[0] ? Math.round(starts[0].wallMs - new Date(finalTranscript.at).getTime()) : null,
    ragDurationsMs: data.state.jobs.filter((j) => j.source === "local_rag").map((j) => Math.round(j.durationMs || 0)).filter(Boolean),
    webDurationsMs: data.state.jobs.filter((j) => j.source === "web").map((j) => Math.round(j.durationMs || 0)).filter(Boolean),
    modelDurationsMs: asc.filter((e) => /Communicator .* completed/i.test(e.label)).map((e) => e.data?.elapsedMs).filter(Number.isFinite),
    ttsDurationsMs: data.state.speech.map((s) => s.ttsElapsedMs).filter(Number.isFinite),
    speculativeJobs: data.state.metrics?.speculativeJobs ?? 0,
    wastedJobs: data.state.metrics?.wastedJobs ?? 0,
    jobs: data.state.jobs.map(({ id, source, query, status, required, cause, durationMs, startedAt, completedAt }) => ({ id, source, query, status, required, cause, durationMs, startedAt, completedAt })),
  };
}

function orderedLateEvidence(data) {
  const jobs = data.state.jobs || [];
  const evidence = data.state.evidence || [];
  const speech = (data.state.speech || []).filter((s) => s.kind === "answer" && s.status === "played");
  const starts = data.browserEvents.filter((e) => e.type === "browser_audio_start");
  const webJob = jobs.find((j) => j.source === "web" && j.status === "done");
  const ragJob = jobs.find((j) => j.source === "local_rag" && j.status === "done");
  if (!webJob || !ragJob) return { ok: false, reason: "missing completed web or local job" };
  if (speech.length < 2) return { ok: false, reason: `only ${speech.length} played answer contribution(s)` };
  const first = speech[0];
  const second = speech.find((s) => s.id !== first.id && (s.evidenceIds || []).some((id) => evidence.find((e) => e.id === id && e.source === "web")));
  if (!second) return { ok: false, reason: "no later played contribution cites web evidence" };
  const firstStart = starts.find((e) => e.speechId === first.id);
  const webCompleted = new Date(webJob.completedAt).getTime();
  if (!firstStart || !(firstStart.wallMs < webCompleted)) return { ok: false, reason: "first audible contribution did not start before web completed" };
  const firstUsesLocal = (first.evidenceIds || []).some((id) => evidence.find((e) => e.id === id && e.source === "local_rag"));
  const firstUsesWeb = (first.evidenceIds || []).some((id) => evidence.find((e) => e.id === id && e.source === "web"));
  if (!firstUsesLocal || firstUsesWeb) return { ok: false, reason: "first contribution was not local-only grounded evidence" };
  const useful = usefulWebContribution(second.text || "", evidence.filter((e) => (second.evidenceIds || []).includes(e.id)));
  if (!useful.ok) return { ok: false, reason: useful.reason };
  return { ok: true, reason: "local answer played before web completion; later played answer cites useful web evidence", firstSpeechId: first.id, secondSpeechId: second.id, webJobId: webJob.id, ragJobId: ragJob.id };
}

function clarificationWhileResearch(data) {
  const clarification = (data.state.speech || []).find((s) => s.kind === "clarification" && s.status === "played");
  if (!clarification) return { ok: false, reason: "no played clarification" };
  const start = data.browserEvents.find((e) => e.type === "browser_audio_start" && e.speechId === clarification.id);
  const end = data.browserEvents.find((e) => e.type === "browser_audio_end" && e.speechId === clarification.id);
  if (!start) return { ok: false, reason: "clarification has no browser playback start" };
  if (!end) return { ok: false, reason: "clarification has no browser playback end" };
  const activeJob = (data.state.jobs || []).find((j) => {
    const s = new Date(j.startedAt).getTime();
    const e = j.completedAt ? new Date(j.completedAt).getTime() : Infinity;
    return s <= end.wallMs + 100 && e + 100 >= start.wallMs;
  });
  if (!activeJob) return { ok: false, reason: "no research job active during clarification playback" };
  return { ok: true, reason: "clarification played while research job was still active", clarificationSpeechId: clarification.id, activeJobId: activeJob.id };
}

function bargeInStopMetric(data) {
  const stop = data.browserEvents.find((e) => e.type === "browser_barge_in_stop");
  const speechStart = data.browserEvents.find((e) => e.type === "browser_speech_started" && (!stop || e.wallMs <= stop.wallMs));
  return { bargeInStopMs: stop && speechStart ? Math.round(stop.wallMs - speechStart.wallMs) : null, stop, speechStart };
}

function noOverlappingPlayback(data) {
  const intervals = [];
  for (const start of data.browserEvents.filter((e) => e.type === "browser_audio_start")) {
    const end = data.browserEvents.find((e) => e.type === "browser_audio_end" && e.speechId === start.speechId && e.wallMs >= start.wallMs);
    if (end) intervals.push({ start: start.wallMs, end: end.wallMs, speechId: start.speechId });
  }
  return intervals.every((a, i) => intervals.every((b, j) => i === j || a.end <= b.start || b.end <= a.start));
}

function usefulWebContribution(text, webEvidence = []) {
	  if (/\bev_[a-z0-9]+|\bjob_[a-z0-9]+|\.md\b|chunk|https?:\/\/|www\.|\.com|\.ai|\.io|\.in\b/i.test(text)) return { ok: false, reason: "web contribution reads internal IDs, URLs, filenames, or domains aloud" };
	  const words = terms(text);
  if (words.length < 10) return { ok: false, reason: "web contribution is too thin to be useful" };
  const hasFact = /\d|percent|survey|report|benchmark|respondents|companies|median|average|data|study|found|shows|according/i.test(text);
  const hasImpact = /reinforc|support|change|refine|adjust|so |therefore|means|because|doesn't change|does not change|no public evidence|still/i.test(text);
  if (!hasFact) return { ok: false, reason: "web contribution lacks an actual public fact" };
  if (!hasImpact) return { ok: false, reason: "web contribution does not explain recommendation impact" };
  const evidenceTerms = new Set(webEvidence.flatMap((ev) => terms(`${ev.title || ""} ${ev.content || ""}`)));
  const overlap = words.filter((term) => evidenceTerms.has(term)).length;
  if (webEvidence.length && overlap < 4) return { ok: false, reason: "web contribution does not semantically match retrieved web evidence" };
  if (/no public evidence|did not retrieve|couldn't find|could not find/i.test(text) && webEvidence.some((ev) => terms(ev.content || "").length > 6)) {
    return { ok: false, reason: "negative public-evidence claim is broader than retrieved evidence" };
  }
	  return { ok: true };
	}

function terms(text) {
  const stop = new Set("the a an and or to of in for on with i we you our should what how is are do does did this that it my me if without into from about instead".split(" "));
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !stop.has(term));
}

function assistantTexts(data) {
  return (data.state.conversation || [])
    .filter((entry) => entry.role === "assistant")
    .map((entry) => String(entry.content || ""));
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function noRepeatedQuestions(texts) {
  const questions = texts.flatMap((text) => String(text).split("?").slice(0, -1).map((q) => q.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim()).filter(Boolean));
  return new Set(questions).size === questions.length;
}

async function askTyped(page, text) {
  await page.waitForFunction(() => window.__liveVoiceQa?.getState()?.sessionId, null, { timeout: 10_000 });
  await page.fill("#typedInput", text);
  await page.click("text=Send typed");
}

async function wait(page, pattern, timeout) {
  await page.waitForFunction(
    (source) => window.__liveVoiceQa?.timeline?.some((e) => new RegExp(source, "i").test(`${e.type} ${e.label}`)),
    pattern.source,
    { timeout },
  );
}

async function waitBrowser(page, type, timeout) {
  await page.waitForFunction((eventType) => window.__liveVoiceQa?.browserEvents?.some((e) => e.type === eventType), type, { timeout });
}

async function qaData(page) {
  return page.evaluate(() => ({ timeline: window.__liveVoiceQa.timeline, browserEvents: window.__liveVoiceQa.browserEvents, state: window.__liveVoiceQa.getState() }));
}

async function call(route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, options);
  return res.json().catch(() => ({}));
}

function assert(condition, message) {
  assertions.push({ ok: Boolean(condition), message });
  if (!condition) throw new Error(message);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
