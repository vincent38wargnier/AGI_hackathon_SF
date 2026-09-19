import test from "node:test";
import assert from "node:assert/strict";
import { SessionRuntime } from "../src/sessionRuntime.js";
import { parseBridgeDecisionText } from "../src/openaiProvider.js";

function runtimeForUnitTests({ bridgeDecisionFn = async () => ({ text: "Checking that.", model: "bridge-test", elapsedMs: 1 }) } = {}) {
  const runtime = new SessionRuntime({ bridgeDecisionFn });
  runtime.synthesizeAndEmit = (speechId) => {
    const unit = runtime.state.speech.find((s) => s.id === speechId);
    if (unit && unit.status !== "cancelled") unit.status = "audio_generated";
  };
  runtime.synthesizePrepared = () => {};
  runtime.cacheSpeechAudio = () => {};
  runtime.wakeup = () => {};
  return runtime;
}

function cachedAudioRuntime() {
  const runtime = new SessionRuntime();
  const warmed = [];
  const audio = [];
  runtime.runSpeechAudioWarm = (entry) => {
    warmed.push({ text: entry.text, purpose: entry.purpose });
    entry.status = "ready";
    entry.chunks = ["AQACAA=="];
    entry.bytes = 4;
    entry.chunkCount = 1;
    entry.model = "test-tts";
  };
  runtime.synthesizePrepared = () => {};
  runtime.wakeup = () => {};
  runtime.on("audio", (event) => audio.push(event));
  runtime.beginActiveSession();
  return { runtime, warmed, audio };
}

test("playback-start rejects stale generated speech against latest user turn", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 3;
  runtime.state.finalizedTranscript = "AI events tomorrow in San Francisco";
  runtime.state.speech.push({
    id: "sp_old",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 2,
    text: "Was this about restarting the Tesla game?",
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
  });

  assert.equal(runtime.markPlaybackStart("sp_old"), false);
  assert.equal(runtime.state.speech[0].status, "cancelled");
  assert.equal(runtime.state.speech[0].relevanceRejectionReason, "missing_overlap_terms");
  assert.equal(runtime.state.metrics.qualityCounters.staleAudio, 1);
});

test("playback-start accepts current-turn acknowledgement without transcript overlap metadata", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 24;
  runtime.state.finalizedTranscript = "Copy like Zoe's, Zoe's backend";
  runtime.state.speech.push({
    id: "sp_ack_current",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 24,
    text: "Give me a second.",
    evidenceIds: [],
    status: "audio_generated",
    kind: "acknowledgement",
    usefulness: "latency_bridge",
    createdMonoMs: 1,
  });

  assert.equal(runtime.markPlaybackStart("sp_ack_current"), true);
  assert.equal(runtime.state.speech[0].status, "playing");
  assert.equal(runtime.markPlaybackStart("sp_ack_current"), true);
  assert.equal(runtime.state.metrics.qualityCounters.staleAudio, 0);
});

test("playback-start accepts current-turn yes/no game question after bare no reply", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 25;
  runtime.state.finalizedTranscript = "No.";
  runtime.state.conversation.push(
    { role: "user", content: "Let us play twenty questions. Only ask yes or no questions." },
    { role: "assistant", content: "Is it usually found in a kitchen?", kind: "answer", usefulness: "useful", heardStatus: "played" },
    { role: "user", content: "No." },
  );
  runtime.state.speech.push({
    id: "sp_current_yes_no_question",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 25,
    text: "Is it electronic?",
    preparedForTranscript: "No.",
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
  });

  assert.equal(runtime.markPlaybackStart("sp_current_yes_no_question"), true);
  assert.equal(runtime.state.speech[0].status, "playing");
});

test("emotional negation does not reject current supportive answer as correction", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 31;
  runtime.state.finalizedTranscript = "I feel disgusting, which is dramatic, but that is the word. I am not actually good at this.";
  runtime.state.speech.push({
    id: "sp_supportive_negation",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 31,
    text: "Disgusting is a hard word to say out loud, and I am not going to rush you away from it.",
    preparedForTranscript: runtime.state.finalizedTranscript,
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
  });

  assert.equal(runtime.markPlaybackStart("sp_supportive_negation"), true);
  assert.equal(runtime.state.speech[0].status, "playing");
});

test("listening-only preference suppresses advice but allows acknowledgements", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 32;
  runtime.state.finalizedTranscript = "Please do not problem solve yet. I just need you to listen.";
  runtime.state.speech.push(
    {
      id: "sp_advice_during_listen",
      turnId: runtime.state.turnId,
      epoch: runtime.state.generationEpoch,
      inputVersion: 32,
      text: "One thing you should do tomorrow is send a short note with the next step.",
      evidenceIds: [],
      status: "audio_generated",
      kind: "answer",
      usefulness: "useful",
      createdMonoMs: 1,
    },
    {
      id: "sp_ack_during_listen",
      turnId: runtime.state.turnId,
      epoch: runtime.state.generationEpoch,
      inputVersion: 32,
      text: "Okay, I will listen.",
      evidenceIds: [],
      status: "audio_generated",
      kind: "acknowledgement",
      usefulness: "latency_bridge",
      createdMonoMs: 1,
    },
  );

  assert.equal(runtime.markPlaybackStart("sp_advice_during_listen"), false);
  assert.equal(runtime.state.speech[0].relevanceRejectionReason, "listening_only_preference");
  assert.equal(runtime.markPlaybackStart("sp_ack_during_listen"), true);
});

test("material correction still rejects stale factual answer", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 33;
  runtime.state.finalizedTranscript = "Actually, switch to the Ford launch instead of Tesla.";
  runtime.state.speech.push({
    id: "sp_stale_fact",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 32,
    text: "The Tesla launch answer is ready.",
    preparedForTranscript: "Tell me about the Tesla launch.",
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
  });

  assert.equal(runtime.markPlaybackStart("sp_stale_fact"), false);
  assert.equal(runtime.state.speech[0].relevanceRejectionReason, "contradicting_correction");
});

