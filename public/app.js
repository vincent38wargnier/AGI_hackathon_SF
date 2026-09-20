const $ = (id) => document.getElementById(id);
let state = null;
let micStream = null;
let audioEl = new Audio();
let activeSpeechId = null;
let audioContext = null;
let analyser = null;
let processor = null;
let silenceGain = null;
let vadTimer = null;
let lastVoiceMs = 0;
let speechActive = false;
let turnFinalized = false;
let realtimeTurnActive = false;
let awaitingRealtimeFinal = false;
let audioChunksSent = 0;
let speechStartedPerfMs = null;
let speechEndedPerfMs = null;
let browserEvents = [];
let micSessionActive = false;
let silenceCheckTimer = null;
const ACKNOWLEDGEMENT_GAP_SECONDS = 0.3;

const playback = {
  queue: [],
  jobs: new Map(),
  current: null,
  starting: false,
  generation: 0,
  gapTimer: null,
  lastAckEndedAt: 0,
  lastAckEndedPerfMs: 0,
};

const timeline = [];
function recordBrowserEvent(type, data = {}) {
  const at = performance.now();
  const event = {
    type,
    at,
    timeOriginMs: performance.timeOrigin,
    wallMs: performance.timeOrigin + at,
    ...data,
  };
  browserEvents.push(event);
  return event;
}

window.__liveVoiceQa = { timeline, getState: () => state, browserEvents, stopMicOnly };
// WS with auto-reconnect: a dropped socket (phone lock, tunnel blip) used to
// silently kill state/audio/feed forever — the "nothing works anymore" mode.
let ws = null;
let wsEverConnected = false;
let wsRetryMs = 1000;
function connectWs() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  ws.onopen = () => {
    wsRetryMs = 1000;
    if (wsEverConnected) {
      recordBrowserEvent("browser_ws_reconnected");
      if (typeof feedPush === "function") feedPush("event", "Reconnected — session restored", Date.now());
      // resume the realtime STT link if the mic is still open
      if (micSessionActive && state?.sessionId) wsSend({ type: "realtime_start", payload: { sessionId: state.sessionId } });
    }
    wsEverConnected = true;
  };
  ws.onclose = () => {
    recordBrowserEvent("browser_ws_closed");
    if (typeof feedPush === "function") feedPush("error", "Connection lost — reconnecting…", Date.now());
    setTimeout(connectWs, wsRetryMs);
    wsRetryMs = Math.min(5000, wsRetryMs * 1.7);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "config") renderConfig(msg.payload);
    if (msg.type === "state") { state = msg.payload; renderState(); }
    if (msg.type === "timeline") {
      if (/Realtime transcription (finalized|closed)/i.test(msg.payload?.label || "")) awaitingRealtimeFinal = false;
      timeline.unshift(msg.payload);
      feedIngest(msg.payload);
      renderTimeline();
    }
    if (msg.type === "audio") enqueueAudio(msg.payload);
  };
}
function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}
connectWs();

function renderConfig(cfg) {
  feedCfg = cfg;
  $("config").textContent = `Provider: ${cfg.provider} | communicator ${cfg.communicatorModel} | live STT ${cfg.realtimeTranscribeModel} | TTS ${cfg.ttsModel}/${cfg.ttsVoice} | key ${cfg.hasApiKey ? "configured" : "missing"}`;
}

function setVoiceLevel(value) {
  document.documentElement.style.setProperty("--voice-level", String(Math.max(0, Math.min(1, value))));
}

function updateVoiceUi() {
  const voiceState = activeSpeechId ? "speaking" : micSessionActive ? "listening" : awaitingRealtimeFinal ? "processing" : "idle";
  document.body.dataset.voiceState = voiceState;
  $("startBtn")?.setAttribute("aria-pressed", String(micSessionActive));
  const statusText = $("voiceStatusText");
  if (statusText) {
    statusText.textContent = activeSpeechId
      ? "Speaking"
      : awaitingRealtimeFinal
        ? "Working on that"
        : micSessionActive
          ? speechActive
            ? "Listening"
            : "Mic open"
          : "Ready when you are";
  }
  if (activeSpeechId) setVoiceLevel(0.55);
  if (!micSessionActive && !activeSpeechId) setVoiceLevel(0);
}

