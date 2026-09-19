import test from "node:test";
import assert from "node:assert/strict";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadApp({ fetchImpl, sourceAutoEnd = true }) {
  const elements = new Map();
  const elementFor = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        checked: false,
        textContent: "",
        innerHTML: "",
        dataset: {},
        classList: { toggle() {} },
        setAttribute() {},
      });
    }
    return elements.get(id);
  };

  let lastAudio;
  const playCalls = [];
  class MockAudio {
    constructor() {
      lastAudio = this;
      this.currentTime = 0;
      this.playCalls = playCalls;
    }
    async play() {
      playCalls.push(this.src);
      this.onplaying?.();
    }
    pause() {}
    removeAttribute(name) {
      delete this[name];
    }
  }

  const sourceStarts = [];
  class MockAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = "running";
      this.destination = {};
    }
    async resume() {}
    createBuffer(_channels, length, sampleRate) {
      return {
        duration: length / sampleRate,
        copyToChannel() {},
      };
    }
    createBufferSource() {
      return {
        connect() {},
        start(at) {
          sourceStarts.push(at);
          if (sourceAutoEnd) this.onended?.();
        },
        stop() {},
      };
    }
  }

  class MockWebSocket {
    constructor() {
      this.readyState = MockWebSocket.OPEN;
    }
    send() {}
  }
  MockWebSocket.OPEN = 1;

  globalThis.document = {
    body: { dataset: {} },
    documentElement: { style: { setProperty() {} } },
    getElementById: elementFor,
  };
  globalThis.window = {};
  globalThis.location = { protocol: "http:", host: "localhost" };
  globalThis.Audio = MockAudio;
  globalThis.AudioContext = MockAudioContext;
  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = fetchImpl;

  const app = await import(`../public/app.js?test=${Date.now()}-${Math.random()}`);
  return { app, lastAudio: () => lastAudio, playCalls, sourceStarts, browserEvents: globalThis.window.__liveVoiceQa.browserEvents };
}

test("queued audio waits for playback-start approval before play", async () => {
  const approval = deferred();
  const { app, playCalls } = await loadApp({
    fetchImpl: async () => approval.promise,
  });

  app.enqueueAudio({ id: "sp_ok", audioMime: "audio/mpeg", audioBase64: "AAA=" });
  await tick();
  assert.equal(playCalls.length, 0);

  approval.resolve({ json: async () => ({ ok: true }) });
  await tick();
  assert.equal(playCalls.length, 1);
  assert.match(playCalls[0], /^data:audio\/mpeg;base64,AAA=/);
});

test("rejected queued audio is skipped and queue advances", async () => {
  const calls = [];
  const { app, playCalls } = await loadApp({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.speechId);
      return { json: async () => ({ ok: body.speechId === "sp_second" }) };
    },
  });

  app.enqueueAudio({ id: "sp_first", audioMime: "audio/mpeg", audioBase64: "FIRST" });
  app.enqueueAudio({ id: "sp_second", audioMime: "audio/mpeg", audioBase64: "SECOND" });
  await tick();
  await tick();

  assert.deepEqual(calls, ["sp_first", "sp_second"]);
  assert.equal(playCalls.length, 1);
  assert.match(playCalls[0], /SECOND$/);
});

test("queued audio canceled while approval is pending never plays", async () => {
  const approval = deferred();
  const { app, playCalls } = await loadApp({
    fetchImpl: async () => approval.promise,
  });

  app.enqueueAudio({ id: "sp_cancel", audioMime: "audio/mpeg", audioBase64: "AAA=" });
  await tick();
  await app.handleAudioStreamEvent({ event: "cancel", speechId: "sp_cancel" });
  approval.resolve({ json: async () => ({ ok: true }) });
  await tick();

  assert.equal(playCalls.length, 0);
});