test("corrected pronoun invalidates contentful stale answer while neutral backchannels are exempt", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 44;
  runtime.state.finalizedTranscript = "Actually, I meant her, not him.";
  runtime.state.speech.push({
    id: "sp_stale_pronoun_answer",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 43,
    text: "The answer about him is ready.",
    preparedForTranscript: "Draft the answer about him.",
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
  });

  assert.equal(runtime.markPlaybackStart("sp_stale_pronoun_answer"), false);
  assert.equal(runtime.state.speech[0].relevanceRejectionReason, "contradicting_correction");
});

test("current answer prepared for corrected transcript can acknowledge correction", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 34;
  runtime.state.finalizedTranscript = "No, not disappeared exactly. You went polite and distant.";
  runtime.state.speech.push({
    id: "sp_current_correction_reply",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 34,
    text: "That correction matters. Polite and distant can feel like being kept outside the door.",
    preparedForTranscript: runtime.state.finalizedTranscript,
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
  });

  assert.equal(runtime.markPlaybackStart("sp_current_correction_reply"), true);
});

test("explicit wait keeps pause control path and rejects queued answer", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 35;
  runtime.state.speech.push({
    id: "sp_wait_stale",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 34,
    text: "Here is the answer I was about to give.",
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
  });

  runtime.receiveTranscript({ text: "wait", status: "final_turn", source: "typed-test" });

  assert.equal(runtime.state.speech.find((speech) => speech.id === "sp_wait_stale").status, "cancelled");
  assert.equal(Boolean(runtime.state.pausedConversation), true);
  assert.ok(runtime.state.speech.some((speech) => speech.usefulness === "pause_control"));
});

test("explicit dismissal closes once and suppresses repeated closure turns", () => {
  const runtime = runtimeForUnitTests();

  runtime.receiveTranscript({ text: "Actually stop there.", status: "final_turn", source: "typed-test" });
  const firstClosures = runtime.state.speech.filter((speech) => speech.kind === "closure");
  assert.equal(firstClosures.length, 1);
  assert.equal(firstClosures[0].text, "Understood. I'll leave it there.");
  assert.equal(runtime.state.floor, "closed");
  assert.equal(runtime.state.awaitingUser, false);

  runtime.receiveTranscript({ text: "stop", status: "final_turn", source: "typed-test" });
  runtime.receiveTranscript({ text: "no thanks", status: "final_turn", source: "typed-test" });

  const closures = runtime.state.speech.filter((speech) => speech.kind === "closure");
  assert.equal(closures.length, 1);
  assert.equal(runtime.state.trace.some((event) => /Repeated closure suppressed/.test(event.label)), true);
});

test("resume respond snapshot uses paused intent instead of bare continue", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({ text: "Explain the annual pricing risk in plain English.", status: "final_turn", source: "typed-test" });
  runtime.receiveTranscript({ text: "wait", status: "final_turn", source: "typed-test" });
  runtime.receiveTranscript({ text: "continue", status: "final_turn", source: "typed-test" });

  const snapshot = runtime.snapshot("respond");
  assert.equal(snapshot.currentTranscript, "Explain the annual pricing risk in plain English.");
  assert.equal(snapshot.finalizedTranscript, "continue");
  assert.equal(snapshot.resumeIntentText, "Explain the annual pricing risk in plain English.");
  assert.equal(runtime.state.speech.filter((speech) => speech.usefulness === "resume_control").length, 1);
});

test("editing follow-up keeps prior writing task relevant for playback", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({
    text: "I need to reply to Clara about moving the kickoff. Warm but firm: I can keep Monday at 9 or 11, but Friday is too late for the design review.",
    status: "final_turn",
    source: "typed-test",
  });

  runtime.receiveTranscript({ text: "Use that, just make it sendable.", status: "final_turn", source: "typed-test" });
  runtime.state.speech.push({
    id: "sp_sendable_email",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: runtime.state.inputVersion,
    text: "Hi Clara, thanks for being flexible. I can keep Monday at 9 or 11, but Friday is too late for the design review.",
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
    preparedForTranscript: runtime.preparedForTranscriptFor("answer"),
  });

  assert.match(runtime.state.speech.at(-1).preparedForTranscript, /Clara/);
  assert.equal(runtime.markPlaybackStart("sp_sendable_email"), true);
});

test("known writing repair can proceed with direct draft", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({
    text: "I need a short email to Clara: Monday 9 or 11 works, Friday is too late because design review is Tuesday.",
    status: "final_turn",
    source: "typed-test",
  });

  runtime.receiveTranscript({ text: "Why did you ask that? I already said the task is the email.", status: "final_turn", source: "typed-test" });
  runtime.state.speech.push({
    id: "sp_repair_draft",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: runtime.state.inputVersion,
    text: "Hi Clara, Monday at 9 or 11 works for me. Friday is too late because the design review is Tuesday.",
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
    preparedForTranscript: runtime.preparedForTranscriptFor("answer"),
  });

  assert.equal(runtime.markPlaybackStart("sp_repair_draft"), true);
});

test("explicit writing revision is not suppressed as redundant", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({
    text: "I need to reply to Clara about moving the kickoff. Warm but firm: I can keep Monday at 9 or 11, but Friday is too late for the design review.",
    status: "final_turn",
    source: "typed-test",
  });
  runtime.state.speech.push({
    id: "sp_initial_email",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: runtime.state.inputVersion,
    text: "Here's a draft: Hi Clara, I can do Monday at 9 or 11. Friday is too late for the design review. Let me know what works.",
    evidenceIds: [],
    status: "played",
    kind: "answer",
    usefulness: "useful",
    conversationRecorded: true,
  });

  runtime.receiveTranscript({ text: "Use that, just make it sendable.", status: "final_turn", source: "typed-test" });

  assert.equal(
    runtime.isRedundantSpeech([], "Hi Clara, I can do Monday at 9 or 11. Friday is too late for the design review. Let me know what works for you."),
    false,
  );
});