function renderState() {
  if (!state) return;
  updateVoiceUi();
  const webToggle = $("webToggle");
  if (webToggle) webToggle.checked = Boolean(state.webEnabled);
  $("liveMode")?.classList.toggle("selected", state.mode === "live");
  $("seqMode")?.classList.toggle("selected", state.mode === "sequential");
  $("floor").textContent = state.floor;
  $("partial").textContent = state.provisionalTranscript || "None";
  $("final").textContent = state.finalizedTranscript || "None";
  $("versions").textContent = `input v${state.inputVersion} · knowledge v${state.knowledgeVersion} · epoch ${state.generationEpoch}`;
  $("jobs").innerHTML = state.jobs.map((j) => `<li><strong>${j.source}</strong> ${escapeHtml(j.query)}<div class="meta"><span class="pill ${j.status}">${j.status}</span><span>${j.required ? "required" : "optional"}</span><span>${j.resultCount ?? 0} results</span></div></li>`).join("") || "<li>No jobs yet</li>";
  $("evidence").innerHTML = state.evidence.map((e) => `<li><strong>${escapeHtml(e.title)}</strong><p>${escapeHtml(e.content)}</p>${e.sourceUrl ? `<a class="source-link" href="${escapeAttr(e.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(e.sourceUrl)}</a>` : ""}<div class="meta"><span class="pill">${e.source}</span><span>${e.privacy}</span><span>${e.state}</span></div></li>`).join("") || "<li>No evidence admitted yet</li>";
  $("speech").innerHTML = state.speech.map((s) => `<li><strong class="${s.status}">${s.status}</strong><p>${escapeHtml(s.text)}</p><div class="meta"><span>${s.id}</span><span>epoch ${s.epoch}</span><span>${s.evidenceIds?.length || 0} evidence refs</span></div></li>`).join("") || "<li>No speech drafted yet</li>";
  $("conversation").innerHTML = (state.conversation || []).map((entry) => `<li><strong>${escapeHtml(entry.role)}</strong><p>${escapeHtml(entry.content)}</p><div class="meta"><span>${escapeHtml(entry.turnId || "")}</span><span>${entry.evidenceIds?.length || 0} evidence refs</span></div></li>`).join("") || "<li>No played conversation turns yet</li>";
  feedSyncConversation(state.conversation);
  feedSyncHearing();
  renderMetrics();
}

function renderTimeline() {
  $("clock").textContent = new Date().toLocaleTimeString();
  $("timeline").innerHTML = timeline.slice(0, 80).map((e) => `<li><span class="time">${new Date(e.at).toLocaleTimeString()}</span><span class="type">${e.type}</span><span>${escapeHtml(e.label)}</span></li>`).join("");
  renderMetrics();
}

function renderMetrics() {
  if (!state) return;
  const jobs = state.jobs || [];
  const speech = state.speech || [];
  const asc = [...timeline].sort((a, b) => new Date(a.at) - new Date(b.at));
  const firstRag = asc.find((e) => /local_rag search scheduled/i.test(e.label));
  const finalTranscript = asc.find((e) => /Final transcript/i.test(e.label));
  const realtimeFinal = [...asc].reverse().find((e) => /Realtime transcription finalized/i.test(e.label));
  const bargeStop = [...browserEvents].reverse().find((e) => e.type === "browser_barge_in_stop");
  const bargeSpeechStart = bargeStop ? [...browserEvents].reverse().find((e) => e.type === "browser_speech_started" && e.wallMs <= bargeStop.wallMs) : null;
  const bargeUiStop = bargeStop && bargeSpeechStart
    ? `${Math.max(0, Math.round(bargeStop.wallMs - bargeSpeechStart.wallMs))}ms VAD-event to pause; acoustic latency not measured in UI`
    : "unavailable";
  const modelDurations = asc.filter((e) => /Communicator .* completed/i.test(e.label) && e.data?.elapsedMs).map((e) => `${e.data.elapsedMs}ms`);
  const playbackStart = speech.find((s) => s.playbackStartedAt)?.playbackStartedAt;
  const finalToPlayback = finalTranscript && playbackStart ? `${new Date(playbackStart).getTime() - new Date(finalTranscript.at).getTime()}ms` : "unavailable";
  const earlyRagLead = firstRag && finalTranscript ? `${new Date(finalTranscript.at).getTime() - new Date(firstRag.at).getTime()}ms before final` : "unavailable";
  const rows = [
    ["Speculative jobs", state.metrics?.speculativeJobs ?? 0],
    ["Wasted jobs", state.metrics?.wastedJobs ?? 0],
    ["Realtime STT provider elapsed", realtimeFinal?.data?.commitToFinalMs ? `${realtimeFinal.data.commitToFinalMs}ms commit-to-final; speech-end metric in exported QA` : "unavailable"],
    ["Early RAG lead", earlyRagLead],
    ["Model durations", modelDurations.join(", ") || "unavailable"],
    ["RAG durations", jobs.filter((j) => j.source === "local_rag" && j.durationMs).map((j) => `${j.durationMs}ms`).join(", ") || "unavailable"],
    ["Web durations", jobs.filter((j) => j.source === "web" && j.durationMs).map((j) => `${j.durationMs}ms`).join(", ") || "unavailable"],
    ["TTS request durations", speech.filter((s) => s.ttsElapsedMs).map((s) => `${s.ttsElapsedMs}ms`).join(", ") || "unavailable"],
    ["Playback starts", speech.filter((s) => s.playbackStartedAt).map((s) => s.playbackStartedAt.split("T")[1]?.replace("Z", "")).join(", ") || "unavailable"],
    ["Final transcript to playback", finalToPlayback],
    ["Barge-in browser stop", bargeUiStop],
    ["Latency samples", (state.metrics?.latencySamples || []).map((s) => `${s.acousticEndToPlaybackMs ?? "?"}ms end-to-playback`).join(", ") || "unavailable"],
    ["Cancelled preparations", state.metrics?.cancelledPreparations ?? 0],
    ["Research used", state.metrics?.qualityCounters?.researchUsed ?? 0],
  ];
  $("metrics").innerHTML = rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("");
}

function enqueueAudio(unit) {
  if (unit.event) {
    handleAudioStreamEvent(unit);
    return;
  }
  const speechId = unit.speechId || unit.id;
  const job = playbackJob(speechId, "clip");
  if (job.type === "stream") {
    if (job.started || job.chunks || job.pendingSources || playback.current === job) {
      recordBrowserEvent("browser_audio_clip_fallback_ignored", { speechId });
      return;
    }
    job.type = "clip";
    job.pendingBuffers = [];
  }
  Object.assign(job, {
    kind: unit.kind || job.kind,
    audioMime: unit.audioMime,
    audioBase64: unit.audioBase64,
    ready: true,
  });
  schedulePlayback();
}

async function ensurePlaybackContext() {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

async function handleAudioStreamEvent(event) {
  if (event.event === "cancel") {
    cancelStreamPlayer(event.speechId || event.id);
    return;
  }
  if (event.event === "start") {
    const ctx = await ensurePlaybackContext();
    const speechId = event.speechId || event.id;
    const player = playbackJob(speechId, "stream");
    Object.assign(player, {
      kind: event.kind || player.kind,
      sampleRate: event.sampleRate || 24000,
      ctx,
      prepared: Boolean(event.prepared),
      ready: false,
    });
    recordBrowserEvent("browser_audio_stream_start", { speechId, prepared: Boolean(event.prepared) });
    schedulePlayback();
    return;
  }
  if (event.event === "chunk") {
    const speechId = event.speechId || event.id;
    const player = playbackJob(speechId, "stream");
    if (!player.ctx) player.ctx = await ensurePlaybackContext();
    schedulePcmChunk(player, base64ToBytes(event.audioBase64));
    schedulePlayback();
    return;
  }
  if (event.event === "end") {
    const speechId = event.speechId || event.id;
    const player = playback.jobs.get(speechId);
    if (!player) return;
    player.streamEnded = true;
    if (player.pendingByte !== null) {
      recordBrowserEvent("browser_audio_dropped_incomplete_sample", { speechId, byte: player.pendingByte });
      player.pendingByte = null;
    }
    recordBrowserEvent("browser_audio_stream_end", { speechId, audioBytes: event.audioBytes, audioChunkCount: event.audioChunkCount });
    if (!player.chunks && !player.pendingBuffers.length && !player.pendingSources) {
      recordBrowserEvent("browser_audio_empty_stream_cancel", { speechId });
      cancelStreamPlayer(speechId);
      return;
    }
    maybeFinishStream(player);
    schedulePlayback();
  }
}

function playbackJob(speechId, type) {
  let job = playback.jobs.get(speechId);
  if (job) {
    if (job.type === "clip" && type === "stream" && !job.ready) job.type = "stream";
    return job;
  }
  job = {
    speechId,
    id: speechId,
    type,
    kind: "answer",
    ready: false,
    approved: false,
    approvalPending: false,
    cancelled: false,
    sampleRate: 24000,
    nextTime: 0,
    pendingSources: 0,
    streamEnded: false,
    started: false,
    pendingBuffers: [],
    sources: new Set(),
    pendingByte: null,
    bytes: 0,
    chunks: 0,
    ctx: null,
  };
  playback.jobs.set(speechId, job);
  playback.queue.push(job);
  return job;
}

function cancelStreamPlayer(speechId) {
  const player = playback.jobs.get(speechId);
  if (player) {
    player.cancelled = true;
    for (const source of player.sources) {
      try { source.stop(); } catch {}
    }
    player.pendingBuffers = [];
    playback.jobs.delete(speechId);
  }
  playback.queue = playback.queue.filter((job) => job.speechId !== speechId);
  if (activeSpeechId === speechId) {
    audioEl.pause();
    audioEl.currentTime = 0;
    activeSpeechId = null;
  }
  if (playback.current?.speechId === speechId) playback.current = null;
  clearTimeout(playback.gapTimer);
  playback.gapTimer = null;
  playback.generation += 1;
  updateVoiceUi();
  recordBrowserEvent("browser_audio_cancel", { speechId });
  schedulePlayback();
}

function schedulePcmChunk(player, bytes) {
  if (!bytes?.length) return;
  player.bytes += bytes.byteLength;
  player.chunks += 1;
  if (player.chunks === 1) recordBrowserEvent("browser_audio_first_chunk", { speechId: player.speechId, bytes: bytes.byteLength });
  const samples = pcm16ToFloat(completePcm16Bytes(player, bytes));
  if (!samples.length) return;
  const buffer = player.ctx.createBuffer(1, samples.length, player.sampleRate);
  buffer.copyToChannel(samples, 0);
  if (!player.approved) {
    player.pendingBuffers.push(buffer);
    player.ready = true;
    if (playback.current === player) flushReadyStreamBuffers(player);
    return;
  }
  startStreamBuffer(player, buffer);
}

async function requestPlaybackStart(speechId) {
  try {
    const resp = await fetch("/api/playback-start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speechId }) });
    const result = await resp.json().catch(() => ({ ok: false }));
    return Boolean(result.ok);
  } catch {
    return false;
  }
}

function startStreamBuffer(player, buffer) {
  if (!player.approved || playback.current !== player || !playback.jobs.has(player.speechId)) return;
  const source = player.ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(player.ctx.destination);
  const startAt = Math.max(player.ctx.currentTime + (player.started ? 0.015 : 0.04), player.nextTime || 0);
  player.nextTime = startAt + buffer.duration;
  player.pendingSources += 1;
  player.sources.add(source);
  source.onended = () => {
    player.sources.delete(source);
    player.pendingSources = Math.max(0, player.pendingSources - 1);
    maybeFinishStream(player);
  };
  if (!player.started) {
    player.started = true;
    activeSpeechId = player.speechId;
    updateVoiceUi();
    recordBrowserEvent("browser_audio_start", { speechId: player.speechId, streaming: true });
  }
  source.start(startAt);
}

function maybeFinishStream(player) {
  if (!player.streamEnded || player.pendingSources > 0 || player.pendingBuffers.length > 0 || player.approvalPending) return;
  recordBrowserEvent("browser_audio_end", { speechId: player.speechId, streaming: true, chunks: player.chunks, bytes: player.bytes });
  fetch("/api/played", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speechId: player.speechId }) });
  completePlaybackJob(player);
}

