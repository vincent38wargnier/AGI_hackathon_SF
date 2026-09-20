import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import multer from "multer";
import WebSocket, { WebSocketServer } from "ws";
import { config, publicProviderConfig } from "./config.js";
import { SessionRuntime } from "./sessionRuntime.js";
import { transcribeFile } from "./openaiProvider.js";

const app = express();
const upload = multer({ dest: path.resolve(process.cwd(), "artifacts/uploads") });
fs.mkdirSync(path.resolve(process.cwd(), "artifacts/uploads"), { recursive: true });

const runtime = new SessionRuntime();
const clients = new Set();
const realtimeTranscribers = new Map();
const execFileAsync = promisify(execFile);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(process.cwd(), "public")));
// files built by ask_claude (Boson-bridge /files/ convention); auth handled by
// the gate proxy in front, path containment by express.static
fs.mkdirSync(config.claudeScratchDir, { recursive: true });
app.use("/files", express.static(config.claudeScratchDir));

app.get("/api/config", (_req, res) => res.json(publicProviderConfig()));
app.get("/api/state", (_req, res) => res.json(runtime.view()));
app.get("/api/trace", (_req, res) => res.json({ trace: runtime.view().trace, metrics: runtime.view().metrics }));
app.get("/api/documents", async (_req, res) => res.json(await runtime.documents()));

app.post("/api/reset", (_req, res) => {
  runtime.reset();
  res.json({ ok: true });
});

app.post("/api/mode", (req, res) => {
  runtime.setMode(req.body.mode);
  res.json({ ok: true, mode: runtime.state.mode });
});

app.post("/api/web", (req, res) => {
  runtime.setWebEnabled(req.body.enabled);
  res.json({ ok: true, webEnabled: runtime.state.webEnabled });
});

app.post("/api/faults", (req, res) => {
  runtime.setFaults(req.body || {});
  res.json({ ok: true, faults: runtime.state.faults });
});

app.post("/api/rag/refresh", async (_req, res) => {
  try {
    res.json({ ok: true, index: await runtime.refreshRag() });
  } catch (error) {
    runtime.event("error", "Local RAG refresh failed", { message: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/typed", (req, res) => {
  if (!runtime.isCurrentSession(req.body.sessionId)) return res.status(409).json({ ok: false, stale: true });
  runtime.receiveTranscript({ text: req.body.text, status: "final_turn", source: "typed-fallback" });
  res.json({ ok: true });
});

app.post("/api/silence", (req, res) => {
  if (!runtime.isCurrentSession(req.body.sessionId)) return res.status(409).json({ ok: false, stale: true });
  runtime.receiveSilenceCheck();
  res.json({ ok: true });
});

app.post("/api/interim", (req, res) => {
  if (!runtime.isCurrentSession(req.body.sessionId)) return res.status(409).json({ ok: false, stale: true });
  runtime.receiveTranscript({ text: req.body.text, status: "interim", source: req.body.source || "browser" });
  res.json({ ok: true });
});

app.post("/api/audio", upload.single("audio"), async (req, res) => {
  let normalizedPath = null;
  try {
    const status = req.body.status || "final_turn";
    const chunkSeq = req.body.chunkSeq ? Number(req.body.chunkSeq) : null;
    if (!runtime.isCurrentSession(req.body.sessionId)) {
      runtime.event("transcription", `Stale audio upload ignored (${status}${chunkSeq ? ` #${chunkSeq}` : ""})`, { chunkSeq });
      return res.status(409).json({ ok: false, stale: true });
    }
    normalizedPath = await normalizeForTranscription(req.file.path);
    const result = await transcribeFile(normalizedPath);
    runtime.event("transcription", `OpenAI transcription completed (${status}${chunkSeq ? ` #${chunkSeq}` : ""})`, {
      elapsedMs: result.elapsedMs,
      model: result.model,
      bytes: req.file.size,
      chunkSeq,
    });
    runtime.receiveTranscript({ text: result.text, status, source: "voice-openai" });
    res.json({ ok: true, text: result.text, elapsedMs: result.elapsedMs });
  } catch (error) {
    runtime.event("error", "Transcription failed", { message: error.message });
    res.status(500).json({ ok: false, error: error.message });
  } finally {
    if (req.file?.path) fs.rm(req.file.path, { force: true }, () => {});
    if (normalizedPath) fs.rm(normalizedPath, { force: true }, () => {});
  }
});

app.post("/api/played", (req, res) => {
  runtime.markPlayed(req.body.speechId);
  res.json({ ok: true });
});

app.post("/api/playback-start", (req, res) => {
  res.json({ ok: runtime.markPlaybackStart(req.body.speechId) });
});

app.post("/api/interrupt", (_req, res) => {
  runtime.interrupt();
  res.json({ ok: true });
});

app.post("/api/stop", (_req, res) => {
  runtime.stop();
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "config", payload: publicProviderConfig() }));
  ws.send(JSON.stringify({ type: "state", payload: runtime.view() }));
  ws.on("message", (raw) => handleClientWs(ws, raw));
  ws.on("close", () => {
    clients.delete(ws);
    closeRealtime(ws, "browser disconnected");
  });
});

