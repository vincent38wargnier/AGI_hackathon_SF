import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { SessionRuntime } from "../src/sessionRuntime.js";

function runtimeForAcceptance({ immediateAudio = true, communicateFn, bridgeDecisionFn } = {}) {
  const options = {};
  if (communicateFn) options.communicateFn = communicateFn;
  if (bridgeDecisionFn) options.bridgeDecisionFn = bridgeDecisionFn;
  const runtime = new SessionRuntime(Object.keys(options).length ? options : undefined);
  const wakeups = [];
  const audio = [];
  runtime.on("audio", (event) => audio.push(event));
  if (immediateAudio) {
    runtime.synthesizeAndEmit = (speechId) => {
      const unit = runtime.state.speech.find((speech) => speech.id === speechId);
      if (!unit || unit.status === "cancelled") return;
      unit.ttsFirstChunkMs = 0;
      unit.ttsElapsedMs = 0;
      unit.status = "audio_generated";
    };
    runtime.synthesizePrepared = (unit) => {
      if (!unit || unit.status === "cancelled") return;
      unit.preparedChunks.push("AQACAA==");
      unit.streamEnded = true;
      unit.status = "audio_prepared";
    };
    runtime.cacheSpeechAudio = () => {};
  }
  const originalWakeup = runtime.wakeup.bind(runtime);
  runtime.wakeup = async (reason) => {
    wakeups.push({ reason, inputVersion: runtime.state.inputVersion, paused: Boolean(runtime.state.pausedConversation) });
    return originalWakeup(reason);
  };
  return { runtime, wakeups, audio };
}

function currentCtx(runtime, mode = "acceptance") {
  return {
    mode,
    epoch: runtime.state.generationEpoch,
    inputVersion: runtime.state.inputVersion,
    knowledgeVersion: runtime.state.knowledgeVersion,
    sessionId: runtime.state.sessionId,
  };
}

function addRunnableSpeech(runtime, attrs) {
  const unit = {
    id: attrs.id,
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: attrs.inputVersion ?? runtime.state.inputVersion,
    text: attrs.text,
    evidenceIds: attrs.evidenceIds || [],
    status: attrs.status || "audio_generated",
    kind: attrs.kind || "answer",
    usefulness: attrs.usefulness || "useful",
    preparedForTranscript: attrs.preparedForTranscript ?? runtime.state.finalizedTranscript,
    createdMonoMs: 1,
    ...attrs,
  };
  runtime.state.speech.push(unit);
  return unit;
}

function playLatest(runtime, predicate = () => true) {
  const unit = [...runtime.state.speech].reverse().find((speech) => predicate(speech) && !["cancelled", "failed", "played"].includes(speech.status));
  assert.ok(unit);
  assert.equal(runtime.markPlaybackStart(unit.id), true);
  runtime.markPlayed(unit.id);
  return unit;
}

function deferredCommunicator() {
  const calls = [];
  const pending = [];
  const communicateFn = ({ mode, snapshot }) => {
    calls.push({ mode, snapshot });
    return new Promise((resolve) => pending.push(resolve));
  };
  return {
    communicateFn,
    calls,
    resolveNext(decision, meta = {}) {
      const resolve = pending.shift();
      assert.ok(resolve, "expected a pending communicator call");
      resolve({
        decision,
        elapsedMs: meta.elapsedMs ?? 42,
        model: meta.model ?? "deterministic-test-provider",
        responseId: meta.responseId ?? `resp_${calls.length}`,
      });
    },
  };
}

async function scenario(name, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    return { name, ok: true, elapsedMs: Date.now() - started, details };
  } catch (error) {
    return {
      name,
      ok: false,
      elapsedMs: Date.now() - started,
      error: { name: error.name, message: error.message, stack: error.stack },
    };
  }
}