function completePlaybackJob(job) {
  playback.jobs.delete(job.speechId);
  if (activeSpeechId === job.speechId) activeSpeechId = null;
  if (playback.current === job) playback.current = null;
  if (job.kind === "acknowledgement") {
    playback.lastAckEndedAt = job.ctx?.currentTime || audioContext?.currentTime || performance.now() / 1000;
    playback.lastAckEndedPerfMs = performance.now();
    recordBrowserEvent("browser_audio_ack_gap_anchor", { speechId: job.speechId, audioContextTime: playback.lastAckEndedAt });
  }
  updateVoiceUi();
  schedulePlayback();
}

function stopStreamPlayers() {
  clearTimeout(playback.gapTimer);
  playback.gapTimer = null;
  for (const player of playback.jobs.values()) {
    player.pendingBuffers = [];
    player.cancelled = true;
    for (const source of player.sources) {
      try { source.stop(); } catch {}
    }
  }
  playback.jobs.clear();
  playback.queue = [];
  playback.current = null;
  playback.starting = false;
  playback.generation += 1;
}

async function playNextAudio() {
  schedulePlayback();
}

function schedulePlayback() {
  if (playback.current || playback.starting) return;
  const job = playback.queue.find((candidate) => !candidate.cancelled && isJobPlayable(candidate));
  if (!job) return;
  const generation = playback.generation;
  const waitMs = gapBeforeJobMs(job);
  if (waitMs > 0) {
    if (playback.gapTimer) return;
    recordBrowserEvent("browser_audio_ack_gap_wait", { speechId: job.speechId, waitMs });
    playback.gapTimer = setTimeout(() => {
      playback.gapTimer = null;
      if (playback.generation === generation) schedulePlayback();
    }, waitMs);
    return;
  }
  startPlaybackJob(job, generation);
}