runtime.on("state", (state) => broadcast("state", state));
runtime.on("timeline", (event) => broadcast("timeline", event));
runtime.on("audio", (unit) => broadcast("audio", unit));

function handleClientWs(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type === "realtime_start") startRealtime(ws, msg.payload || {});
  if (msg.type === "realtime_audio") appendRealtimeAudio(ws, msg.payload || {});
  if (msg.type === "realtime_commit") commitRealtimeAudio(ws, msg.payload || {});
  if (msg.type === "realtime_stop") closeRealtime(ws, "browser stopped realtime transcription");
}

function startRealtime(ws, payload) {
  closeRealtime(ws, "new realtime session");
  if (!config.openaiApiKey) {
    runtime.event("error", "Realtime transcription unavailable: missing OpenAI API key");
    return;
  }
  if (!runtime.isCurrentSession(payload.sessionId)) {
    runtime.event("transcription", "Realtime transcription start ignored for stale session");
    return;
  }
  runtime.beginActiveSession();

  const useGradiumStt = config.sttProvider === "gradium" && config.gradiumApiKey;
  const url = useGradiumStt
    ? `${config.gradiumBase}/api/speech/asr`
    : "wss://api.openai.com/v1/realtime?intent=transcription";
  const upstream = new WebSocket(url, {
    headers: useGradiumStt
      ? { "x-api-key": config.gradiumApiKey }
      : { Authorization: `Bearer ${config.openaiApiKey}` },
  });
	  const record = {
	    upstream,
	    provider: useGradiumStt ? "gradium" : "openai",
	    sessionId: payload.sessionId,
	    committed: false,
	    openedAt: Date.now(),
	    committedAt: null,
	    interimSeq: 0,
	    partialTranscript: "",
	    pendingAudio: [],
	    pendingAudioLimit: 36,
	    optimisticFinal: "",
	    optimisticTurnId: null,
	  };
  realtimeTranscribers.set(ws, record);
  runtime.event("transcription", "OpenAI realtime transcription connecting", { model: config.realtimeTranscribeModel });

  upstream.on("open", () => {
    if (useGradiumStt) {
      upstream.send(JSON.stringify({
        type: "setup",
        model_name: "default",
        input_format: "pcm",
        json_config: { language: config.gradiumSttLanguage, delay_in_frames: config.gradiumSttDelayFrames },
      }));
      runtime.event("transcription", "Gradium realtime transcription connected", { model: "gradium-default", language: config.gradiumSttLanguage });
      for (const audio of record.pendingAudio.splice(0)) {
        upstream.send(JSON.stringify({ type: "audio", audio }));
      }
      if (record.committed) {
        upstream.send(JSON.stringify({ type: "flush", flush_id: 1 }));
        upstream.send(JSON.stringify({ type: "end_of_stream" }));
      }
      return;
    }
    upstream.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: config.realtimeTranscribeModel,
              delay: "low",
              ...(config.realtimeTranscribePrompt ? { prompt: config.realtimeTranscribePrompt } : {}),
              ...(config.realtimeTranscribeLanguage ? { language: config.realtimeTranscribeLanguage } : {}),
            },
            turn_detection: null,
          },
        },
      },
    }));
    runtime.event("transcription", "OpenAI realtime transcription connected", { model: config.realtimeTranscribeModel });
    for (const audio of record.pendingAudio.splice(0)) {
      upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    }
    if (record.committed) {
      upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  });

  upstream.on("message", (data) => handleRealtimeEvent(ws, data));
  upstream.on("error", (error) => {
    runtime.event("error", "Realtime transcription socket failed", { message: error.message });
  });
  upstream.on("close", (code, reason) => {
    runtime.event("transcription", "OpenAI realtime transcription closed", { code, reason: reason.toString() });
    realtimeTranscribers.delete(ws);
  });
}