test("streaming pcm chunks buffer until playback-start approval", async () => {
  const approval = deferred();
  const { app, sourceStarts } = await loadApp({
    fetchImpl: async () => approval.promise,
  });

  await app.handleAudioStreamEvent({ event: "start", speechId: "stream_ok", sampleRate: 24000 });
  await app.handleAudioStreamEvent({ event: "chunk", speechId: "stream_ok", audioBase64: "AQACAA==" });
  await tick();
  assert.equal(sourceStarts.length, 0);

  approval.resolve({ json: async () => ({ ok: true }) });
  await tick();
  assert.equal(sourceStarts.length, 1);
});

test("streaming pcm canceled while approval is pending never starts buffered chunks", async () => {
  const approval = deferred();
  const { app, sourceStarts } = await loadApp({
    fetchImpl: async () => approval.promise,
  });

  await app.handleAudioStreamEvent({ event: "start", speechId: "stream_cancel", sampleRate: 24000 });
  await app.handleAudioStreamEvent({ event: "chunk", speechId: "stream_cancel", audioBase64: "AQACAA==" });
  await tick();
  await app.handleAudioStreamEvent({ event: "cancel", speechId: "stream_cancel" });
  approval.resolve({ json: async () => ({ ok: true }) });
  await tick();

  assert.equal(sourceStarts.length, 0);
});

test("rejected streaming pcm never starts buffered chunks", async () => {
  const { app, sourceStarts } = await loadApp({
    fetchImpl: async () => ({ json: async () => ({ ok: false }) }),
  });

  await app.handleAudioStreamEvent({ event: "start", speechId: "stream_no", sampleRate: 24000 });
  await app.handleAudioStreamEvent({ event: "chunk", speechId: "stream_no", audioBase64: "AQACAA==" });
  await tick();

  assert.equal(sourceStarts.length, 0);
});

test("audible acknowledgement is allowed to finish before ready answer starts", async () => {
  const starts = [];
  const { app, lastAudio, playCalls } = await loadApp({
    fetchImpl: async (url, options) => {
      if (url === "/api/playback-start") {
        starts.push(JSON.parse(options.body).speechId);
        return { json: async () => ({ ok: true }) };
      }
      return { json: async () => ({ ok: true }) };
    },
  });

  app.enqueueAudio({ id: "sp_ack", kind: "acknowledgement", audioMime: "audio/mpeg", audioBase64: "ACK" });
  await tick();
  assert.deepEqual(starts, ["sp_ack"]);
  assert.equal(playCalls.length, 1);

  app.enqueueAudio({ id: "sp_answer", kind: "answer", audioMime: "audio/mpeg", audioBase64: "ANSWER" });
  await tick();
  assert.equal(playCalls.length, 1);

  await lastAudio().onended();
  await tick();
  assert.equal(playCalls.length, 1);
  assert.deepEqual(starts, ["sp_ack"]);
});

test("answer starts at least 300ms after acknowledgement audio completion", async () => {
  const { app, lastAudio, playCalls, browserEvents } = await loadApp({
    fetchImpl: async () => ({ json: async () => ({ ok: true }) }),
  });

  app.enqueueAudio({ id: "sp_ack_gap", kind: "acknowledgement", audioMime: "audio/mpeg", audioBase64: "ACK" });
  await tick();
  await lastAudio().onended();
  app.enqueueAudio({ id: "sp_answer_gap", kind: "answer", audioMime: "audio/mpeg", audioBase64: "ANSWER" });
  await delay(260);
  await tick();
  assert.equal(playCalls.length, 1);
  await delay(80);
  await tick();
  assert.equal(playCalls.length, 2);
  assert.match(playCalls[1], /ANSWER$/);
  assert.ok(browserEvents.some((event) => event.type === "browser_audio_ack_gap_wait" && event.speechId === "sp_answer_gap"));
});