function gapBeforeJobMs(job) {
  if (!playback.lastAckEndedAt || job.kind === "acknowledgement") return 0;
  const timelineNow = job.ctx?.currentTime || audioContext?.currentTime || performance.now() / 1000;
  const timelineElapsed = timelineNow - playback.lastAckEndedAt;
  const perfElapsed = playback.lastAckEndedPerfMs ? (performance.now() - playback.lastAckEndedPerfMs) / 1000 : 0;
  return Math.max(0, Math.ceil((ACKNOWLEDGEMENT_GAP_SECONDS - Math.max(timelineElapsed, perfElapsed)) * 1000));
}

function isJobPlayable(job) {
  if (job.type === "clip") return Boolean(job.ready && job.audioBase64);
  return Boolean(job.pendingBuffers.length || (job.started && !job.streamEnded));
}

async function startPlaybackJob(job, generation) {
  playback.starting = true;
  playback.queue = playback.queue.filter((candidate) => candidate !== job);
  playback.current = job;
  activeSpeechId = job.speechId;
  updateVoiceUi();
  const approved = await requestPlaybackStart(job.speechId);
  if (!approved || playback.generation !== generation || playback.current !== job || activeSpeechId !== job.speechId) {
    playback.starting = false;
    if (playback.current === job) playback.current = null;
    if (activeSpeechId === job.speechId) activeSpeechId = null;
    if (!approved) cancelStreamPlayer(job.speechId);
    updateVoiceUi();
    schedulePlayback();
    return;
  }
  job.approved = true;
  playback.starting = false;
  if (job.type === "stream") {
    await ensurePlaybackContext();
    if (!job.ctx) job.ctx = audioContext;
    flushReadyStreamBuffers(job);
    maybeFinishStream(job);
    return;
  }
  audioEl.src = `data:${job.audioMime};base64,${job.audioBase64}`;
  audioEl.onplaying = () => recordBrowserEvent("browser_audio_start", { speechId: job.speechId });
  audioEl.onended = async () => {
    if (playback.current !== job) return;
    recordBrowserEvent("browser_audio_end", { speechId: job.speechId });
    await fetch("/api/played", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speechId: job.speechId }) });
    completePlaybackJob(job);
  };
  try {
    await audioEl.play();
  } catch (error) {
    console.warn("Audio playback was not started automatically", error);
    recordBrowserEvent("browser_audio_play_failed", { speechId: job.speechId, message: error.message });
    cancelStreamPlayer(job.speechId);
  }
}