function appendRealtimeAudio(ws, payload) {
  const record = realtimeTranscribers.get(ws);
  if (!record || record.committed || !payload.audio) return;
  if (!runtime.isCurrentSession(record.sessionId)) {
    closeRealtime(ws, "stale runtime session");
    return;
  }
  if (record.upstream.readyState === WebSocket.OPEN) {
    record.upstream.send(JSON.stringify(record.provider === "gradium"
      ? { type: "audio", audio: payload.audio }
      : { type: "input_audio_buffer.append", audio: payload.audio }));
  } else {
    record.pendingAudio.push(payload.audio);
    if (record.pendingAudio.length > record.pendingAudioLimit) record.pendingAudio.shift();
  }
}

function commitRealtimeAudio(ws, payload) {
  const record = realtimeTranscribers.get(ws);
	  if (!record || record.committed) return;
	  record.committed = true;
	  record.committedAt = Date.now();
	  runtime.noteAcousticEnd({
	    acousticEndWallMs: Number.isFinite(payload.speechEndedPerfMs) && Number.isFinite(payload.timeOriginMs) ? payload.speechEndedPerfMs + payload.timeOriginMs : null,
	    committedWallMs: record.committedAt,
	    vadDelayMs: payload.vadDelayMs,
	    endpointDelayMs: payload.endpointDelayMs,
	    reason: payload.reason,
	  });
	  runtime.event("transcription", "Browser committed realtime audio turn", {
    speechStartedPerfMs: payload.speechStartedPerfMs,
    speechEndedPerfMs: payload.speechEndedPerfMs,
    audioChunks: payload.audioChunks,
  });
  const optimistic = String(record.partialTranscript || "").trim();
  if (optimistic) {
    if (isOptimisticTranscriptUseful(optimistic)) {
      record.optimisticFinal = optimistic;
      record.optimisticTurnId = runtime.state.turnId;
      runtime.event("transcription", "Realtime transcription optimistically finalized from latest partial", {
        text: optimistic,
        commitToFinalMs: 0,
        model: config.realtimeTranscribeModel,
        acousticEndWallMs: Number.isFinite(payload.speechEndedPerfMs) && Number.isFinite(payload.timeOriginMs) ? payload.speechEndedPerfMs + payload.timeOriginMs : null,
      });
      runtime.receiveTranscript({ text: optimistic, status: "final_turn", source: "voice-openai-realtime-optimistic", turnId: record.optimisticTurnId });
    } else {
      runtime.event("transcription", "Realtime optimistic final skipped for incomplete partial", {
        text: optimistic,
        model: config.realtimeTranscribeModel,
      });
    }
  }
  if (record.upstream.readyState === WebSocket.OPEN) {
    if (record.provider === "gradium") {
      // trailing silence helps the model finalize the last words, then flush+eos
      const silence = Buffer.alloc(3840).toString("base64");
      for (let i = 0; i < 6; i += 1) record.upstream.send(JSON.stringify({ type: "audio", audio: silence }));
      record.upstream.send(JSON.stringify({ type: "flush", flush_id: 1 }));
      record.upstream.send(JSON.stringify({ type: "end_of_stream" }));
    } else {
      record.upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  }
}

function handleRealtimeEvent(ws, data) {
  const record = realtimeTranscribers.get(ws);
  if (!record) return;
  let event;
  try {
    event = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (record.provider === "gradium") {
    if (event.type === "error") {
      runtime.event("error", "Gradium transcription error", { code: event.code, message: String(event.message || "").slice(0, 200) });
      return;
    }
    if (event.type === "text" && event.text) {
      const segment = String(event.text);
      record.partialTranscript = `${record.partialTranscript} ${segment}`.replace(/\s+([?.!,;:])/g, "$1").replace(/\s+/g, " ").trim();
      if (!record.committed) {
        record.interimSeq += 1;
        runtime.event("transcription", `Realtime transcript delta #${record.interimSeq}`, { delta: segment.trim(), text: record.partialTranscript });
        runtime.receiveTranscript({ text: record.partialTranscript, status: "interim", source: "voice-gradium-realtime" });
      }
      return;
    }
    if (event.type === "flushed" || event.type === "end_of_stream") {
      if (record.finalized) return;
      record.finalized = true;
      const text = String(record.partialTranscript || "").trim();
      const finalizedAt = Date.now();
      runtime.event("transcription", "Realtime transcription finalized", {
        text,
        elapsedMs: finalizedAt - record.openedAt,
        commitToFinalMs: record.committedAt ? finalizedAt - record.committedAt : null,
        model: "gradium-default",
      });
      if (text && materialTranscriptChange(record.optimisticFinal, text)) {
        runtime.event("transcription", "Provider final materially corrected optimistic transcript", { optimistic: record.optimisticFinal, final: text });
        runtime.receiveTranscript({ text, status: "final_turn", source: "voice-gradium-realtime", turnId: record.optimisticTurnId });
      }
      closeRealtime(ws, "turn finalized");
      return;
    }
    return; // ready/step and other Gradium messages are informational
  }
  if (event.type === "error") {
    runtime.event("error", "Realtime transcription provider error", { error: event.error });
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta && !record.committed) {
    const delta = String(event.delta);
    if (delta.trim()) {
      record.partialTranscript = `${record.partialTranscript}${delta}`.replace(/\s+([?.!,;:])/g, "$1").replace(/\s+/g, " ").trimStart();
      record.interimSeq += 1;
      runtime.event("transcription", `Realtime transcript delta #${record.interimSeq}`, { delta: delta.trim(), text: record.partialTranscript });
      runtime.receiveTranscript({ text: record.partialTranscript, status: "interim", source: "voice-openai-realtime" });
    }
  }
  if (event.type === "conversation.item.input_audio_transcription.completed") {
	    const text = String(event.transcript || "").trim();
	    const finalizedAt = Date.now();
	    runtime.event("transcription", "Realtime transcription finalized", {
	      text,
	      elapsedMs: finalizedAt - record.openedAt,
	      commitToFinalMs: record.committedAt ? finalizedAt - record.committedAt : null,
	      model: config.realtimeTranscribeModel,
	    });
    if (text && materialTranscriptChange(record.optimisticFinal, text)) {
      runtime.event("transcription", "Provider final materially corrected optimistic transcript", { optimistic: record.optimisticFinal, final: text });
      runtime.receiveTranscript({ text, status: "final_turn", source: "voice-openai-realtime", turnId: record.optimisticTurnId });
    }
    closeRealtime(ws, "turn finalized");
  }
}

function closeRealtime(ws, reason) {
  const record = realtimeTranscribers.get(ws);
  if (!record) return;
  realtimeTranscribers.delete(ws);
  if ([WebSocket.CONNECTING, WebSocket.OPEN].includes(record.upstream.readyState)) {
    record.upstream.close(1000, reason);
  }
}

async function normalizeForTranscription(inputPath) {
  const outputPath = `${inputPath}.wav`;
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    outputPath,
  ]);
  return outputPath;
}