test("committed current-turn clarification records transcript and can start playback", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 24;
  runtime.state.finalizedTranscript = "Copy like Zoe's, Zoe's backend";

  runtime.commitSpeech("Are you asking me to guess a product, a company, or something else related to Zoe's backend?", {
    mode: "test",
    epoch: runtime.state.generationEpoch,
    inputVersion: 24,
    knowledgeVersion: runtime.state.knowledgeVersion,
    sessionId: runtime.state.sessionId,
  }, [], { kind: "clarification", usefulness: "contextual_question" });

  const unit = runtime.state.speech.find((speech) => speech.kind === "clarification");
  assert.equal(unit.preparedForTranscript, "Copy like Zoe's, Zoe's backend");
  assert.equal(runtime.markPlaybackStart(unit.id), true);
  assert.equal(unit.status, "playing");
});

test("event details invalidate repeated name-or-event clarification", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 67;
  runtime.state.finalizedTranscript = "I'm the organizer of the event of today in San Francisco AWS";
  runtime.state.speech.push({
    id: "sp_repeat_event_question",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 67,
    text: "Could you please share your full name or the event name so I can search for your image on Google?",
    preparedForTranscript: "Yes, I'm the organizer of the event",
    evidenceIds: [],
    status: "audio_generated",
    kind: "clarification",
    usefulness: "contextual_question",
    createdMonoMs: 1,
  });

  assert.equal(runtime.markPlaybackStart("sp_repeat_event_question"), false);
  assert.equal(runtime.state.speech[0].relevanceRejectionReason, "clarification_already_answered");
});

test("stale presence answer is rejected after user moves back to game request", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 73;
  runtime.state.finalizedTranscript = "I only help, I want to play a game";
  runtime.state.speech.push({
    id: "sp_stale_presence",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 73,
    text: "No, I'm not dead. Still here if you want to continue or ask anything else.",
    preparedForTranscript: "I only help, I want to play a game",
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
  });

  assert.equal(runtime.markPlaybackStart("sp_stale_presence"), false);
  assert.equal(runtime.state.speech[0].relevanceRejectionReason, "text_not_allowed_for_current_intent");
});

test("meta criticism rejects stale game continuation", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 101;
  runtime.state.finalizedTranscript = "Worse and worse";
  runtime.state.speech.push({
    id: "sp_stale_game_question",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 101,
    text: "Would you like to play a word game, trivia, or twenty questions?",
    preparedForTranscript: "Hello,",
    evidenceIds: [],
    status: "audio_generated",
    kind: "clarification",
    usefulness: "contextual_question",
    createdMonoMs: 1,
  });

  assert.equal(runtime.markPlaybackStart("sp_stale_game_question"), false);
  assert.equal(runtime.state.speech[0].relevanceRejectionReason, "text_not_allowed_for_current_intent");
});

test("compatible partial-to-final research survives but topic switch is dropped", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 2;
  runtime.state.finalizedTranscript = "What AI events can I go to tomorrow in San Francisco?";

  assert.equal(runtime.isJobStillRelevant({
    inputVersion: 1,
    query: "AI-related events in San Francisco happening tomorrow",
  }), true);

  assert.equal(runtime.isJobStillRelevant({
    inputVersion: 1,
    query: "Tesla guessing game restart",
  }), false);
});

test("interruption records audibility without inventing heard words", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.speech.push({
    id: "sp_interrupt",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: runtime.state.inputVersion,
    text: "This is a long answer that should not be marked as heard just because audio started.",
    evidenceIds: [],
    status: "playing",
    kind: "answer",
    usefulness: "useful",
    playbackStartedAt: new Date().toISOString(),
    playbackStartedMonoMs: 1,
    createdMonoMs: 1,
  });

  runtime.interrupt();
  const recorded = runtime.state.conversation.find((entry) => entry.speechId === "sp_interrupt");
  assert.equal(recorded.heardStatus, "interrupted");
  assert.equal(recorded.heardContent, "");
  assert.match(recorded.heardNote, /exact heard words are unknown/i);
  assert.equal(typeof recorded.audibleMs, "number");
});

test("criticism becomes current repair intent instead of stale topic continuation", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({ text: "Assess annual pricing conversion risk", status: "final_turn", source: "typed-test" });
  runtime.receiveTranscript({ text: "Why did you suck so much to find it?", status: "final_turn", source: "typed-test" });

  const repair = runtime.state.speech.find((speech) => speech.kind === "repair");
  assert.ok(repair);
  assert.match(repair.text, /annual pricing conversion risk/i);
  assert.doesNotMatch(repair.text, /What should I focus on now/i);
  assert.equal(runtime.state.awaitingUser, true);
});

test("ordinary short contextual replies do not trigger repair clarification", () => {
  for (const text of ["San Francisco", "Tomorrow", "Ada"]) {
    const runtime = runtimeForUnitTests();
    runtime.state.conversation.push({ role: "assistant", content: "Where should I look?" });
    runtime.receiveTranscript({ text, status: "final_turn", source: "typed-test" });

    assert.equal(runtime.state.speech.some((speech) => speech.kind === "repair"), false, text);
  }
});

test("narrative stop wording does not trigger fast dismissal closure", () => {
  const runtime = runtimeForUnitTests();
  const text = "It made me stop sending small things, because I thought, do not reach where you are not wanted.";
  runtime.receiveTranscript({ text, status: "final_turn", source: "typed-test" });

  assert.equal(runtime.state.speech.some((speech) => speech.text === "Understood. I'll leave it there."), false);
  runtime.applyDecision(
    { speech: "That sounds like you protected yourself by making the friendship smaller.", actions: [] },
    {
      mode: "respond",
      epoch: runtime.state.generationEpoch,
      inputVersion: runtime.state.inputVersion,
      knowledgeVersion: runtime.state.knowledgeVersion,
      sessionId: runtime.state.sessionId,
      responseId: "friend_repair_5",
      model: "scripted-main-provider",
    },
  );

  const answer = runtime.state.speech.find((speech) => speech.kind === "answer" && speech.status === "audio_generated");
  assert.ok(answer);
  assert.equal(answer.text, "That sounds like you protected yourself by making the friendship smaller.");
  assert.equal(runtime.markPlaybackStart(answer.id), true);
  assert.equal(answer.status, "playing");
});