function flushReadyStreamBuffers(player) {
  if (!player.approved || playback.current !== player) return;
  const buffers = player.pendingBuffers.splice(0);
  for (const buffer of buffers) startStreamBuffer(player, buffer);
}

$("startBtn").onclick = async () => {
  if (micSessionActive) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micSessionActive = true;
  updateVoiceUi();
  setupAudioPipeline(micStream);
  startRealtimeTurn();
  scheduleSilenceCheck();
};

function startRealtimeTurn() {
  if (!micSessionActive || realtimeTurnActive || awaitingRealtimeFinal || !state?.sessionId || ws.readyState !== WebSocket.OPEN) return;
  turnFinalized = false;
  realtimeTurnActive = true;
  audioChunksSent = 0;
  speechStartedPerfMs = null;
  speechEndedPerfMs = null;
  recordBrowserEvent("browser_realtime_turn_start");
  wsSend({ type: "realtime_start", payload: { sessionId: state.sessionId } });
}

$("finishTurnBtn").onclick = async () => {
  commitRealtimeTurn("manual_finish");
};

$("stopBtn").onclick = async () => {
  stopMicOnly();
  audioEl.pause();
  audioEl.removeAttribute("src");
  stopStreamPlayers();
  activeSpeechId = null;
  updateVoiceUi();
  await fetch("/api/stop", { method: "POST" });
};

function stopMicOnly() {
  micSessionActive = false;
  clearInterval(vadTimer);
  clearTimeout(silenceCheckTimer);
  wsSend({ type: "realtime_stop" });
  processor?.disconnect();
  analyser?.disconnect();
  silenceGain?.disconnect();
  processor = null;
  analyser = null;
  silenceGain = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  realtimeTurnActive = false;
  awaitingRealtimeFinal = false;
  updateVoiceUi();
}