server.listen(config.port, config.host, () => {
  console.log(`Live Voice Prototype listening on http://${config.host}:${config.port}`);
  console.log(`OpenAI configured: ${publicProviderConfig().hasApiKey ? "yes" : "no"}`);
});

function materialTranscriptChange(left, right) {
  const a = normalizeTranscript(left);
  const b = normalizeTranscript(right);
  if (!b || a === b) return false;
  if (!a) return true;
  const aTerms = a.split(" ").filter(Boolean);
  const bTerms = b.split(" ").filter(Boolean);
  if (b.startsWith(`${a} `) && bTerms.length > aTerms.length) return true;
  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const tokenDelta = Math.abs(aTerms.length - bTerms.length);
  return tokenDelta > 2 || distance / Math.max(1, maxLen) > 0.28;
}

function normalizeTranscript(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isOptimisticTranscriptUseful(text) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return false;
  if (looksOptimisticFinalIncomplete(normalized)) return false;
  if (/^(yes|yeah|yep|sure|no|nope|maybe|dunno)$/.test(normalized)) return true;
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length >= 2) return true;
  return normalized.length >= 4 && !/^(i|a|an|the|uh|um)$/.test(normalized);
}

function looksOptimisticFinalIncomplete(normalized) {
  if (/\bguess (who|what)$/.test(normalized)) return true;
  if (/\bwhat kind$/.test(normalized)) return true;
  if (/\bonly answer yes or$/.test(normalized)) return true;
  if (/\bsomeone( that is)?$/.test(normalized)) return true;
  if (/\b(working|thinking|answer|about|because|before|after|while|with|without|into|from|that|this|the|a|an|or|and|but|so)$/.test(normalized)) return true;
  return false;
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}