test("explicit polite stop still rejects non-closure playback", () => {
  for (const text of ["please stop", "stop talking", "leave me alone", "do not call"]) {
    const runtime = runtimeForUnitTests();
    runtime.state.inputVersion = 40;
    runtime.state.finalizedTranscript = text;
    runtime.state.speech.push({
      id: `sp_${text.replace(/\s+/g, "_")}`,
      turnId: runtime.state.turnId,
      epoch: runtime.state.generationEpoch,
      inputVersion: 40,
      text: "I can keep going with the answer.",
      preparedForTranscript: text,
      evidenceIds: [],
      status: "audio_generated",
      kind: "answer",
      usefulness: "useful",
      createdMonoMs: 1,
    });

    assert.equal(runtime.markPlaybackStart(runtime.state.speech[0].id), false, text);
    assert.equal(runtime.state.speech[0].relevanceRejectionReason, "contradicting_correction", text);
  }
});

test("ambiguous repair fragments still ask for clarification", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.conversation.push({ role: "assistant", content: "Which city?" });
  runtime.receiveTranscript({ text: "huh", status: "final_turn", source: "typed-test" });

  const repair = runtime.state.speech.find((speech) => speech.kind === "repair");
  assert.ok(repair);
  assert.match(repair.text, /say that once more|missed/i);
});

test("unclear fragment with known task asks targeted clarification", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({ text: "Assess annual pricing conversion risk", status: "final_turn", source: "typed-test" });
  runtime.receiveTranscript({ text: "huh", status: "final_turn", source: "typed-test" });

  const repair = runtime.state.speech.find((speech) => speech.kind === "repair");
  assert.ok(repair);
  assert.match(repair.text, /annual pricing conversion risk/i);
  assert.doesNotMatch(repair.text, /What did you want me to do/i);
});

test("bridge acknowledgement is suppressed when useful evidence arrives before delay", async () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 4;
  runtime.state.respondInFlight = true;
  runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 4 });
  runtime.state.evidence.set("ev_ready", {
    id: "ev_ready",
    source: "web",
    state: "eligible",
    originatingInputVersion: 4,
    title: "Ready",
    content: "A useful result arrived.",
  });

  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(runtime.state.speech.some((speech) => speech.kind === "acknowledgement"), false);
});

test("bridge acknowledgement is canceled by user interruption", async () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 5;
  runtime.state.respondInFlight = true;
  runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 5 });
  runtime.interrupt();

  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(runtime.state.speech.some((speech) => speech.kind === "acknowledgement"), false);
});

test("useful speech cancels queued acknowledgement filler", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 6;
  runtime.state.speech.push({
    id: "sp_ack",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 6,
    text: "One moment.",
    evidenceIds: [],
    status: "audio_streaming",
    kind: "acknowledgement",
    usefulness: "latency_bridge",
    createdMonoMs: 1,
  });

  runtime.commitSpeech("Here is the useful answer.", {
    mode: "test",
    epoch: runtime.state.generationEpoch,
    inputVersion: 6,
    knowledgeVersion: runtime.state.knowledgeVersion,
    sessionId: runtime.state.sessionId,
  }, [], { kind: "answer" });

  assert.equal(runtime.state.speech.find((speech) => speech.id === "sp_ack").status, "cancelled");
  assert.equal(runtime.state.speech.some((speech) => speech.kind === "answer" && speech.status === "audio_generated"), true);
});

test("bridge skips trace-like greeting and yes/no game turns without provider calls", async () => {
  let bridgeCalls = 0;
  for (const text of ["Yo, what's up?", "No.", "Yes,", "Oui."]) {
    const runtime = runtimeForUnitTests({
      bridgeDecisionFn: async () => {
        bridgeCalls += 1;
        return { text: "Checking that.", model: "bridge-test", elapsedMs: 1 };
      },
    });
    runtime.state.inputVersion = 7;
    runtime.state.finalizedTranscript = text;
    runtime.state.respondInFlight = true;
    runtime.state.conversation.push({ role: "user", content: "Let's play a yes or no guessing game." });
    runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 7 });
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(runtime.state.speech.some((speech) => speech.kind === "acknowledgement"), false, text);
  }
  assert.equal(bridgeCalls, 0);
});

test("bridge uses contextual generated decision and generated audio cache", async () => {
  const cached = [];
  const runtime = runtimeForUnitTests({
    bridgeDecisionFn: async ({ snapshot }) => ({
      text: snapshot.currentTranscript.includes("pricing") ? "Checking pricing." : "Checking that.",
      model: "bridge-test",
      elapsedMs: 2,
    }),
  });
  runtime.cacheSpeechAudio = (text, options) => cached.push({ text, purpose: options?.purpose });
  runtime.state.inputVersion = 8;
  runtime.state.finalizedTranscript = "Research pricing benchmarks";
  runtime.state.respondInFlight = true;
  runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 8 });
  await new Promise((resolve) => setTimeout(resolve, 320));

  const bridge = runtime.state.speech.find((speech) => speech.kind === "acknowledgement");
  assert.ok(bridge);
  assert.equal(bridge.text, "Checking pricing.");
  assert.deepEqual(cached, [{ text: "Checking pricing.", purpose: "bridge-generated" }]);
});

test("slow bridge fallback is eligible only at 900ms and only with a cue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const runtime = runtimeForUnitTests({
    bridgeDecisionFn: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  runtime.state.inputVersion = 80;
  runtime.state.finalizedTranscript = "Research current pricing benchmarks";
  runtime.state.respondInFlight = true;
  runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 80 });

  t.mock.timers.tick(0);
  await Promise.resolve();
  t.mock.timers.tick(899);
  await Promise.resolve();
  assert.equal(runtime.state.speech.some((speech) => speech.kind === "acknowledgement"), false);

  t.mock.timers.tick(1);
  await Promise.resolve();
  const bridge = runtime.state.speech.find((speech) => speech.kind === "acknowledgement");
  assert.ok(bridge);
  assert.equal(bridge.text, "Okay.");
  assert.equal(runtime.state.trace.some((event) => event.data?.source === "fallback" && event.data?.elapsedMs === 900), true);
});