$("refreshRagBtn").onclick = async () => {
  await fetch("/api/rag/refresh", { method: "POST" });
};

$("webToggle").onchange = async (event) => {
  await fetch("/api/web", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: event.target.checked }) });
};

export { enqueueAudio, handleAudioStreamEvent, playNextAudio, schedulePcmChunk, requestPlaybackStart };

async function stopPlaybackForSpeech() {
  if (!activeSpeechId) return;
  recordBrowserEvent("browser_barge_in_stop", { speechId: activeSpeechId });
  audioEl.pause();
  audioEl.currentTime = 0;
  stopStreamPlayers();
  await fetch("/api/interrupt", { method: "POST" });
  activeSpeechId = null;
  updateVoiceUi();
}

function setupAudioPipeline(stream) {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  silenceGain = audioContext.createGain();
  silenceGain.gain.value = 0;
  source.connect(processor);
  processor.connect(silenceGain);
  silenceGain.connect(audioContext.destination);
  processor.onaudioprocess = (event) => {
    if (!realtimeTurnActive || !micSessionActive || ws.readyState !== WebSocket.OPEN) return;
    const channel = event.inputBuffer.getChannelData(0);
    const pcm = floatTo16BitPcm(downsample(channel, audioContext.sampleRate, 24000));
    if (audioChunksSent === 0) recordBrowserEvent("browser_mic_pcm_start");
    wsSend({ type: "realtime_audio", payload: { audio: bytesToBase64(pcm) } });
    audioChunksSent += 1;
  };
  const samples = new Uint8Array(analyser.fftSize);
  clearInterval(vadTimer);
  vadTimer = setInterval(async () => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) {
      const centered = value - 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / samples.length);
    setVoiceLevel(rms / 34);
    const now = performance.now();
    if (rms > 7) {
      lastVoiceMs = now;
      if (!speechActive) {
        clearTimeout(silenceCheckTimer);
        speechActive = true;
        turnFinalized = false;
        recordBrowserEvent("browser_speech_started", { rms });
        await stopPlaybackForSpeech();
        if (!realtimeTurnActive) startRealtimeTurn();
        speechStartedPerfMs = now;
      }
    }
    const partial = state?.provisionalTranscript || "";
    const trimmedPartial = partial.trim();
    const partialWordCount = trimmedPartial.split(/\s+/).filter(Boolean).length;
    const partialLooksTerminal = /[?.!]["')\]]?\s*$/.test(trimmedPartial);
    const partialLooksShortComplete = /^(yes|yeah|yep|no|nope|i don'?t know|dunno|maybe|sure)[,.!?\s]*$/i.test(trimmedPartial);
    const partialLooksUnfinished = /\b(and|or|but|so|because|if|when|while|before|after|with|without|for|to|from|about|a|an|the|this|that|public|web|local|annual|enterprise|pricing)\s*[,;:-]?\s*$/i.test(trimmedPartial);
    const partialLooksTooShort = partialWordCount > 0 && partialWordCount <= 3 && !partialLooksTerminal && !partialLooksShortComplete;
    const endpointDelayMs = partialLooksShortComplete ? 160 : partialLooksTerminal ? 260 : 1200;
    if (speechActive && !turnFinalized && now - lastVoiceMs > endpointDelayMs) {
      turnFinalized = true;
      speechActive = false;
      speechEndedPerfMs = lastVoiceMs;
      recordBrowserEvent("browser_silence_finalized", { acousticEndPerfMs: lastVoiceMs, acousticEndWallMs: performance.timeOrigin + lastVoiceMs, vadDelayMs: Math.round(now - lastVoiceMs), endpointDelayMs, partialLooksTerminal });
      commitRealtimeTurn("vad_silence", { vadDelayMs: Math.round(now - lastVoiceMs), endpointDelayMs });
    }
  }, 40);
}