test("no acknowledgement gap is inserted between chunks of one streaming utterance", async () => {
  const { app, sourceStarts } = await loadApp({
    fetchImpl: async () => ({ json: async () => ({ ok: true }) }),
  });

  await app.handleAudioStreamEvent({ event: "start", speechId: "stream_answer", kind: "answer", sampleRate: 24000 });
  await app.handleAudioStreamEvent({ event: "chunk", speechId: "stream_answer", audioBase64: "AQACAA==" });
  await tick();
  await app.handleAudioStreamEvent({ event: "chunk", speechId: "stream_answer", audioBase64: "AwAEAA==" });
  await tick();

  assert.equal(sourceStarts.length, 2);
  assert.ok(sourceStarts[1] - sourceStarts[0] < 0.01, `unexpected interchunk pause: ${sourceStarts[1] - sourceStarts[0]}`);
});

test("clip playback serializes before streaming playback across paths", async () => {
  const { app, lastAudio, playCalls, sourceStarts } = await loadApp({
    fetchImpl: async () => ({ json: async () => ({ ok: true }) }),
  });

  app.enqueueAudio({ id: "sp_clip_first", kind: "answer", audioMime: "audio/mpeg", audioBase64: "CLIP" });
  await tick();
  await app.handleAudioStreamEvent({ event: "start", speechId: "sp_stream_second", kind: "answer", sampleRate: 24000 });
  await app.handleAudioStreamEvent({ event: "chunk", speechId: "sp_stream_second", audioBase64: "AQACAA==" });
  await tick();

  assert.equal(playCalls.length, 1);
  assert.equal(sourceStarts.length, 0);
  await lastAudio().onended();
  await tick();
  assert.equal(sourceStarts.length, 1);
});

test("cancel during acknowledgement gap clears delayed answer playback", async () => {
  const { app, lastAudio, playCalls } = await loadApp({
    fetchImpl: async () => ({ json: async () => ({ ok: true }) }),
  });

  app.enqueueAudio({ id: "sp_ack_cancel_gap", kind: "acknowledgement", audioMime: "audio/mpeg", audioBase64: "ACK" });
  await tick();
  await lastAudio().onended();
  app.enqueueAudio({ id: "sp_answer_cancel_gap", kind: "answer", audioMime: "audio/mpeg", audioBase64: "ANSWER" });
  await tick();
  await app.handleAudioStreamEvent({ event: "cancel", speechId: "sp_answer_cancel_gap" });
  await delay(340);
  await tick();

  assert.equal(playCalls.length, 1);
});

test("same-speech clip fallback replaces unheard empty stream but not an audible stream", async () => {
  const { app, playCalls } = await loadApp({
    fetchImpl: async () => ({ json: async () => ({ ok: true }) }),
  });

  await app.handleAudioStreamEvent({ event: "start", speechId: "sp_fallback", kind: "answer", sampleRate: 24000 });
  app.enqueueAudio({ id: "sp_fallback", kind: "answer", audioMime: "audio/mpeg", audioBase64: "FALLBACK" });
  await tick();
  assert.equal(playCalls.length, 1);
  assert.match(playCalls[0], /FALLBACK$/);

  const audible = await loadApp({
    fetchImpl: async () => ({ json: async () => ({ ok: true }) }),
    sourceAutoEnd: false,
  });
  await audible.app.handleAudioStreamEvent({ event: "start", speechId: "sp_audible_stream", kind: "answer", sampleRate: 24000 });
  await audible.app.handleAudioStreamEvent({ event: "chunk", speechId: "sp_audible_stream", audioBase64: "AQACAA==" });
  await tick();
  audible.app.enqueueAudio({ id: "sp_audible_stream", kind: "answer", audioMime: "audio/mpeg", audioBase64: "IGNORED" });
  await tick();
  assert.equal(audible.sourceStarts.length, 1);
  assert.equal(audible.playCalls.length, 0);
  assert.ok(audible.browserEvents.some((event) => event.type === "browser_audio_clip_fallback_ignored" && event.speechId === "sp_audible_stream"));
});