test("bridge stays silent at 900ms without a justified cue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const runtime = runtimeForUnitTests({
    bridgeDecisionFn: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  runtime.state.inputVersion = 81;
  runtime.state.finalizedTranscript = "Tell me something";
  runtime.state.respondInFlight = true;
  runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 81 });
  t.mock.timers.tick(0);
  await Promise.resolve();
  t.mock.timers.tick(901);
  await Promise.resolve();

  assert.equal(runtime.state.speech.some((speech) => speech.kind === "acknowledgement"), false);
  assert.equal(runtime.state.trace.some((event) => /fallback stayed silent/.test(event.label)), true);
});

test("explicit bridge silence releases contextual fallback when a useful cue exists", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const runtime = runtimeForUnitTests({
    bridgeDecisionFn: async () => ({ text: "", model: "bridge-test", elapsedMs: 10 }),
  });
  runtime.state.inputVersion = 82;
  runtime.state.finalizedTranscript = "Research current onboarding risks";
  runtime.state.respondInFlight = true;
  runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 82 });
  t.mock.timers.tick(0);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(900);
  await Promise.resolve();

  const bridge = runtime.state.speech.find((speech) => speech.kind === "acknowledgement");
  assert.ok(bridge);
  assert.equal(bridge.text, "Okay.");
  assert.equal(runtime.state.trace.some((event) => event.data?.source === "fallback-after-silence"), true);
});

test("late bridge result after fallback cannot double speak", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let resolveDecision;
  const runtime = runtimeForUnitTests({
    bridgeDecisionFn: () => new Promise((resolve) => { resolveDecision = resolve; }),
  });
  runtime.state.inputVersion = 83;
  runtime.state.finalizedTranscript = "Research current retention benchmarks";
  runtime.state.respondInFlight = true;
  runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 83 });
  t.mock.timers.tick(0);
  await Promise.resolve();
  t.mock.timers.tick(900);
  await Promise.resolve();
  assert.equal(runtime.state.speech.filter((speech) => speech.kind === "acknowledgement").length, 1);

  resolveDecision({ text: "Checking retention.", model: "bridge-test", elapsedMs: 950 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.state.speech.filter((speech) => speech.kind === "acknowledgement").length, 1);
});

test("main answer ready before fallback cancels delayed bridge", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const runtime = runtimeForUnitTests({
    bridgeDecisionFn: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  runtime.state.inputVersion = 84;
  runtime.state.finalizedTranscript = "Research current conversion benchmarks";
  runtime.state.respondInFlight = true;
  runtime.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 84 });
  t.mock.timers.tick(400);
  runtime.commitSpeech("Conversion benchmarks are ready.", {
    mode: "respond",
    epoch: runtime.state.generationEpoch,
    inputVersion: 84,
    knowledgeVersion: runtime.state.knowledgeVersion,
    sessionId: runtime.state.sessionId,
  }, [], { kind: "answer" });
  t.mock.timers.tick(600);
  await Promise.resolve();

  assert.equal(runtime.state.speech.filter((speech) => speech.kind === "acknowledgement").length, 0);
  assert.equal(runtime.state.speech.some((speech) => speech.kind === "answer"), true);
});

test("bridge decision silence without cue, duplicate, error, and timeout do not release filler", async () => {
  const silent = runtimeForUnitTests({ bridgeDecisionFn: async () => ({ text: "", model: "bridge-test", elapsedMs: 1 }) });
  silent.state.inputVersion = 9;
  silent.state.finalizedTranscript = "Tell me something";
  silent.state.respondInFlight = true;
  silent.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 9 });
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(silent.state.speech.some((speech) => speech.kind === "acknowledgement"), false);

  const duplicate = runtimeForUnitTests({ bridgeDecisionFn: async () => ({ text: "Checking that.", model: "bridge-test", elapsedMs: 1 }) });
  duplicate.lastBridgeAcknowledgement = { text: "Checking that.", at: 0 };
  duplicate.state.inputVersion = 10;
  duplicate.state.finalizedTranscript = "Research conversion benchmarks";
  duplicate.state.respondInFlight = true;
  duplicate.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 10 });
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(duplicate.state.speech.some((speech) => speech.kind === "acknowledgement"), false);

  const erroring = runtimeForUnitTests({ bridgeDecisionFn: async () => { throw new Error("bridge down"); } });
  erroring.state.inputVersion = 11;
  erroring.state.finalizedTranscript = "Research retention benchmarks";
  erroring.state.respondInFlight = true;
  erroring.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 11 });
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(erroring.state.speech.some((speech) => speech.kind === "acknowledgement"), false);

  const oldTimeout = process.env.OPENAI_BRIDGE_TIMEOUT_MS;
  const timeout = runtimeForUnitTests({
    bridgeDecisionFn: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  timeout.state.inputVersion = 12;
  timeout.state.finalizedTranscript = "Tell me something";
  timeout.state.respondInFlight = true;
  const { config } = await import("../src/config.js");
  const priorTimeout = config.bridgeTimeoutMs;
  config.bridgeTimeoutMs = 40;
  timeout.scheduleBridgeAcknowledgement({ reason: "model-pending", inputVersion: 12 });
  await new Promise((resolve) => setTimeout(resolve, 1020));
  config.bridgeTimeoutMs = priorTimeout;
  if (oldTimeout === undefined) delete process.env.OPENAI_BRIDGE_TIMEOUT_MS;
  else process.env.OPENAI_BRIDGE_TIMEOUT_MS = oldTimeout;
  assert.equal(timeout.state.speech.some((speech) => speech.kind === "acknowledgement"), false);
});

test("partial listener acknowledgement can overlap user floor without allowing answers over user", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({
    text: "I am talking through this situation because the labels are confusing and",
    status: "interim",
    source: "typed-test",
  });
  const ack = runtime.state.speech.find((speech) => speech.kind === "acknowledgement" && speech.usefulness === "listener_backchannel");
  assert.ok(ack);
  assert.equal(ack.text, "Mm-hm.");
  assert.equal(runtime.state.floor, "user_speaking");
  assert.equal(runtime.markPlaybackStart(ack.id), true);
  runtime.markPlayed(ack.id);
  assert.equal(runtime.state.floor, "user_speaking");

  runtime.commitSpeech("This ordinary answer must not cut in.", {
    mode: "test",
    epoch: runtime.state.generationEpoch,
    inputVersion: runtime.state.inputVersion,
    knowledgeVersion: runtime.state.knowledgeVersion,
    sessionId: runtime.state.sessionId,
  }, [], { kind: "answer" });
  assert.equal(runtime.state.speech.some((speech) => speech.kind === "answer"), false);
});