function scheduleSilenceCheck() {
  clearTimeout(silenceCheckTimer);
  silenceCheckTimer = setTimeout(async () => {
    if (!micSessionActive || speechActive || speechStartedPerfMs !== null || activeSpeechId) return;
    recordBrowserEvent("browser_silence_check");
    await fetch("/api/silence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: state?.sessionId }) });
  }, 4500);
}

function commitRealtimeTurn(reason, extra = {}) {
  if (!realtimeTurnActive || ws.readyState !== WebSocket.OPEN) return;
  realtimeTurnActive = false;
  awaitingRealtimeFinal = true;
  recordBrowserEvent("browser_realtime_turn_commit", { reason, audioChunks: audioChunksSent });
  ws.send(JSON.stringify({
    type: "realtime_commit",
    payload: { reason, speechStartedPerfMs, speechEndedPerfMs, timeOriginMs: performance.timeOrigin, audioChunks: audioChunksSent, ...extra },
  }));
  // Keep the mic session open, but reopen realtime transcription only when VAD
  // sees the next user speech. Starting during silence recaptures looping fake
  // mic files and can duplicate user turns.
}

$("interruptBtn").onclick = async () => {
  await stopPlaybackForSpeech();
};

/*
$("stopBtn-old").onclick = async () => {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  else await fetch("/api/stop", { method: "POST" });
};

$("interruptBtn").onclick = async () => {
  audioEl.pause();
  audioEl.currentTime = 0;
  await fetch("/api/interrupt", { method: "POST" });
};
*/

$("typedForm").onsubmit = async (event) => {
  event.preventDefault();
  const text = $("typedInput").value.trim();
  if (!text) return;
  $("typedInput").value = "";
  await fetch("/api/typed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, sessionId: state?.sessionId }) });
};

$("liveMode").onclick = () => setMode("live");
$("seqMode").onclick = () => setMode("sequential");

async function setMode(mode) {
  await fetch("/api/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
  $("liveMode").classList.toggle("selected", mode === "live");
  $("seqMode").classList.toggle("selected", mode === "sequential");
}

function downsample(input, sourceRate, targetRate) {
  if (targetRate === sourceRate) return input;
  const ratio = sourceRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

function floatTo16BitPcm(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pcm16ToFloat(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.max(-1, Math.min(1, view.getInt16(i * 2, true) / 32768));
  }
  return samples;
}

function completePcm16Bytes(player, bytes) {
  let framed = bytes;
  if (player.pendingByte !== null) {
    framed = new Uint8Array(bytes.byteLength + 1);
    framed[0] = player.pendingByte;
    framed.set(bytes, 1);
    player.pendingByte = null;
  }
  if (framed.byteLength % 2 === 0) return framed;
  player.pendingByte = framed[framed.byteLength - 1];
  return framed.subarray(0, framed.byteLength - 1);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

/* ---- Live activity feed ---- */
let feedCfg = null;
let feedTurnCount = 0;
let feedLastHint = "";
const feedList = $("activityFeed");
const feedPanel = $("activityPanel");

function feedNow(at) {
  return new Date(at || Date.now()).toLocaleTimeString([], { hour12: false });
}

function feedPush(kind, html, at) {
  if (!feedList) return;
  const li = document.createElement("li");
  if (kind === "turn-user" || kind === "turn-assistant") {
    li.className = "feed-turn";
    li.dataset.role = kind === "turn-user" ? "user" : "assistant";
    const linked = html.replace(/(\/files\/[\w\-./%]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
    li.innerHTML = `<span class="feed-time">${feedNow(at)}</span><span class="feed-text"><span class="feed-speaker">${kind === "turn-user" ? "You:" : "Agent:"}</span>${linked}</span>`;
  } else {
    li.className = kind === "error" ? "feed-error" : kind === "warn" ? "feed-warn" : "";
    li.innerHTML = `<span class="feed-time">${feedNow(at)}</span><span class="feed-text">${html}</span>`;
  }
  feedList.prepend(li);
  while (feedList.children.length > 120) feedList.lastChild.remove();
  const hintEl = $("activityHint");
  if (hintEl) { feedLastHint = li.querySelector(".feed-text").textContent.slice(0, 60); hintEl.textContent = feedLastHint; }
}

function feedIngest(e) {
  if (!e || !e.label) return;
  const d = e.data || {};
  const L = e.label;
  const q = (v, n = 70) => escapeHtml(String(v ?? "").slice(0, n));
  const model = feedCfg?.communicatorModel || "model";
  if (e.type === "error") return feedPush("error", `${q(L, 90)}${d.message ? " — " + q(d.message, 90) : ""}`, e.at);
  if (/^Semantic endpoint verdict INCOMPLETE/.test(L)) return feedPush("warn", `Endpointer: mid-thought (${d.elapsedMs ?? "?"} ms) — holding the floor`, e.at);
  if (/^Semantic endpoint verdict COMPLETE/.test(L)) return feedPush("event", `Endpointer: sentence complete (${d.elapsedMs ?? "?"} ms)`, e.at);
  if (/^Semantic endpoint verdict AMBIGUOUS/.test(L)) return feedPush("event", "Endpointer: unsure — default flow", e.at);
  if (/^Semantic endpoint classifier (slow|failed); heuristic holds/.test(L)) return feedPush("warn", `Endpointer: classifier slow — holding (heuristic: ${q(d.heuristic, 44)})`, e.at);
  if (/^Semantic endpoint classifier (slow|failed); heuristic allows/.test(L)) return feedPush("warn", `Endpointer: classifier slow — committing (${q(d.heuristic, 44)})`, e.at);
  if (/^Semantic endpoint late verdict COMPLETE/.test(L)) return feedPush("event", `Endpointer: late complete (${d.elapsedMs ?? "?"} ms) — committing`, e.at);
  if (/^Semantic endpoint classifier failed open/.test(L)) return feedPush("warn", "Endpointer: timed out — committing as heard", e.at);
  if (/^Semantic endpoint hold (ceiling|budget)/.test(L)) return feedPush("warn", "Endpointer: max hold reached — committing", e.at);
  if (/^Communicator plan started/.test(L)) return feedPush("event", `Planning ahead (${escapeHtml(model)})…`, e.at);
  if (/^Communicator respond started/.test(L)) return feedPush("event", `Thinking (${escapeHtml(model)})…`, e.at);
  if (/^Communicator respond completed/.test(L)) return feedPush("event", `Decision ready in ${d.elapsedMs ?? "?"} ms`, e.at);
  if (/^Communicator plan completed/.test(L)) return feedPush("event", `Plan ready in ${d.elapsedMs ?? "?"} ms`, e.at);
  if (/aborted for newer input/.test(L)) return feedPush("event", "Superseded by new speech", e.at);
  if (/^claude_task search running/.test(L)) return feedPush("event", `Claude: building — “${q(d.query, 90)}”`, e.at);
  if (/^claude_task search completed/.test(L)) return feedPush("event", `Claude: done (${Math.round((d.durationMs ?? 0) / 1000)}s)`, e.at);
  if (/^Work follow-up queued/.test(L)) return feedPush("event", `Claude: noted — will fold into the running build`, e.at);
  if (/^Starting queued work follow-up/.test(L)) return feedPush("event", `Claude: sending your accumulated changes…`, e.at);
  if (/^Duplicate work request suppressed/.test(L)) return feedPush("event", "Claude: already building that", e.at);
  if (/^local_rag search running/.test(L)) return feedPush("event", `Searching local notes: “${q(d.query)}”`, e.at);
  if (/^web search running/.test(L)) return feedPush("event", `Searching the web: “${q(d.query)}”`, e.at);
  if (/^(local_rag|web) search completed/.test(L)) return feedPush("event", `Search done — ${d.resultCount ?? 0} results (${d.durationMs ?? "?"} ms)`, e.at);
  if (/bridge released/.test(L)) return feedPush("event", `Bridge: “${q(d.text)}”`, e.at);
  if (/^Speech drafted/.test(L)) return feedPush("event", `Reply ready: “${q(d.text)}”`, e.at);
  if (/^Browser started actual playback/.test(L)) return feedPush("event", feedCfg?.ttsProvider === "gradium" ? "Speaking (gradium)…" : "Speaking…", e.at);
  if (/^Gradium realtime transcription connected/.test(L)) return feedPush("event", "Mic link ready (gradium)", e.at);
  if (/^OpenAI realtime transcription connected/.test(L)) return feedPush("event", "Mic link ready", e.at);
  if (/reaped/.test(L)) return feedPush("warn", "Recovered a stuck playback", e.at);
}

function feedSyncConversation(conversation) {
  const items = conversation || [];
  for (let i = feedTurnCount; i < items.length; i++) {
    const entry = items[i];
    feedPush(entry.role === "user" ? "turn-user" : "turn-assistant", escapeHtml(String(entry.content || "").slice(0, 220)));
  }
  feedTurnCount = items.length;
}

function feedSyncHearing() {
  const el = $("activityHearing");
  if (!el) return;
  const text = state?.provisionalTranscript || "";
  el.hidden = !text;
  if (text) el.textContent = `Hearing: “${text.slice(0, 140)}”`;
}

const feedStore = {
  get() { try { return globalThis.localStorage?.getItem("activityFeedOpen") ?? null; } catch { return null; } },
  set(v) { try { globalThis.localStorage?.setItem("activityFeedOpen", v); } catch {} },
};
if (feedPanel) {
  const open = feedStore.get() !== "0";
  feedPanel.dataset.open = String(open);
  $("activityToggle").setAttribute("aria-expanded", String(open));
  $("activityToggle").onclick = () => {
    const next = feedPanel.dataset.open !== "true";
    feedPanel.dataset.open = String(next);
    $("activityToggle").setAttribute("aria-expanded", String(next));
    feedStore.set(next ? "1" : "0");
  };
}