const scenarios = [
  scenario("current turn acknowledgement and useful reply can both play", () => {
    const { runtime } = runtimeForAcceptance();
    runtime.state.inputVersion = 1;
    runtime.state.finalizedTranscript = "Assess annual pricing conversion risk";
    runtime.state.metrics.acousticEnds.push({
      inputVersion: 1,
      acousticEndWallMs: Date.now() - 10,
      committedWallMs: Date.now() - 8,
      reason: "test",
    });
    runtime.commitSpeech("One moment.", currentCtx(runtime, "bridge"), [], {
      kind: "acknowledgement",
      usefulness: "latency_bridge",
      yieldsFloor: false,
      continueAfterPlayback: true,
    });
    const ack = runtime.state.speech.at(-1);
    assert.equal(runtime.markPlaybackStart(ack.id), true);
    runtime.markPlayed(ack.id);

    runtime.commitSpeech("Annual pricing risk is mostly checkout comprehension, not discount size.", currentCtx(runtime, "respond"), [], {
      kind: "answer",
      usefulness: "useful",
    });
    const answer = runtime.state.speech.at(-1);
    assert.equal(runtime.markPlaybackStart(answer.id), true);
    const roles = runtime.state.metrics.latencySamples.map((sample) => sample.latencyRole);
    assert.ok(roles.includes("acknowledgement"));
    assert.ok(roles.includes("useful_answer"));
    return { ackStatus: ack.status, answerStatus: answer.status, latencyRoles: roles };
  }),

  scenario("genuinely stale reply cannot start playback", () => {
    const { runtime } = runtimeForAcceptance();
    runtime.state.inputVersion = 7;
    runtime.state.finalizedTranscript = "Find AI events tomorrow in San Francisco";
    const stale = addRunnableSpeech(runtime, {
      id: "sp_stale",
      inputVersion: 6,
      text: "Let's restart the Tesla guessing game.",
      preparedForTranscript: "Restart the Tesla guessing game",
    });
    assert.equal(runtime.markPlaybackStart(stale.id), false);
    assert.equal(stale.status, "cancelled");
    assert.equal(runtime.state.metrics.qualityCounters.staleAudio, 1);
    return { rejectionReason: stale.relevanceRejectionReason, staleAudio: runtime.state.metrics.qualityCounters.staleAudio };
  }),

  scenario("interruption immediately cancels queued speech and pending filler", async () => {
    const { runtime, audio } = runtimeForAcceptance();
    runtime.state.inputVersion = 2;
    runtime.state.finalizedTranscript = "Assess onboarding retention";
    runtime.state.respondInFlight = true;
    runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 2 });
    const answer = addRunnableSpeech(runtime, {
      id: "sp_queued_answer",
      text: "Queued answer that must be cancelled.",
      status: "audio_generated",
    });
    runtime.interrupt();
    assert.equal(answer.status, "cancelled");
    await delay(330);
    assert.equal(runtime.state.speech.some((speech) => speech.kind === "acknowledgement" && speech.text !== "Queued answer that must be cancelled."), false);
    return { queuedStatus: answer.status, audioCancels: audio.filter((event) => event.event === "cancel").length };
  }),

  scenario("useful answer suppresses queued acknowledgement filler", () => {
    const { runtime } = runtimeForAcceptance();
    runtime.state.inputVersion = 3;
    runtime.state.finalizedTranscript = "Assess annual pricing";
    const filler = addRunnableSpeech(runtime, {
      id: "sp_filler",
      text: "Give me a second.",
      kind: "acknowledgement",
      usefulness: "latency_bridge",
      status: "audio_streaming",
    });
    runtime.commitSpeech("The useful answer is ready now.", currentCtx(runtime), [], { kind: "answer" });
    assert.equal(filler.status, "cancelled");
    assert.equal(runtime.state.speech.some((speech) => speech.kind === "answer" && speech.status === "audio_generated"), true);
    return { fillerStatus: filler.status, answerCount: runtime.state.speech.filter((speech) => speech.kind === "answer").length };
  }),

  scenario("bridge acknowledgements are contextual, optional, and cooldowned", async () => {
    const decisions = ["Checking pricing.", "", "Checking onboarding."];
    const { runtime } = runtimeForAcceptance({
      bridgeDecisionFn: async () => ({ text: decisions.length ? decisions.shift() : "Checking later.", model: "bridge-acceptance", elapsedMs: 3 }),
    });
    runtime.state.inputVersion = 4;
    runtime.state.finalizedTranscript = "Research pricing benchmarks";
    runtime.state.respondInFlight = true;
    const firstArmedAt = Date.now();
    runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 4 });
    await delay(40);
    const first = runtime.state.speech.find((speech) => speech.kind === "acknowledgement");
    assert.ok(first);
    assert.equal(first.text, "Checking pricing.");
    const firstElapsedMs = first.createdAt ? Date.now() - firstArmedAt : null;
    assert.ok(firstElapsedMs >= 0 && firstElapsedMs <= 180, `fast provider ack released outside timing bound: ${firstElapsedMs}`);
    runtime.markPlaybackStart(first.id);
    runtime.markPlayed(first.id);

    runtime.state.inputVersion = 5;
    runtime.state.finalizedTranscript = "Research onboarding benchmarks";
    runtime.state.respondInFlight = true;
    runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 5 });
    await delay(180);
    const countAfterCooldownAttempt = runtime.state.speech.filter((speech) => speech.kind === "acknowledgement").length;
    assert.equal(countAfterCooldownAttempt, 1);

    runtime.lastBridgeAcknowledgement.at = 0;
    runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 5 });
    await delay(180);
    const acknowledgements = runtime.state.speech.filter((speech) => speech.kind === "acknowledgement");
    assert.equal(acknowledgements.length, 1);

    runtime.state.inputVersion = 6;
    runtime.state.finalizedTranscript = "Research activation benchmarks";
    runtime.state.respondInFlight = true;
    runtime.lastBridgeAcknowledgement.at = 0;
    runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 6 });
    await delay(40);
    const finalAcknowledgements = runtime.state.speech.filter((speech) => speech.kind === "acknowledgement");
    assert.equal(finalAcknowledgements.length, 2);
    assert.equal(finalAcknowledgements[1].text, "Checking onboarding.");
    return { firstElapsedMs, texts: finalAcknowledgements.map((speech) => speech.text), countAfterCooldownAttempt };
  }),

  scenario("slow bridge fallback waits for 900ms cue boundary", async () => {
    const { runtime } = runtimeForAcceptance({
      bridgeDecisionFn: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    });
    runtime.state.inputVersion = 40;
    runtime.state.finalizedTranscript = "Research current pricing benchmarks";
    runtime.state.respondInFlight = true;
    runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 40 });
    await delay(899);
    assert.equal(runtime.state.speech.some((speech) => speech.kind === "acknowledgement"), false);
    await delay(180);
    const fallback = runtime.state.speech.find((speech) => speech.kind === "acknowledgement");
    assert.ok(fallback);
    assert.equal(fallback.text, "Okay.");
    return { fallback: fallback.text };
  }),

  scenario("partial listener acknowledgement keeps user floor", () => {
    const { runtime } = runtimeForAcceptance();
    runtime.receiveTranscript({
      text: "I need to explain the checkout problem because users are getting confused and",
      status: "interim",
      source: "typed-acceptance",
    });
    const ack = runtime.state.speech.find((speech) => speech.usefulness === "listener_backchannel");
    assert.ok(ack);
    assert.equal(runtime.state.floor, "user_speaking");
    runtime.markPlaybackStart(ack.id);
    runtime.markPlayed(ack.id);
    assert.equal(runtime.state.floor, "user_speaking");
    return { ack: ack.text, floor: runtime.state.floor };
  }),

  scenario("listener acknowledgement ending after final turn keeps main answer active", async () => {
    const provider = deferredCommunicator();
    const { runtime } = runtimeForAcceptance({ communicateFn: provider.communicateFn });
    runtime.receiveTranscript({
      text: "I need to explain the checkout problem because users are getting confused and",
      status: "interim",
      source: "typed-acceptance",
    });
    const ack = runtime.state.speech.find((speech) => speech.usefulness === "listener_backchannel");
    assert.ok(ack);
    assert.equal(runtime.markPlaybackStart(ack.id), true);

    runtime.receiveTranscript({
      text: "I need to explain the checkout problem because users are getting confused and I want to improve the labels.",
      status: "final_turn",
      source: "typed-acceptance",
    });
    await delay(0);
    assert.equal(provider.calls.length, 1);

    provider.resolveNext({ speech: "Improve the checkout labels by pairing each CTA with pricing proof.", actions: [] }, { responseId: "listener_overlap_answer" });
    await delay(0);
    const answer = runtime.state.speech.find((speech) => speech.kind === "answer" && /pricing proof/.test(speech.text));
    assert.ok(answer);
    assert.equal(runtime.state.floor, "assistant_turn");
    assert.equal(runtime.state.currentTurnAssistantCount, 0);

    runtime.markPlayed(ack.id);
    assert.equal(runtime.state.floor, "assistant_turn");
    assert.equal(runtime.state.currentTurnAssistantCount, 0);
    assert.equal(answer.status, "audio_generated");
    assert.equal(provider.calls.length, 1);
    return { providerCalls: provider.calls.length, ack: ack.text, answer: answer.text, floor: runtime.state.floor };
  }),

  scenario("audible bridge does not force a second main communicator call", async () => {
    const provider = deferredCommunicator();
    const { runtime } = runtimeForAcceptance({
      communicateFn: provider.communicateFn,
      bridgeDecisionFn: async () => ({ text: "Checking pricing.", model: "bridge-acceptance", elapsedMs: 2 }),
    });
    runtime.state.inputVersion = 14;
    runtime.state.finalizedTranscript = "Research pricing benchmarks";
    runtime.state.floor = "end_candidate";
    runtime.commitUserTranscript(runtime.state.finalizedTranscript, "typed-acceptance");
    const wake = runtime.wakeup("respond");
    assert.equal(provider.calls.length, 1);
    runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 14 });
    await delay(310);
    const bridge = runtime.state.speech.find((speech) => speech.kind === "acknowledgement");
    assert.ok(bridge);
    assert.equal(runtime.markPlaybackStart(bridge.id), true);

    provider.resolveNext({ speech: "Use pricing proof before checkout.", actions: [] }, { responseId: "answer_while_bridge_playing" });
    await wake;
    await delay(0);
    assert.equal(provider.calls.length, 1);
    assert.equal(runtime.state.speech.some((speech) => speech.kind === "answer"), false);
    assert.equal(runtime.state.trace.some((event) => /deferred until audible bridge finishes/.test(event.label)), true);

    runtime.markPlayed(bridge.id);
    await delay(0);
    const answer = runtime.state.speech.find((speech) => speech.kind === "answer" && /pricing proof/.test(speech.text));
    assert.ok(answer);
    assert.equal(provider.calls.length, 1);
    assert.equal(runtime.state.trace.some((event) => /Deferred response released after audible bridge/.test(event.label)), true);
    return { providerCalls: provider.calls.length, bridge: bridge.text, answer: answer.text };
  }),

  scenario("domain answer does not suppress unresolved role question", async () => {
    let calls = 0;
    const { runtime } = runtimeForAcceptance({
      communicateFn: async () => {
        calls += 1;
        return {
          decision: { speech: "Is this person a founder or an engineer in the tech industry?", actions: [] },
          elapsedMs: 1,
          model: "deterministic-test-provider",
          responseId: `answered_history_${calls}`,
        };
      },
    });
    runtime.state.inputVersion = 58;
    runtime.receiveTranscript({ text: "Yes, involved in tech.", status: "final_turn", source: "typed-acceptance" });
    await delay(0);
    await delay(0);

    assert.equal(calls, 1);
    const roleQuestion = runtime.state.speech.find((speech) => /founder|engineer/.test(speech.text || ""));
    assert.ok(roleQuestion);
    assert.equal(roleQuestion.status, "audio_generated");
    assert.equal(runtime.state.trace.filter((event) => /Question answered by retained user history suppressed/.test(event.label)).length, 0);
    return { calls, speech: roleQuestion.text };
  }),

  scenario("answered history suppression uses bounded game fallback without retry loop", async () => {
    let calls = 0;
    const { runtime } = runtimeForAcceptance({
      communicateFn: async () => {
        calls += 1;
        return {
          decision: { speech: "Did this person work in technology?", actions: [] },
          elapsedMs: 1,
          model: "deterministic-test-provider",
          responseId: `answered_history_${calls}`,
        };
      },
    });
    runtime.commitUserTranscript("Let's play a guessing game; I will think of a person.", "typed-acceptance");
    runtime.state.durableMemory.chosenTask = { text: "Let's play a guessing game; I will think of a person.", inputVersion: 1 };
    runtime.state.conversation.push({ role: "assistant", content: "Is this person involved in tech or startups?", heardStatus: "played", kind: "clarification", usefulness: "contextual_question", inputVersion: 2 });
    runtime.state.inputVersion = 58;
    runtime.receiveTranscript({ text: "Yes, involved in tech.", status: "final_turn", source: "typed-acceptance" });
    await delay(0);
    await delay(0);

    assert.equal(calls, 1);
    const fallback = runtime.state.speech.find((speech) => /inventing|before 1950|Europe|science/i.test(speech.text || ""));
    assert.ok(fallback);
    assert.equal(runtime.state.speech.some((speech) => /Did this person work in technology/i.test(speech.text || "")), false);
    assert.equal(runtime.state.trace.filter((event) => /Question answered by retained user history suppressed/.test(event.label)).length, 1);
    return { calls, fallback: fallback.text };
  }),

  scenario("presence check receives recovery instead of stale game continuation", async () => {
    let calls = 0;
    const { runtime } = runtimeForAcceptance({
      communicateFn: async () => {
        calls += 1;
        return {
          decision: { speech: "Is this person a founder or an employee at a tech company in San Francisco?", actions: [] },
          elapsedMs: 1,
          model: "deterministic-test-provider",
          responseId: `presence_${calls}`,
        };
      },
    });
    runtime.commitUserTranscript("Let's play a guessing game; I will think of a person.", "typed-acceptance");
    runtime.state.durableMemory.chosenTask = { text: "Let's play a guessing game; I will think of a person.", inputVersion: 1 };
    runtime.state.conversation.push({ role: "assistant", content: "Is this person involved in tech or startups?", heardStatus: "played", kind: "clarification", usefulness: "contextual_question", inputVersion: 2 });
    runtime.receiveTranscript({ text: "Yes, involved in tech.", status: "final_turn", source: "typed-acceptance" });
    await delay(0);
    const roleQuestion = runtime.state.speech.find((speech) => /founder|employee/.test(speech.text || ""));
    assert.ok(roleQuestion);
    playLatest(runtime, (speech) => speech.id === roleQuestion.id);

    runtime.receiveTranscript({ text: "are you still here", status: "final_turn", source: "typed-acceptance" });
    await delay(0);
    const recovery = runtime.state.speech.find((speech) => /I'm here\. I got stuck/.test(speech.text || ""));
    assert.ok(recovery);
    assert.equal(calls, 1);
    assert.equal(runtime.state.trace.some((event) => /Question answered by retained user history suppressed/.test(event.label)), false);
    assert.equal(runtime.state.floor, "awaiting_user");
    return { calls, recovery: recovery.text };
  }),

  scenario("explicit hold suppresses late results until resume preserves context", async () => {
    const { runtime, wakeups } = runtimeForAcceptance();
    runtime.state.inputVersion = 1;
    runtime.state.finalizedTranscript = "Assess annual pricing conversion risk";
    const interrupted = addRunnableSpeech(runtime, {
      id: "sp_interrupted",
      text: "Annual pricing has a risk worth explaining.",
      status: "playing",
      playbackStartedAt: new Date().toISOString(),
      playbackStartedMonoMs: 1,
    });
    runtime.interrupt();
    assert.equal(interrupted.status, "cancelled");

    runtime.receiveTranscript({ text: "hold on", status: "final_turn", source: "typed-acceptance" });
    assert.equal(Boolean(runtime.state.pausedConversation), true);
    const pausedInput = runtime.state.inputVersion;
    const jobId = "job_late_hold";
    runtime.state.jobs.set(jobId, {
      id: jobId,
      source: "knowledge",
      query: "annual pricing conversion",
      status: "scheduled",
      required: false,
      inputVersion: runtime.state.inputVersion,
      epoch: runtime.state.generationEpoch,
    });
    await runtime.runSearch(jobId);
    const job = runtime.state.jobs.get(jobId);
    assert.equal(job.status, "done");
    assert.equal(runtime.state.evidence.size > 0, true);
    assert.equal(wakeups.some((entry) => entry.inputVersion >= pausedInput && entry.paused), false);
    assert.equal(runtime.state.speech.some((speech) => speech.kind === "answer" && speech.inputVersion >= pausedInput && speech.status !== "cancelled"), false);

    runtime.receiveTranscript({ text: "continue", status: "final_turn", source: "typed-acceptance" });
    const resume = runtime.state.speech.find((speech) => speech.usefulness === "resume_control");
    assert.ok(resume);
    assert.match(resume.text, /may not know exactly where you stopped hearing me/i);
    assert.equal(Boolean(runtime.state.pausedConversation), false);
    assert.equal(runtime.snapshot("respond").evidence.length > 0, true);
    return { resumeText: resume.text, evidenceAfterResume: runtime.snapshot("respond").evidence.length, wakeups };
  }),

  scenario("in-flight response completing during hold is deferred and useful continuation plays after resume", async () => {
    const provider = deferredCommunicator();
    const { runtime, wakeups } = runtimeForAcceptance({ communicateFn: provider.communicateFn });

    runtime.state.inputVersion = 1;
    runtime.state.finalizedTranscript = "Assess annual pricing conversion risk";
    runtime.state.floor = "end_candidate";
    runtime.commitUserTranscript(runtime.state.finalizedTranscript, "typed-acceptance");
    const initialWakeup = runtime.wakeup("respond");
    assert.equal(provider.calls.length, 1);
    assert.equal(runtime.state.respondInFlight, true);

    runtime.receiveTranscript({ text: "hold on", status: "final_turn", source: "typed-acceptance" });
    assert.equal(Boolean(runtime.state.pausedConversation), true);
    const holdAck = playLatest(runtime, (speech) => speech.usefulness === "pause_control");
    assert.equal(holdAck.text, "Sure, I'll hold.");

    provider.resolveNext({ speech: "Annual pricing risk is checkout comprehension, not discount size.", actions: [] }, { responseId: "late_during_hold" });
    await initialWakeup;
    await delay(0);
    assert.equal(runtime.state.speech.some((speech) => speech.text.includes("checkout comprehension") && speech.status !== "cancelled"), false);
    assert.equal(runtime.state.trace.some((event) => /Decision deferred while conversation is explicitly paused/.test(event.label)), true);
    assert.equal(runtime.state.pendingWakeup, true);
    assert.equal(wakeups.some((entry) => entry.paused), true);

    runtime.state.evidence.set("ev_resume_pricing", {
      id: "ev_resume_pricing",
      source: "local_rag",
      state: "eligible",
      title: "Annual pricing notes",
      content: "Annual pricing conversion improves when savings are shown before checkout.",
      retrievedForQuery: "annual pricing conversion risk",
      originatingInputVersion: runtime.state.inputVersion,
    });
    runtime.receiveTranscript({ text: "continue", status: "final_turn", source: "typed-acceptance" });
    const resumeAck = playLatest(runtime, (speech) => speech.usefulness === "resume_control");
    assert.match(resumeAck.text, /continue from the current thread/i);
    assert.equal(provider.calls.length, 2);

    provider.resolveNext({
      speech: "Continuing the annual pricing thread: show the savings before checkout so the conversion risk is about comprehension, not the discount.",
      evidenceIds: ["ev_resume_pricing"],
      actions: [],
    }, { responseId: "after_resume" });
    await delay(0);

    const continuation = runtime.state.speech.find((speech) => speech.kind === "answer" && /annual pricing thread/i.test(speech.text));
    assert.ok(continuation);
    assert.ok(continuation.evidenceIds.includes("ev_resume_pricing"));
    assert.equal(runtime.markPlaybackStart(continuation.id), true);
    runtime.markPlayed(continuation.id);
    assert.equal(continuation.status, "played");
    return {
      deferredLateDecision: true,
      providerCalls: provider.calls.map((call) => ({ mode: call.mode, transcript: call.snapshot.currentTranscript })),
      resumeAck: resumeAck.text,
      continuation: continuation.text,
      evidenceIds: continuation.evidenceIds,
    };
  }),

  scenario("direct late applyDecision is also paused-gated at the runtime boundary", () => {
    const { runtime } = runtimeForAcceptance();
    runtime.state.inputVersion = 12;
    runtime.state.finalizedTranscript = "Assess annual pricing conversion risk";
    runtime.receiveTranscript({ text: "hold on", status: "final_turn", source: "typed-acceptance" });
    const pausedInput = runtime.state.inputVersion;
    runtime.applyDecision({ speech: "This direct late answer must not be queued while held.", actions: [] }, currentCtx(runtime, "respond"));
    assert.equal(runtime.state.speech.some((speech) => /direct late answer/i.test(speech.text)), false);
    assert.equal(runtime.state.pendingWakeup, true);
    assert.equal(runtime.state.trace.some((event) => /Decision deferred while conversation is explicitly paused/.test(event.label)), true);
    return { pausedInput, limitation: "Direct applyDecision covers the runtime boundary; delayed communicator scenario covers the real wakeup await path." };
  }),

  scenario("compatible partial-to-final keeps useful background work and intent switch retires stale work", () => {
    const { runtime } = runtimeForAcceptance();
    runtime.state.inputVersion = 2;
    runtime.state.finalizedTranscript = "What AI events can I attend tomorrow in San Francisco?";
    assert.equal(runtime.isJobStillRelevant({ inputVersion: 1, query: "AI events tomorrow San Francisco" }), true);
    assert.equal(runtime.isJobStillRelevant({ inputVersion: 1, query: "Tesla guessing game restart" }), false);
    runtime.state.evidence.set("ev_old", {
      id: "ev_old",
      source: "web",
      state: "eligible",
      title: "Old",
      content: "Tesla guessing game restart clues",
      retrievedForQuery: "Tesla guessing game restart",
      originatingInputVersion: 1,
    });
    runtime.retireIrrelevantEvidence("What AI events can I attend tomorrow in San Francisco?");
    assert.equal(runtime.state.evidence.get("ev_old").state, "stale");
    return { compatibleRelevant: true, staleEvidenceState: runtime.state.evidence.get("ev_old").state };
  }),

  scenario("context-free unclear input can ask generic clarification", () => {
    const unclear = runtimeForAcceptance().runtime;
    unclear.receiveTranscript({ text: "huh", status: "final_turn", source: "typed-acceptance" });
    const clarification = unclear.state.speech.find((speech) => speech.kind === "repair");
    assert.ok(clarification);
    assert.match(clarification.text, /What did you want me to do|say that once more|missed/i);
    return { clarification: clarification.text };
  }),

  scenario("known-task unclear input and criticism preserve task context", () => {
    const unclear = runtimeForAcceptance().runtime;
    unclear.receiveTranscript({ text: "Assess annual pricing conversion risk", status: "final_turn", source: "typed-acceptance" });
    unclear.receiveTranscript({ text: "huh", status: "final_turn", source: "typed-acceptance" });
    const clarification = unclear.state.speech.find((speech) => speech.kind === "repair");
    assert.ok(clarification);
    assert.match(clarification.text, /annual pricing conversion risk/i);
    assert.doesNotMatch(clarification.text, /What did you want me to do/i);

    const criticism = runtimeForAcceptance().runtime;
    criticism.receiveTranscript({ text: "Assess annual pricing conversion risk", status: "final_turn", source: "typed-acceptance" });
    criticism.receiveTranscript({ text: "Why did you suck so much to find it?", status: "final_turn", source: "typed-acceptance" });
    const repair = criticism.state.speech.find((speech) => speech.kind === "repair");
    assert.ok(repair);
    assert.match(repair.text, /annual pricing conversion risk/i);
    assert.doesNotMatch(repair.text, /What should I focus on now/i);
    assert.equal(criticism.state.awaitingUser, true);
    return { clarification: clarification.text, repair: repair.text };
  }),

  scenario("retained facts prevent repeat questions and evidence remains useful to current intent", () => {
    const { runtime } = runtimeForAcceptance();
    runtime.state.inputVersion = 1;
    runtime.commitUserTranscript("The person is dead, famous, and worked in technology.", "typed-acceptance");
    for (let index = 0; index < 14; index += 1) {
      runtime.state.conversation.push({ role: "user", content: `small turn ${index}`, inputVersion: index + 2, turnId: `turn_${index}` });
    }
    assert.equal(runtime.hasQuestionAnsweredByHistory("Is the person still alive?"), true);
    assert.equal(runtime.hasQuestionAnsweredByHistory("Is this person a founder or an engineer in the tech industry?"), false);
    runtime.state.inputVersion = 20;
    runtime.state.finalizedTranscript = "For annual pricing conversion, what should we change?";
    runtime.state.evidence.set("ev_current", {
      id: "ev_current",
      source: "local_rag",
      state: "eligible",
      title: "Pricing feedback",
      content: "Annual pricing conversion improves when savings are shown before checkout.",
      retrievedForQuery: "annual pricing conversion",
      originatingInputVersion: 19,
    });
    assert.equal(runtime.bestEligibleLocalEvidence("For annual pricing conversion, what should we change?")?.id, "ev_current");
    assert.equal(runtime.commitEvidenceBackedFastSpeech("For annual pricing conversion, what should we change?"), true);
    const answer = runtime.state.speech.find((speech) => speech.kind === "answer");
    assert.ok(answer);
    assert.ok(answer.evidenceIds.includes("ev_current"));
    return { answeredByHistory: true, evidenceCount: runtime.snapshot("respond").evidence.length, answerText: answer.text };
  }),

  scenario("useful response streams first chunk without waiting for pending web work", async () => {
    const { runtime, audio } = runtimeForAcceptance({ immediateAudio: false });
    runtime.cacheSpeechAudio = () => {};
    runtime.streamUnitAudio = async (unit, { prepared }) => {
      unit.ttsStartedAt = new Date().toISOString();
      unit.ttsStartedMonoMs = 1;
      unit.audioMime = "audio/pcm;rate=24000";
      unit.audioSampleRate = 24000;
      unit.audioEncoding = "s16le";
      unit.audioChannels = 1;
      unit.status = "audio_streaming";
      if (!prepared) runtime.emitAudioStart(unit);
      await delay(35);
      unit.ttsFirstChunkMs = 35;
      unit.audioChunkCount = 1;
      unit.audioBytes = 4;
      runtime.emit("audio", { event: "chunk", speechId: unit.id, audioBase64: "AQACAA==" });
      await delay(35);
      unit.ttsElapsedMs = 70;
      unit.status = "audio_generated";
      runtime.emitAudioEnd(unit);
    };
    runtime.state.inputVersion = 8;
    runtime.state.finalizedTranscript = "Assess annual pricing conversion";
    runtime.state.jobs.set("job_web", {
      id: "job_web",
      source: "web",
      query: "annual pricing conversion benchmark",
      status: "running",
      required: false,
      inputVersion: 8,
      epoch: runtime.state.generationEpoch,
    });
    runtime.applyDecision({ speech: "Start with the checkout savings explanation while web benchmarks finish.", actions: [] }, currentCtx(runtime, "respond"));
    const answer = runtime.state.speech.find((speech) => speech.kind === "answer");
    assert.ok(answer);
    assert.equal(answer.continueAfterPlayback, true);
    await delay(90);
    assert.equal(answer.ttsFirstChunkMs, 35);
    assert.equal(audio.some((event) => event.event === "start" && event.speechId === answer.id), true);
    assert.equal(audio.some((event) => event.event === "chunk" && event.speechId === answer.id), true);
    return { ttsFirstChunkMs: answer.ttsFirstChunkMs, ttsElapsedMs: answer.ttsElapsedMs, pendingWebStatus: runtime.state.jobs.get("job_web").status };
  }),
];

const results = await Promise.all(scenarios);
const summary = {
  ok: results.every((result) => result.ok),
  passed: results.filter((result) => result.ok).length,
  failed: results.filter((result) => !result.ok).length,
  results,
  limitations: [
    "Provider semantics are supplied by deterministic mocked decisions/results; these tests assert runtime gating, scheduling, cancellation, and context behavior.",
    "Synthetic timing uses Node timers and mocked TTS/search; it does not measure live microphone, network, OpenAI, browser, or human-likeness latency.",
  ],
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;