test("listener acknowledgement fires for ordinary longer incident-style partial", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({
    text: "I'm the organizer of the event of today in San Francisco AWS",
    status: "interim",
    source: "typed-test",
  });

  const ack = runtime.state.speech.find((speech) => speech.kind === "acknowledgement" && speech.usefulness === "listener_backchannel");
  assert.ok(ack);
  assert.equal(ack.text, "Mm-hm.");
  assert.equal(runtime.state.floor, "user_speaking");
});

test("listener acknowledgement is not blocked by unheard generated answer", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.speech.push({
    id: "sp_unheard_answer",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: runtime.state.inputVersion,
    text: "I can answer that once you finish.",
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
  });

  runtime.receiveTranscript({
    text: "I'm the organizer of the event of today in San Francisco AWS",
    status: "interim",
    source: "typed-test",
  });

  assert.equal(runtime.state.speech.some((speech) => speech.usefulness === "listener_backchannel"), true);
});

test("listener acknowledgement remains playable after harmless continuing transcript growth", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({
    text: "I am talking through this situation because the labels are confusing and",
    status: "interim",
    source: "typed-test",
  });
  const ack = runtime.state.speech.find((speech) => speech.kind === "acknowledgement" && speech.usefulness === "listener_backchannel");
  assert.ok(ack);

  runtime.receiveTranscript({
    text: "I need to explain the checkout problem because users are getting confused and I want to fix her labels",
    status: "interim",
    source: "typed-test",
  });

  assert.equal(runtime.markPlaybackStart(ack.id), true);
  assert.equal(ack.status, "playing");
  assert.equal(ack.relevanceRejectionReason, undefined);
});

test("listener acknowledgement ending after final turn preserves main answer floor", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({
    text: "I need to explain the checkout problem because users are getting confused and",
    status: "interim",
    source: "typed-test",
  });
  const ack = runtime.state.speech.find((speech) => speech.kind === "acknowledgement" && speech.usefulness === "listener_backchannel");
  assert.ok(ack);
  assert.equal(runtime.markPlaybackStart(ack.id), true);

  runtime.receiveTranscript({
    text: "I need to explain the checkout problem because users are getting confused and I want to improve the labels.",
    status: "final_turn",
    source: "typed-test",
  });
  runtime.applyDecision({ speech: "Improve the checkout labels by pairing each CTA with pricing proof.", actions: [] }, {
    mode: "respond",
    epoch: runtime.state.generationEpoch,
    inputVersion: runtime.state.inputVersion,
    knowledgeVersion: runtime.state.knowledgeVersion,
    sessionId: runtime.state.sessionId,
    responseId: "resp_listener_overlap",
    model: "test",
  });

  const answer = runtime.state.speech.find((speech) => speech.kind === "answer" && /pricing proof/.test(speech.text));
  assert.ok(answer);
  assert.equal(runtime.state.floor, "assistant_turn");
  assert.equal(runtime.state.currentTurnAssistantCount, 0);

  runtime.markPlayed(ack.id);
  assert.equal(runtime.state.floor, "assistant_turn");
  assert.equal(runtime.state.currentTurnAssistantCount, 0);
  assert.equal(answer.status, "audio_generated");
  assert.equal(runtime.state.speech.filter((speech) => speech.kind === "answer").length, 1);
});

test("listener acknowledgement suppresses repetition within one user turn", () => {
  const runtime = runtimeForUnitTests();
  runtime.receiveTranscript({
    text: "I need to explain the checkout problem because users are getting confused and",
    status: "interim",
    source: "typed-test",
  });
  runtime.state.speech.forEach((speech) => {
    if (speech.usefulness === "listener_backchannel") speech.status = "played";
  });
  runtime.receiveTranscript({
    text: "I need to explain the checkout problem because users are getting confused and the pricing feels unclear so",
    status: "interim",
    source: "typed-test",
  });

  assert.equal(runtime.state.speech.filter((speech) => speech.usefulness === "listener_backchannel").length, 1);
});

test("listener acknowledgement uses preloaded cached audio for sustained mixed-language speech", () => {
  const { runtime, warmed, audio } = cachedAudioRuntime();
  assert.equal(warmed.some((entry) => entry.text === "Mm-hm." && entry.purpose === "active-session-preload"), true);
  const warmCountBeforeSpeech = warmed.length;

  runtime.receiveTranscript({ text: "Да и вообще", status: "interim", source: "typed-test" });
  assert.equal(runtime.state.speech.some((speech) => speech.usefulness === "listener_backchannel"), false);

  runtime.receiveTranscript({ text: "Да и вообще в принципе сделал", status: "interim", source: "typed-test" });

  const ack = runtime.state.speech.find((speech) => speech.usefulness === "listener_backchannel");
  assert.ok(ack);
  assert.equal(ack.text, "Mm-hm.");
  assert.equal(ack.status, "audio_generated");
  assert.equal(warmed.length, warmCountBeforeSpeech);
  assert.deepEqual(audio.map((event) => event.event), ["start", "chunk", "end"]);
  assert.equal(runtime.state.floor, "user_speaking");
});

test("cached listener acknowledgement survives growth, explicit stop, and final answer handoff", () => {
  const { runtime } = cachedAudioRuntime();

  runtime.receiveTranscript({
    text: "I am talking through this situation because the labels are confusing and",
    status: "interim",
    source: "typed-test",
  });
  const ack = runtime.state.speech.find((speech) => speech.usefulness === "listener_backchannel");
  assert.ok(ack);

  runtime.receiveTranscript({
    text: "I am talking through this situation because the labels are confusing and the wording keeps bothering me",
    status: "interim",
    source: "typed-test",
  });
  assert.equal(runtime.markPlaybackStart(ack.id), true);
  assert.equal(ack.status, "playing");
  runtime.markPlayed(ack.id);

  runtime.receiveTranscript({
    text: "I am talking through this situation because the labels are confusing and the wording keeps bothering me.",
    status: "final_turn",
    source: "typed-test",
  });
  runtime.applyDecision({ speech: "For the situation with confusing labels, simplify the wording and keep the answer grounded in what is bothering you.", actions: [] }, {
    mode: "respond",
    epoch: runtime.state.generationEpoch,
    inputVersion: runtime.state.inputVersion,
    knowledgeVersion: runtime.state.knowledgeVersion,
    sessionId: runtime.state.sessionId,
    responseId: "resp_cached_listener_handoff",
    model: "test",
  });
  assert.ok(runtime.state.speech.find((speech) => speech.kind === "answer" && /confusing labels/.test(speech.text)));
  assert.equal(runtime.state.floor, "assistant_turn");

  const stopRuntime = cachedAudioRuntime().runtime;
  stopRuntime.receiveTranscript({ text: "stop talking now please stay silent", status: "interim", source: "typed-test" });
  assert.equal(stopRuntime.state.speech.some((speech) => speech.usefulness === "listener_backchannel"), false);
});

test("bridge parser handles streamed text result bounds", () => {
  assert.equal(parseBridgeDecisionText("SPEAK: Checking pricing"), "Checking pricing.");
  assert.equal(parseBridgeDecisionText("SILENCE"), "");
  assert.equal(parseBridgeDecisionText("SPEAK: One moment."), "");
  assert.equal(parseBridgeDecisionText("SPEAK: Should I answer?"), "");
  assert.equal(parseBridgeDecisionText("SPEAK: this phrase is definitely far too long for a tiny bridge"), "");
});

test("main response cancels unheard latency bridge and defers behind audible bridge", async () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 13;
  runtime.state.finalizedTranscript = "Research pricing benchmarks";
  runtime.state.speech.push({
    id: "sp_unheard_bridge",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 13,
    text: "Checking pricing.",
    evidenceIds: [],
    status: "audio_generated",
    kind: "acknowledgement",
    usefulness: "latency_bridge",
    createdMonoMs: 1,
  });
  runtime.applyDecision({ speech: "Pricing benchmarks are ready.", actions: [] }, {
    mode: "respond",
    epoch: runtime.state.generationEpoch,
    inputVersion: 13,
    knowledgeVersion: runtime.state.knowledgeVersion,
    sessionId: runtime.state.sessionId,
    responseId: "resp_unheard",
    model: "test",
  });
  assert.equal(runtime.state.speech.find((speech) => speech.id === "sp_unheard_bridge").status, "cancelled");
  assert.equal(runtime.state.speech.some((speech) => speech.kind === "answer" && /ready/.test(speech.text)), true);

  const audible = runtimeForUnitTests();
  audible.state.inputVersion = 14;
  audible.state.finalizedTranscript = "Research retention benchmarks";
  audible.state.speech.push({
    id: "sp_audible_bridge",
    turnId: audible.state.turnId,
    epoch: audible.state.generationEpoch,
    inputVersion: 14,
    text: "Checking retention.",
    evidenceIds: [],
    status: "playing",
    kind: "acknowledgement",
    usefulness: "latency_bridge",
    playbackStartedAt: new Date().toISOString(),
    playbackStartedMonoMs: 1,
    createdMonoMs: 1,
  });
  audible.applyDecision({ speech: "Retention benchmarks are ready.", actions: [] }, {
    mode: "respond",
    epoch: audible.state.generationEpoch,
    inputVersion: 14,
    knowledgeVersion: audible.state.knowledgeVersion,
    sessionId: audible.state.sessionId,
    responseId: "resp_audible",
    model: "test",
  });
  assert.equal(audible.state.speech.some((speech) => speech.kind === "answer"), false);
  audible.markPlayed("sp_audible_bridge");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(audible.state.speech.some((speech) => speech.kind === "answer" && /Retention benchmarks/.test(speech.text)), true);
});

test("new finalized input aborts obsolete response and answers latest corrected transcript", async () => {
  let firstAbortSeen = false;
  const calls = [];
  const runtime = new SessionRuntime({
    communicateFn: ({ mode, snapshot, signal }) => {
      calls.push({ mode, transcript: snapshot.currentTranscript });
      if (calls.length === 1) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            firstAbortSeen = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      return Promise.resolve({
        elapsedMs: 3,
        model: "unit-model",
        responseId: "resp_latest",
        decision: { speech: "Use her corrected label in the reply.", actions: [] },
      });
    },
  });
  runtime.synthesizeAndEmit = (speechId) => {
    const unit = runtime.state.speech.find((speech) => speech.id === speechId);
    if (unit && unit.status !== "cancelled") unit.status = "audio_generated";
  };

  runtime.state.inputVersion = 57;
  runtime.state.finalizedTranscript = "Draft the label for him";
  runtime.state.floor = "end_candidate";
  runtime.wakeup("respond");
  await new Promise((resolve) => setTimeout(resolve, 0));

  runtime.state.inputVersion = 58;
  runtime.state.finalizedTranscript = "Correction: draft the label for her";
  runtime.state.floor = "end_candidate";
  runtime.wakeup("respond");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const answer = runtime.state.speech.find((speech) => speech.kind === "answer" && /her corrected label/.test(speech.text));
  assert.equal(firstAbortSeen, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].transcript, "Correction: draft the label for her");
  assert.ok(answer);
  assert.equal(answer.inputVersion, 58);
  assert.equal(runtime.state.speech.filter((speech) => speech.kind === "answer").length, 1);
});

test("explicit stop aborts in-flight response generation", async () => {
  let aborted = false;
  const runtime = new SessionRuntime({
    communicateFn: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }),
  });
  runtime.state.inputVersion = 20;
  runtime.state.finalizedTranscript = "Keep explaining this.";
  runtime.state.floor = "end_candidate";
  runtime.wakeup("respond");
  await new Promise((resolve) => setTimeout(resolve, 0));

  runtime.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(aborted, true);
  assert.equal(runtime.state.floor, "closed");
  assert.equal(runtime.state.respondInFlight, false);
});

test("speech uses in-flight warmed cache instead of duplicate synthesis", async () => {
  const runtime = new SessionRuntime();
  let streamCalls = 0;
  runtime.streamUnitAudio = async () => {
    streamCalls += 1;
  };
  const key = "gpt-4o-mini-tts:alloy:pcm-24000:One moment.";
  let resolveWarm;
  const warmPromise = new Promise((resolve) => { resolveWarm = resolve; });
  runtime.speechAudioCache.set(key, {
    status: "warming",
    text: "One moment.",
    key,
    chunks: [],
    bytes: 0,
    chunkCount: 0,
    promise: warmPromise,
  });
  runtime.state.speech.push({
    id: "sp_cache",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: runtime.state.inputVersion,
    text: "One moment.",
    evidenceIds: [],
    status: "committed",
    kind: "acknowledgement",
    usefulness: "latency_bridge",
    createdMonoMs: 1,
  });

  const emitting = runtime.synthesizeAndEmit("sp_cache");
  runtime.speechAudioCache.get(key).chunks.push("AQACAA==");
  runtime.speechAudioCache.get(key).bytes = 4;
  runtime.speechAudioCache.get(key).chunkCount = 1;
  runtime.speechAudioCache.get(key).status = "ready";
  runtime.speechAudioCache.get(key).model = "test-tts";
  resolveWarm();
  await emitting;

  assert.equal(streamCalls, 0);
  assert.equal(runtime.state.speech.find((speech) => speech.id === "sp_cache").status, "audio_generated");
});

test("active session preloads a bounded acknowledgement bank without provider calls in test", () => {
  const runtime = new SessionRuntime();
  const warmed = [];
  runtime.runSpeechAudioWarm = (entry) => {
    warmed.push(entry.text);
    entry.status = "warming";
    runtime.audioWarmInFlight += 1;
  };

  runtime.beginActiveSession();
  runtime.beginActiveSession();

  assert.deepEqual([...runtime.speechAudioCache.values()].map((entry) => entry.purpose), [
    "active-session-preload",
    "active-session-preload",
    "active-session-preload",
  ]);
  assert.equal([...runtime.speechAudioCache.values()].some((entry) => entry.text === "Mm-hm."), true);
  assert.equal(runtime.speechAudioCache.size, 3);
  assert.equal(warmed.length, 2);
  assert.equal(warmed[0], "Mm-hm.");
  assert.equal(runtime.audioWarmQueue.length, 1);
});

test("contextual acknowledgement warming is bounded per input version and reuses cache", () => {
  const runtime = new SessionRuntime();
  const warmed = [];
  runtime.runSpeechAudioWarm = (entry) => {
    warmed.push(entry.text);
    entry.status = "ready";
    entry.chunks = ["AQACAA=="];
    entry.bytes = 4;
    entry.chunkCount = 1;
  };

  runtime.state.inputVersion = 11;
  runtime.warmContextualAcknowledgements("Look up current AI events tomorrow");
  runtime.warmContextualAcknowledgements("Look up current AI events tomorrow again");
  runtime.state.inputVersion = 12;
  runtime.warmContextualAcknowledgements("Look up current AI events tomorrow");

  assert.equal(warmed.filter((text) => text === "I'm checking.").length, 1);
  assert.equal(warmed.filter((text) => text === "Let me check.").length, 0);
  assert.equal(runtime.contextWarmInputVersions.has(11), true);
  assert.equal(runtime.contextWarmInputVersions.has(12), true);
});

test("explicit pause cancels queued speech and continue resumes without replaying stale audio", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 2;
  runtime.state.speech.push({
    id: "sp_old",
    turnId: runtime.state.turnId,
    epoch: runtime.state.generationEpoch,
    inputVersion: 2,
    text: "A stale answer that should not replay.",
    evidenceIds: [],
    status: "audio_generated",
    kind: "answer",
    usefulness: "useful",
    createdMonoMs: 1,
  });
  runtime.state.conversation.push({
    role: "assistant",
    content: "The previous answer was interrupted halfway.",
    heardContent: "",
    heardStatus: "interrupted",
    kind: "answer",
    speechId: "sp_interrupted",
  });

  runtime.receiveTranscript({ text: "hold on", status: "final_turn", source: "typed-test" });
  assert.equal(runtime.state.speech.find((speech) => speech.id === "sp_old").status, "cancelled");
  assert.equal(runtime.state.pausedConversation?.transcript, "hold on");

  runtime.receiveTranscript({ text: "continue", status: "final_turn", source: "typed-test" });
  const resume = runtime.state.speech.find((speech) => speech.usefulness === "resume_control");
  assert.ok(resume);
  assert.match(resume.text, /may not know exactly where you stopped hearing me/i);
  assert.equal(runtime.state.speech.find((speech) => speech.id === "sp_old").status, "cancelled");
});

test("snapshot and repeat filters retain salient context beyond recent window", () => {
  const runtime = runtimeForUnitTests();
  runtime.state.inputVersion = 1;
  runtime.commitUserTranscript("The person is dead and worked in technology.", "typed-test");
  for (let i = 0; i < 14; i += 1) {
    runtime.state.conversation.push({ role: "user", content: `small turn ${i}`, inputVersion: i + 2, turnId: `t_${i}` });
  }

  const snapshot = runtime.snapshot("respond");
  assert.equal(snapshot.conversation.some((entry) => /dead and worked in technology/i.test(entry.content || "")), false);
  assert.equal(snapshot.retainedContext.olderSalientTurns.some((entry) => /dead and worked in technology/i.test(entry.content || "")), true);
  assert.equal(runtime.hasQuestionAnsweredByHistory("Is the person still alive?"), true);
  assert.equal(runtime.hasQuestionAnsweredByHistory("Did this person work in technology?"), true);
  assert.equal(runtime.hasQuestionAnsweredByHistory("Is this person a founder or an engineer in the tech industry?"), false);
});
