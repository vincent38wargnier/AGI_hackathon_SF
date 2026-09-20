import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { communicate, decideBridgeAcknowledgement, streamSpeech, webSearch, classifyTurnCompletion, semanticEndpointAvailable } from "./openaiProvider.js";
import { config } from "./config.js";
import { runClaudeTask } from "./claudeEngine.js";
import { searchCorpus } from "./corpus.js";
import { searchRag, refreshIndex, listDocuments } from "./ragStore.js";
import { makeTimelineEvent, nowMs } from "./telemetry.js";

const TRACE_DIR = path.resolve(process.cwd(), "artifacts/private-traces");
const TRACE_RETENTION_FILES = 30;
const BRIDGE_FALLBACK_DELAY_MS = 900;
// Playback confirmations come from the browser; if the page reloads or the tab
// dies mid-playback, /api/played never arrives and the unit would block respond
// wakeups forever. Reap limits below bound that stall.
const PLAYBACK_CONFIRM_STALE_MS = 15000;
const UNPLAYED_SPEECH_STALE_MS = 30000;
const PLAYBACK_STALL_RETRY_MS = 3000;
const PCM_BYTES_PER_MS = 48; // 24kHz 16-bit mono

function wordSetJaccard(a, b) {
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").split(/\s+/).filter(Boolean);
  const A = new Set(norm(a));
  const B = new Set(norm(b));
  let n = 0;
  for (const w of A) if (B.has(w)) n += 1;
  return n / Math.max(A.size, B.size, 1);
}

export class SessionRuntime extends EventEmitter {
  constructor({ communicateFn = communicate, bridgeDecisionFn = decideBridgeAcknowledgement, endpointClassifierFn = classifyTurnCompletion } = {}) {
    super();
    fs.mkdirSync(TRACE_DIR, { recursive: true });
    this.communicate = communicateFn;
    this.decideBridgeAcknowledgement = bridgeDecisionFn;
    this.classifyTurnCompletion = endpointClassifierFn;
    this.endpointHold = null;
    this.endpointClassCache = new Map();
    this.pendingClaudeTask = null;
    this.lastEndpointWarm = 0;
    this.state = {
      sessionId: nanoid(),
      turnId: nanoid(),
      transcriptRevision: 0,
      inputVersion: 0,
      knowledgeVersion: 0,
      generationEpoch: 0,
      floor: "awaiting_user",
      finalizedTranscript: "",
      provisionalTranscript: "",
      conversation: [],
	      jobs: new Map(),
	      evidence: new Map(),
	      speech: [],
	      preparedSpeech: null,
	      invocationInFlight: false,
	      planInFlight: false,
	      respondInFlight: false,
      pendingWakeup: false,
      mode: "live",
      webEnabled: true,
	      awaitingUser: false,
	      pausedConversation: null,
	      resumeIntentText: null,
	      currentTurnAssistantCount: 0,
	      currentTurnUserCommitted: false,
	      currentUserConversationIndex: null,
	      durableMemory: createDurableMemory(),
	      trace: [],
      metrics: {
        unsupported: [],
        speculativeJobs: 0,
        wastedJobs: 0,
        noSearchReasons: [],
        latencySamples: [],
        acousticEnds: [],
        cancelledPreparations: 0,
        interruptionReactions: [],
        qualityCounters: {
          missedAnswers: 0,
          ignoredConstraints: 0,
          duplicatedQuestions: 0,
          staleAudio: 0,
          researchUsed: 0,
        },
      },
      faults: { local_rag: {}, web: {} },
	    };
    this.privateTraceFile = this.traceFileForSession(this.state.sessionId);
    this.partialTimer = null;
		    this.ttsControllers = new Map();
		    this.speechAudioCache = new Map();
		    this.audioWarmQueue = [];
		    this.audioWarmInFlight = 0;
		    this.audioWarmPreloaded = false;
		    this.contextWarmInputVersions = new Set();
		    this.suppressedAnsweredQuestions = new Set();
		    this.bridgeTimer = null;
		    this.bridgeAbortController = null;
		    this.bridgeDecisionInputVersions = new Set();
		    this.deferredBridgeBlockedDecision = null;
		    this.modelAbortControllers = { plan: null, respond: null };
		    this.modelInvocationSeq = 0;
		    this.playbackStallTimer = null;
		    this.lastBridgeAcknowledgement = { text: "", at: Number.NEGATIVE_INFINITY };
		    this.lastListenerAcknowledgement = { text: "", at: Number.NEGATIVE_INFINITY, turnId: "" };
	  }

  view() {
    return {
      ...this.state,
      jobs: [...this.state.jobs.values()],
      evidence: [...this.state.evidence.values()],
    };
  }

  emitState() {
    this.emit("state", this.view());
  }

  isCurrentSession(sessionId) {
    return Boolean(sessionId) && sessionId === this.state.sessionId;
  }

  event(type, label, data = {}) {
    const event = makeTimelineEvent(type, label, data);
    this.state.trace.push(event);
    if (this.state.trace.length > 500) this.state.trace.shift();
    this.persistTraceEvent(event);
    this.emit("timeline", event);
    return event;
  }

  traceFileForSession(sessionId) {
    return path.join(TRACE_DIR, `${sessionId}.jsonl`);
  }

  persistTraceEvent(event) {
    const scrubbed = scrubTraceEvent(event);
    fs.appendFile(this.privateTraceFile, `${JSON.stringify(scrubbed)}\n`, () => {});
  }

  pruneTraceFiles() {
    fs.readdir(TRACE_DIR, (error, files) => {
      if (error) return;
      const jsonl = files.filter((file) => file.endsWith(".jsonl"));
      if (jsonl.length <= TRACE_RETENTION_FILES) return;
      const entries = jsonl
        .map((file) => {
          try {
            return { file, mtimeMs: fs.statSync(path.join(TRACE_DIR, file)).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of entries.slice(0, Math.max(0, entries.length - TRACE_RETENTION_FILES))) {
        fs.rm(path.join(TRACE_DIR, entry.file), { force: true }, () => {});
      }
    });
  }

  setMode(mode) {
    this.state.mode = mode === "sequential" ? "sequential" : "live";
    this.event("config", `Scheduling mode: ${this.state.mode}`);
    this.emitState();
  }

  setWebEnabled(enabled) {
    this.state.webEnabled = Boolean(enabled);
    this.event("config", `Public web search ${this.state.webEnabled ? "enabled" : "disabled"}`);
    this.emitState();
  }

  async refreshRag() {
    const started = nowMs();
    const summary = await refreshIndex();
    this.event("rag", "Local RAG index refreshed", { ...summary, durationMs: nowMs() - started });
    this.emitState();
    return summary;
  }

  async documents() {
    return listDocuments();
  }

  setFaults(faults = {}) {
    this.state.faults = {
      local_rag: normalizeFault(faults.local_rag),
      web: normalizeFault(faults.web),
    };
    this.event("config", "Fault injection updated", this.state.faults);
    this.emitState();
  }

	  reset() {
	    clearTimeout(this.partialTimer);
	    this.clearBridgeAcknowledgement("session reset");
	    this.abortTts();
    const mode = this.state.mode;
    const webEnabled = this.state.webEnabled;
	    this.state = {
      sessionId: nanoid(),
      turnId: nanoid(),
      transcriptRevision: 0,
      inputVersion: 0,
      knowledgeVersion: 0,
      generationEpoch: 0,
      floor: "awaiting_user",
      finalizedTranscript: "",
      provisionalTranscript: "",
      conversation: [],
	      jobs: new Map(),
	      evidence: new Map(),
	      speech: [],
	      preparedSpeech: null,
	      invocationInFlight: false,
	      planInFlight: false,
	      respondInFlight: false,
      pendingWakeup: false,
      mode,
      webEnabled,
	      awaitingUser: false,
	      pausedConversation: null,
	      resumeIntentText: null,
	      currentTurnAssistantCount: 0,
	      currentTurnUserCommitted: false,
	      currentUserConversationIndex: null,
	      durableMemory: createDurableMemory(),
	      trace: [],
	      metrics: {
	        unsupported: [],
	        speculativeJobs: 0,
	        wastedJobs: 0,
	        noSearchReasons: [],
	        latencySamples: [],
	        acousticEnds: [],
	        cancelledPreparations: 0,
	        interruptionReactions: [],
	        qualityCounters: { missedAnswers: 0, ignoredConstraints: 0, duplicatedQuestions: 0, staleAudio: 0, researchUsed: 0 },
	      },
	      faults: { local_rag: {}, web: {} },
		    };
		    this.privateTraceFile = this.traceFileForSession(this.state.sessionId);
		    this.pruneTraceFiles();
		    this.ttsControllers = new Map();
		    this.speechAudioCache = new Map();
		    this.audioWarmQueue = [];
		    this.audioWarmInFlight = 0;
		    this.audioWarmPreloaded = false;
		    this.contextWarmInputVersions = new Set();
		    this.suppressedAnsweredQuestions = new Set();
		    this.bridgeTimer = null;
		    this.bridgeAbortController = null;
		    this.bridgeDecisionInputVersions = new Set();
		    this.deferredBridgeBlockedDecision = null;
		    this.modelAbortControllers = { plan: null, respond: null };
		    this.clearEndpointHold("session reset");
		    this.lastBridgeAcknowledgement = { text: "", at: Number.NEGATIVE_INFINITY };
		    this.lastListenerAcknowledgement = { text: "", at: Number.NEGATIVE_INFINITY, turnId: "" };
		    this.event("session", "Session reset for isolated scenario");
    this.emitState();
  }

  receiveTranscript({ text, status, source = "voice", turnId = null }) {
    let clean = String(text || "").trim();
    if (this.endpointHold && clean) {
      clean = this.mergeHeldTranscript(clean);
      if (status === "interim") {
        // user audibly resumed: the hold is no longer dead air, so restart the
        // anti-hang budget (the ceiling bounds silent waiting, not speech)
        this.endpointHold.sinceMono = nowMs();
        clearTimeout(this.endpointHold.timer);
        this.endpointHold.timer = this.armEndpointCeiling(this.endpointHold.sinceMono);
      }
    }
    if (!clean || (status === "interim" && clean === this.state.provisionalTranscript)) return;
	    this.state.transcriptRevision += 1;
	    this.state.inputVersion += 1;
	    if (status === "interim") {
	      if (isExplicitHoldRequest(clean)) this.clearBridgeAcknowledgement("user asked to wait");
	      if (this.state.currentTurnUserCommitted && this.state.floor !== "user_speaking") {
	        this.advanceConversationTurn();
	      }
	      this.state.floor = "user_speaking";
      this.state.awaitingUser = false;
      this.state.currentTurnAssistantCount = 0;
      this.state.provisionalTranscript = clean;
      this.event("transcript", `Interim transcript r${this.state.transcriptRevision}`, { text: clean, source });
      this.maybeCommitListenerAcknowledgement(clean);
      this.startObviousSearches(clean);
      this.prepareFastConversationSpeech(clean);
      if (this.state.mode === "live" && canPlanFromPartial(clean)) this.schedulePartialPlan();
	    } else if (this.shouldSemanticHold(source)) {
	      this.evaluateSemanticEndpoint(clean, source, turnId);
	      return;
	    } else {
	      if (this.endpointHold) this.clearEndpointHold("final commit");
	      this.finalizeUserTurn(clean, source, turnId);
	      return;
	    }
    this.emitState();
  }

  finalizeUserTurn(clean, source, turnId) {
	      this.state.floor = "end_candidate";
	      this.state.awaitingUser = false;
	      this.state.currentTurnAssistantCount = 0;
	      this.state.finalizedTranscript = clean;
	      if (!(isExplicitContinueRequest(clean) && this.state.pausedConversation)) this.state.resumeIntentText = null;
		      this.state.provisionalTranscript = "";
	      this.commitUserTranscript(clean, source, turnId);
	      this.cancelIncompatibleUnheardSpeech(clean);
	      this.cancelIrrelevantUnheardSpeech(clean);
	      this.retireIrrelevantEvidence(clean);
	      this.event("transcript", `Final transcript r${this.state.transcriptRevision}`, { text: clean, source });
	      this.warmContextualAcknowledgements(clean);
	      if (this.handleConversationControl(clean)) return this.emitState();
      const startedSearch = this.startObviousSearches(clean);
	      if (isExplicitDismissalRequest(clean) && this.commitFastFinalSpeech(clean)) return this.emitState();
	      if (this.commitRepairClarification(clean)) return this.emitState();
	      if (
	        !this.commitEvidenceBackedFastSpeech(clean) &&
	        !this.releasePreparedSpeech({ onlyReady: true }) &&
	        !this.commitFastFinalSpeech(clean) &&
	        !this.commitResearchBridgeQuestion(clean, startedSearch) &&
	        !this.releasePreparedSpeech()
	      ) {
	        this.wakeup("respond");
	        this.scheduleBridgeAcknowledgement({ reason: startedSearch ? "search-pending" : "model-pending", inputVersion: this.state.inputVersion });
	      }
    this.emitState();
  }


  // ---- Semantic endpointer (SEMANTIC_ENDPOINT=on): hold the floor through
  // mid-thought pauses instead of stealing the turn. Fail-open by design:
  // classifier timeout/error/AMBIGUOUS behaves exactly like baseline.

  shouldSemanticHold(source) {
    return semanticEndpointAvailable() && String(source || "").startsWith("voice");
  }

  mergeHeldTranscript(clean) {
    const frag = String(this.endpointHold?.fragment || "").trim();
    if (!frag) return clean;
    const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
    const nf = norm(frag);
    const nc = norm(clean);
    if (!nf) return clean;
    if (nc === nf) return clean.length >= frag.length ? clean : frag;
    if (nc.startsWith(nf)) return clean; // re-delivery of same utterance with more words
    if (nf.startsWith(nc)) return frag; // shorter re-delivery
    return frag + " " + clean; // continuation spoken after the pause
  }

  // One in-flight classification per utterance text; the call is NOT aborted at
  // the race deadline so a late result stays usable (re-deliveries hit the
  // cache, and a late COMPLETE can promote a heuristically-held fragment).
  classifyCached(clean) {
    const key = String(clean).toLowerCase().replace(/\s+/g, " ").trim();
    const now = nowMs();
    let entry = this.endpointClassCache.get(key);
    if (!entry || now - entry.at > 15000) {
      entry = {
        at: now,
        promise: this.classifyTurnCompletion({
          transcript: clean,
          context: this.state.conversation.slice(-2).map((m) => ({ role: m.role, text: String(m.content || "").slice(0, 200) })),
        }).catch((error) => ({ verdict: null, error: String(error.message || error) })),
      };
      this.endpointClassCache.set(key, entry);
      if (this.endpointClassCache.size > 16) {
        const oldest = [...this.endpointClassCache.keys()][0];
        this.endpointClassCache.delete(oldest);
      }
    }
    return entry;
  }

  // Cheap local fallback when the classifier misses the race: obvious
  // mid-thought fragments must HOLD, everything else commits (fail-safe).
  heuristicTurnVerdict(text) {
    const t = String(text || "").trim();
    if (!t) return { verdict: "COMMIT", reason: "empty" };
    if (/[,:;\-–]$/.test(t)) return { verdict: "INCOMPLETE", reason: "trailing comma/connector" };
    const words = t.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim().split(" ");
    const last = words[words.length - 1] || "";
    const TAIL = new Set(["and", "or", "but", "so", "because", "if", "when", "while", "that", "which", "to", "for", "with", "of", "in", "on", "at", "the", "a", "an", "my", "our", "your", "their", "his", "her", "i", "want", "need", "like", "make", "build", "create", "is", "are", "was", "be", "can", "could", "should", "would", "et", "ou", "mais", "donc", "que", "qui", "quoi", "pour", "avec", "de", "dans", "sur", "le", "la", "les", "un", "une", "mon", "ma", "mes", "notre", "votre", "je", "veux", "voudrais", "faut", "peux", "est", "sont", "faire"]);
    if (TAIL.has(last)) return { verdict: "INCOMPLETE", reason: `trailing "${last}"` };
    const SHORT_COMPLETE = new Set(["yes", "no", "yeah", "yep", "nope", "ok", "okay", "sure", "thanks", "merci", "oui", "non", "exactement", "parfait", "stop"]);
    if (words.length < 4 && !/[.!?]$/.test(t) && !words.some((w) => SHORT_COMPLETE.has(w))) {
      return { verdict: "INCOMPLETE", reason: "short fragment, no terminal punctuation" };
    }
    return { verdict: "COMMIT", reason: "no fragment signal" };
  }

  async evaluateSemanticEndpoint(clean, source, turnId) {
    const holdStart = this.endpointHold?.sinceMono ?? nowMs();
    const entryVersion = this.state.inputVersion;
    this.state.floor = "end_candidate";
    this.state.provisionalTranscript = clean;
    this.emitState();
    let verdict = "AMBIGUOUS";
    let elapsedMs = null;
    let viaHeuristic = null;
    let cacheEntry = null;
    const budgetLeftMs = config.endpointMaxHoldMs - (nowMs() - holdStart);
    if (budgetLeftMs > config.endpointTimeoutMs) {
      cacheEntry = this.classifyCached(clean);
      const result = await Promise.race([
        cacheEntry.promise,
        new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), config.endpointTimeoutMs)),
      ]);
      if (result === "TIMEOUT" || !result?.verdict) {
        const h = this.heuristicTurnVerdict(clean);
        viaHeuristic = h.reason;
        verdict = h.verdict === "INCOMPLETE" ? "INCOMPLETE" : "AMBIGUOUS";
        this.event("transcript", `Semantic endpoint classifier ${result === "TIMEOUT" ? "slow" : "failed"}; heuristic ${h.verdict === "INCOMPLETE" ? "holds fragment" : "allows commit"}`, {
          heuristic: h.reason,
          timeoutMs: config.endpointTimeoutMs,
          error: result?.error || null,
        });
      } else {
        verdict = result.verdict;
        elapsedMs = result.elapsedMs;
      }
    } else {
      this.event("transcript", "Semantic endpoint hold budget exhausted; committing", { heldMs: Math.round(nowMs() - holdStart) });
    }
    if (this.state.inputVersion !== entryVersion) {
      clearTimeout(this.endpointHold?.timer);
      this.endpointHold = { fragment: clean, sinceMono: holdStart, source, turnId, timer: this.armEndpointCeiling(holdStart) };
      this.event("transcript", "Semantic endpoint verdict superseded by newer speech; fragment held", { verdict, elapsedMs });
      return;
    }
    this.event("transcript", `Semantic endpoint verdict ${verdict}`, { elapsedMs, heldMs: Math.round(nowMs() - holdStart), text: clean.slice(0, 120), source, heuristic: viaHeuristic });
    if (verdict === "INCOMPLETE" && (nowMs() - holdStart) + 1200 < config.endpointMaxHoldMs) {
      clearTimeout(this.endpointHold?.timer);
      this.endpointHold = { fragment: clean, sinceMono: holdStart, source, turnId, timer: this.armEndpointCeiling(holdStart) };
      this.emitState();
      // heuristic hold: if the real classifier lands later and says COMPLETE,
      // promote the held fragment instead of waiting for the ceiling
      if (viaHeuristic && cacheEntry) {
        cacheEntry.promise.then((late) => {
          const hold = this.endpointHold;
          if (!hold || hold.fragment !== clean) return;
          if (this.state.inputVersion !== entryVersion) return;
          if (late?.verdict === "COMPLETE") {
            this.event("transcript", "Semantic endpoint late verdict COMPLETE; committing held fragment", { elapsedMs: late.elapsedMs });
            this.clearEndpointHold("late COMPLETE");
            this.finalizeUserTurn(clean, source, turnId);
          }
        }).catch(() => {});
      }
      return;
    }
    this.clearEndpointHold("verdict " + verdict);
    this.finalizeUserTurn(clean, source, turnId);
  }

  armEndpointCeiling(holdStart) {
    const remainingMs = Math.max(250, config.endpointMaxHoldMs - (nowMs() - holdStart));
    return setTimeout(() => {
      const hold = this.endpointHold;
      if (!hold) return;
      if (this.state.floor === "user_speaking") return; // continuation in flight; its final will merge
      this.endpointHold = null;
      this.event("transcript", "Semantic endpoint hold ceiling reached; committing held turn", { heldMs: Math.round(nowMs() - hold.sinceMono), text: String(hold.fragment).slice(0, 120) });
      this.finalizeUserTurn(hold.fragment, hold.source || "voice", hold.turnId || null);
    }, remainingMs);
  }

  clearEndpointHold(_reason) {
    if (!this.endpointHold) return;
    clearTimeout(this.endpointHold.timer);
    this.endpointHold = null;
  }

  receiveSilenceCheck() {
    if (this.state.floor !== "awaiting_user" && this.state.floor !== "user_speaking") return;
    if (this.state.speech.some((s) => s.kind === "silence_check" && !["cancelled", "failed"].includes(s.status))) return;
    this.state.inputVersion += 1;
    this.state.floor = "end_candidate";
	    this.state.awaitingUser = false;
	    this.state.finalizedTranscript = "The user stayed silent after the call opened. Offer one brief check-in and then leave space; do not nudge repeatedly.";
	    this.commitUserTranscript(this.state.finalizedTranscript, "browser-vad");
	    this.event("transcript", "Silence check requested after quiet mic", { source: "browser-vad" });
    const ctx = {
      mode: "silence-check",
      epoch: this.state.generationEpoch,
      inputVersion: this.state.inputVersion,
      knowledgeVersion: this.state.knowledgeVersion,
      sessionId: this.state.sessionId,
    };
    this.commitSpeech("Still with me?", ctx, [], { kind: "silence_check", yieldsFloor: true, continueAfterPlayback: false });
    this.state.floor = "awaiting_user";
    this.state.awaitingUser = true;
    this.emitState();
  }

  schedulePartialPlan() {
    if (this.state.planInFlight) {
      this.state.pendingWakeup = true;
      return;
    }
    clearTimeout(this.partialTimer);
    const hasPrepared = this.state.preparedSpeech && !["cancelled", "failed"].includes(this.state.preparedSpeech.status);
    const delayMs = hasPrepared ? 220 : 80;
    this.partialTimer = setTimeout(() => this.wakeup("plan"), delayMs);
  }

	  snapshot(mode) {
    const rawCurrentTranscript = this.state.provisionalTranscript || this.state.finalizedTranscript;
    const currentTranscript = mode === "respond" && this.state.resumeIntentText && isExplicitContinueRequest(rawCurrentTranscript)
      ? this.state.resumeIntentText
      : rawCurrentTranscript;
    const playedEvidenceIds = new Set(this.state.speech
      .filter((s) => s.status === "played")
      .flatMap((s) => s.evidenceIds || []));
    const unspokenEvidence = [...this.state.evidence.values()]
      .filter((ev) => ev.state === "eligible" && !playedEvidenceIds.has(ev.id))
      .map(({ id, source, title, content, sourceUrl, fileName, chunkIndex }) => ({ id, source, title, content, sourceUrl, fileName, chunkIndex }));
    const pendingOptionalJobs = [...this.state.jobs.values()]
      .filter((job) => !job.required && ["scheduled", "running"].includes(job.status))
      .map(({ id, source, query }) => ({ id, source, query }));
	    return {
      mode,
      floor: this.state.floor,
      schedulingMode: this.state.mode,
      currentTranscript,
      finalizedTranscript: this.state.finalizedTranscript,
      resumeIntentText: this.state.resumeIntentText || "",
      inputVersion: this.state.inputVersion,
      knowledgeVersion: this.state.knowledgeVersion,
      generationEpoch: this.state.generationEpoch,
	      heardSpeech: this.state.speech.filter((s) => s.status === "played").map((s) => s.text).join(" "),
	      conversation: this.state.conversation.slice(-12),
	      retainedContext: this.retainedConversationContext(),
	      durableMemory: this.state.durableMemory,
      jobs: [...this.state.jobs.values()].map(({ id, source, query, status, required }) => ({ id, source, query, status, required })),
	      evidence: [...this.state.evidence.values()]
	        .filter((ev) => ev.state === "eligible")
	        .map(({ id, source, title, content, sourceUrl, fileName, chunkIndex }) => ({ id, source, title, content, sourceUrl, fileName, chunkIndex })),
	      unspokenEvidence,
	      pendingOptionalJobs,
	      webEnabled: this.state.webEnabled,
	      awaitingUser: this.state.awaitingUser,
	      instruction: mode === "plan"
        ? "Return start_search actions when the partial implies a useful query. Also prepare_response as soon as you can make the next turn useful without guessing; it will be released only after turn end and invalidated on correction. Prefer an acknowledgement plus one easy question when evidence is not ready."
        : "Return one concise supported speech unit, a start_search action, or one useful clarification. If optional work is still running but available evidence supports a helpful partial answer, speak the partial answer now without pretending the pending evidence is known. If unspoken public evidence arrives after a local answer was heard, the next speech must add an actual sourced fact and explain whether it changes or merely reinforces the recommendation.",
	    };
	  }

  async wakeup(reason) {
    if (this.state.pausedConversation) {
      this.state.pendingWakeup = true;
      this.event("model", "Wakeup deferred while conversation is explicitly paused", { reason });
      return;
    }
    const mode = reason === "plan" ? "plan" : "respond";
    if (mode === "plan" && !["user_speaking", "end_candidate"].includes(this.state.floor)) return;
    if (mode === "respond" && this.endpointHold) return; // semantic endpointer holds the floor for the user
    if (mode === "respond" && this.hasResponseBlockingUnplayedSpeech()) {
      this.reapStalePlaybackUnits();
      if (this.hasResponseBlockingUnplayedSpeech()) {
        this.schedulePlaybackStallRetry(reason);
        return;
      }
    }
    if ((mode === "plan" && (this.state.planInFlight || this.state.respondInFlight)) || (mode === "respond" && this.state.respondInFlight)) {
      this.abortObsoleteModelInvocation(mode);
      this.state.pendingWakeup = true;
      return;
    }
    this.state[mode === "plan" ? "planInFlight" : "respondInFlight"] = true;
    this.state.invocationInFlight = this.state.planInFlight || this.state.respondInFlight;
    const epoch = this.state.generationEpoch;
    const inputVersion = this.state.inputVersion;
    const knowledgeVersion = this.state.knowledgeVersion;
    const sessionId = this.state.sessionId;
    const snapshot = this.snapshot(mode);
    const controller = new AbortController();
    const invocationSeq = ++this.modelInvocationSeq;
    this.modelAbortControllers[mode] = { controller, inputVersion, epoch, invocationSeq };
    this.event("model", `Communicator ${mode} started`, { inputVersion, epoch, snapshot });
    this.emitState();
    try {
      const result = await this.communicate({ mode, snapshot, signal: controller.signal });
      this.event("model", `Communicator ${mode} completed`, { elapsedMs: result.elapsedMs, model: result.model, responseId: result.responseId, inputVersion, epoch });
      this.applyDecision(result.decision, { mode, epoch, inputVersion, knowledgeVersion, sessionId, responseId: result.responseId, model: result.model });
    } catch (error) {
      if (error.name === "AbortError") {
        this.event("model", `Communicator ${mode} aborted for newer input`, { inputVersion, currentInputVersion: this.state.inputVersion });
      } else {
        this.event("error", `Model ${mode} failed`, { message: error.message });
      }
    } finally {
      if (this.modelAbortControllers[mode]?.invocationSeq === invocationSeq) this.modelAbortControllers[mode] = null;
      this.state[mode === "plan" ? "planInFlight" : "respondInFlight"] = false;
      this.state.invocationInFlight = this.state.planInFlight || this.state.respondInFlight;
      const pending = this.state.pendingWakeup;
      this.state.pendingWakeup = false;
      this.emitState();
      if (pending) this.wakeup(this.state.floor === "user_speaking" && this.state.mode === "live" ? "plan" : "respond");
    }
  }

  abortObsoleteModelInvocation(requestedMode) {
    const modes = requestedMode === "respond" ? ["respond"] : ["plan", "respond"];
    for (const mode of modes) {
      const active = this.modelAbortControllers?.[mode];
      if (!active || active.controller.signal.aborted) continue;
      if (active.epoch !== this.state.generationEpoch || active.inputVersion < this.state.inputVersion) {
        active.controller.abort();
        this.event("model", `Obsolete ${mode} invocation aborted`, {
          inputVersion: active.inputVersion,
          currentInputVersion: this.state.inputVersion,
          requestedMode,
        });
      }
    }
  }

  applyDecision(decision, ctx) {
    if (ctx.sessionId !== this.state.sessionId || ctx.epoch !== this.state.generationEpoch) {
      this.event("model", "Decision discarded before actions after revision", ctx);
      return;
    }
    if (this.state.pausedConversation) {
      this.state.pendingWakeup = true;
      this.event("model", "Decision deferred while conversation is explicitly paused", ctx);
      return;
    }
    const inputMoved = ctx.inputVersion !== this.state.inputVersion;
    let startedSearch = false;
    for (const action of decision.actions || []) {
      if (action.type === "start_search" && (!inputMoved || action.source === "claude_task" || this.isQueryCompatible(action.query))) {
        this.startSearch(action.source, action.query, Boolean(action.required), { ...ctx, inputVersion: this.state.inputVersion, originalInputVersion: ctx.inputVersion, toolCallId: action.toolCallId });
        startedSearch = true;
      } else if (action.type === "start_search") {
        this.event("model", "Model-selected search discarded as incompatible with newer speech", { query: action.query, source: action.source, responseId: ctx.responseId, originalInputVersion: ctx.inputVersion, currentInputVersion: this.state.inputVersion });
      }
      if (action.type === "wait") this.event("model", "Communicator chose to wait", { reason: action.query, responseId: ctx.responseId, inputVersion: ctx.inputVersion });
    }
    if (ctx.mode === "respond" && startedSearch && !decision.speech && !decision.clarification) {
      this.event("model", "Search-only response requeued for nonblocking speech", { inputVersion: ctx.inputVersion });
      if (!this.hasEligibleEvidenceForInput(ctx.inputVersion) && !this.hasUnplayedSpeech()) {
        const fallback = this.nonblockingFallbackQuestion();
        if (fallback) {
          this.commitSpeech(fallback, ctx, [], { kind: "clarification", usefulness: "contextual_question", yieldsFloor: true });
          this.state.floor = "awaiting_user";
          this.state.awaitingUser = true;
          this.emitState();
          return;
        }
      }
      queueMicrotask(() => this.wakeup("respond"));
    }
	    if (ctx.mode === "plan") {
	      if (this.state.floor !== "user_speaking") {
	        if (this.applyLatePlanDecision(decision, ctx)) return;
	        this.event("model", "Prepared speech discarded because user turn already ended", { inputVersion: ctx.inputVersion, currentInputVersion: this.state.inputVersion });
	        return;
	      }
	      if (decision.preparedClarification) {
	        this.prepareSpeech(decision.preparedClarification, ctx, [], { kind: "clarification", yieldsFloor: true, continueAfterPlayback: false });
	      }
	      if (decision.preparedSpeech) {
	        const selected = Array.isArray(decision.preparedEvidenceIds) && decision.preparedEvidenceIds.length ? new Set(decision.preparedEvidenceIds) : null;
	        const evidenceIds = this.selectEvidenceIds(selected);
	          this.prepareSpeech(decision.preparedSpeech, ctx, evidenceIds, { kind: "answer", continueAfterPlayback: true });
	      }
	      if (!decision.preparedClarification && !decision.preparedSpeech && startedSearch && !this.state.preparedSpeech && !this.hasEligibleEvidenceForInput(this.state.inputVersion)) {
	        const fallback = this.nonblockingFallbackQuestion();
		        if (fallback) this.prepareSpeech(fallback, { ...ctx, inputVersion: this.state.inputVersion }, [], { kind: "clarification", usefulness: "contextual_question", yieldsFloor: true, continueAfterPlayback: false });
	      }
	      return;
	    }
    if (inputMoved) {
      this.event("speech", "Response speech discarded after input revision", ctx);
      return;
    }
	    this.clearBridgeAcknowledgement("response decision arrived");
    if (ctx.epoch !== this.state.generationEpoch || ctx.inputVersion !== this.state.inputVersion) {
      this.event("speech", "Draft discarded after revision", ctx);
      return;
    }
    if (ctx.mode === "respond" && this.hasResponseBlockingUnplayedSpeech()) {
      if (this.handleLatencyBridgeResponseConflict(decision, ctx)) return;
      if (this.hasResponseBlockingUnplayedSpeech()) {
        this.event("speech", "Respond draft discarded because another speech unit owns the floor", ctx);
        return;
      }
    }
    if (decision.clarification && !decision.speech) {
      if (!this.satisfiesRequiredCurrentTurnText(decision.clarification)) {
        this.event("speech", "Clarification discarded because it missed required current-turn text", { inputVersion: ctx.inputVersion, text: decision.clarification });
        queueMicrotask(() => this.wakeup("respond"));
        return;
      }
      const kind = this.state.finalizedTranscript.includes("stayed silent after the call opened") ? "silence_check" : "clarification";
	      this.commitSpeech(decision.clarification, ctx, [], { kind, usefulness: kind === "silence_check" ? "silence_check" : "contextual_question", yieldsFloor: true });
      this.state.floor = "awaiting_user";
      this.state.awaitingUser = true;
      this.emitState();
      return;
    }
    if (this.hasBlockingRequiredSearch(ctx.inputVersion) && !(decision.speech && decision.evidenceIds?.length)) {
      this.event("speech", "Required evidence pending, but speech proceeds nonblocking", { inputVersion: ctx.inputVersion });
    }
	    if (decision.speech) {
	      if (!this.satisfiesRequiredCurrentTurnText(decision.speech)) {
	        this.event("speech", "Response discarded because it missed required current-turn text", { inputVersion: ctx.inputVersion, text: decision.speech });
	        queueMicrotask(() => this.wakeup("respond"));
	        return;
	      }
	      const selected = Array.isArray(decision.evidenceIds) && decision.evidenceIds.length ? new Set(decision.evidenceIds) : null;
	      const evidenceIds = this.selectEvidenceIds(selected);
	      if (this.isRedundantSpeech(evidenceIds, decision.speech)) {
	        this.event("speech", "Redundant speech suppressed while awaiting distinct evidence", { inputVersion: ctx.inputVersion, evidenceIds });
	        return;
	      }
	      const hasPendingWork = this.hasPendingWebWork(ctx.inputVersion);
		      const hasUnspokenWeb = this.hasUnspokenWebEvidence(evidenceIds);
	      const shouldContinue = (hasPendingWork || hasUnspokenWeb) && this.state.currentTurnAssistantCount < 2;
	      if (this.commitSpeech(decision.speech, ctx, evidenceIds, { kind: "answer", usefulness: evidenceIds.length ? "substantive" : "useful", yieldsFloor: !shouldContinue, continueAfterPlayback: shouldContinue })) {
        this.state.floor = "assistant_turn";
      }
    }
  }

  applyLatePlanDecision(decision, ctx) {
    if (ctx.epoch !== this.state.generationEpoch || this.state.floor === "closed" || this.hasUnplayedSpeech()) return false;
    if (ctx.inputVersion !== this.state.inputVersion) return false;
    const adjustedCtx = { ...ctx, inputVersion: this.state.inputVersion };
    if (decision.preparedClarification && this.isSpeechStillRelevant(decision.preparedClarification)) {
	      this.commitSpeech(decision.preparedClarification, adjustedCtx, [], { kind: "clarification", usefulness: "contextual_question", yieldsFloor: true });
      this.state.floor = "awaiting_user";
      this.state.awaitingUser = true;
      this.emitState();
      return true;
    }
    if (!decision.preparedSpeech || !this.isSpeechStillRelevant(decision.preparedSpeech)) return false;
    const selected = Array.isArray(decision.preparedEvidenceIds) && decision.preparedEvidenceIds.length ? new Set(decision.preparedEvidenceIds) : null;
    const evidenceIds = this.selectEvidenceIds(selected);
    if (evidenceIds.length && this.isRedundantSpeech(evidenceIds, decision.preparedSpeech)) return false;
    this.event("speech", "Late plan speech accepted after turn end", { originalInputVersion: ctx.inputVersion, currentInputVersion: this.state.inputVersion });
	    this.commitSpeech(decision.preparedSpeech, adjustedCtx, evidenceIds, { kind: "answer", usefulness: evidenceIds.length ? "substantive" : "useful", continueAfterPlayback: this.hasPendingWebWork(adjustedCtx.inputVersion) });
    this.state.floor = "assistant_turn";
    return true;
  }

	  commitFastFinalSpeech(text) {
	    const speech = this.fastConversationSpeech(text);
	    if (!speech) return false;
	    if (isExplicitDismissalRequest(text) && this.hasRecentClosure()) {
	      this.event("speech", "Repeated closure suppressed after explicit dismissal", { text });
	      this.state.floor = "closed";
	      this.state.awaitingUser = false;
	      return true;
	    }
	    if (this.state.speech.some((unit) => unit.text === speech && !["cancelled", "failed"].includes(unit.status))) {
	      this.event("speech", "Duplicate fast speech suppressed", { text: speech });
	      return true;
	    }
	    const ctx = {
      mode: "fast",
      epoch: this.state.generationEpoch,
      inputVersion: this.state.inputVersion,
      knowledgeVersion: this.state.knowledgeVersion,
      sessionId: this.state.sessionId,
    };
    const kind = /leave it there|step back|won't push/i.test(speech) ? "closure" : "clarification";
	    this.commitSpeech(speech, ctx, [], { kind, usefulness: kind === "closure" ? "refusal_control" : "contextual_question", yieldsFloor: true });
    this.state.floor = "awaiting_user";
    this.state.awaitingUser = kind !== "closure";
    if (kind === "closure") this.state.floor = "closed";
    this.emitState();
    return true;
	  }

	  commitRepairClarification(text) {
	    const speech = repairClarificationFor(text, this.state.conversation);
	    if (!speech) return false;
	    const ctx = {
	      mode: "repair",
	      epoch: this.state.generationEpoch,
	      inputVersion: this.state.inputVersion,
	      knowledgeVersion: this.state.knowledgeVersion,
	      sessionId: this.state.sessionId,
	    };
	    this.cancelPreparedSpeech("Repair clarification superseded prepared draft");
	    this.commitSpeech(speech, ctx, [], { kind: "repair", usefulness: "repair", yieldsFloor: true, continueAfterPlayback: false });
	    this.state.floor = "awaiting_user";
	    this.state.awaitingUser = true;
	    return true;
	  }

	  handleConversationControl(text) {
	    if (isExplicitHoldRequest(text)) {
	      this.state.pausedConversation = {
	        at: new Date().toISOString(),
	        inputVersion: this.state.inputVersion,
	        transcript: text,
	        currentIntent: this.currentUserIntentText(),
	        interruptedSpeechId: this.latestInterruptedSpeech()?.speechId || null,
	      };
	      this.clearBridgeAcknowledgement("user asked to wait");
	      this.cancelPreparedSpeech("User asked to pause; prepared speech held out");
	      this.cancelQueuedAssistantSpeech("User asked to pause");
	      const ctx = this.currentSpeechContext("pause");
	      this.commitSpeech("Sure, I'll hold.", ctx, [], { kind: "acknowledgement", usefulness: "pause_control", yieldsFloor: true, continueAfterPlayback: false });
	      this.state.floor = "awaiting_user";
	      this.state.awaitingUser = true;
	      return true;
	    }
	    if (isExplicitContinueRequest(text) && this.state.pausedConversation) {
	      const paused = this.state.pausedConversation;
	      this.state.pausedConversation = null;
	      this.state.resumeIntentText = paused.currentIntent || null;
	      const ctx = this.currentSpeechContext("resume");
	      const hadInterruptedAudio = Boolean(paused.interruptedSpeechId || this.latestInterruptedSpeech());
	      const speech = hadInterruptedAudio
	        ? "I may not know exactly where you stopped hearing me, so I'll continue from the current thread."
	        : "Got it, I'll continue from the current thread.";
	      this.commitSpeech(speech, ctx, [], { kind: "acknowledgement", usefulness: "resume_control", yieldsFloor: false, continueAfterPlayback: true });
	      this.state.floor = "assistant_turn";
	      return true;
	    }
	    return false;
	  }

	  currentSpeechContext(mode) {
	    return {
	      mode,
	      epoch: this.state.generationEpoch,
	      inputVersion: this.state.inputVersion,
	      knowledgeVersion: this.state.knowledgeVersion,
	      sessionId: this.state.sessionId,
	    };
	  }

	  currentUserIntentText() {
	    return [...this.state.conversation].reverse().find((entry) => entry.role === "user" && !isExplicitHoldRequest(entry.content || ""))?.content || this.state.finalizedTranscript || "";
	  }

	  preparedForTranscriptFor(kind = "answer") {
	    const current = this.state.provisionalTranscript || this.state.finalizedTranscript || "";
	    if (kind === "answer" && this.state.resumeIntentText && isExplicitContinueRequest(current)) {
	      return this.state.resumeIntentText;
	    }
	    if (kind === "answer" && isKnownTaskEditingFollowup(current)) {
	      const task = recentUserTaskFromConversation(this.state.conversation, current);
	      if (task) return `${task} ${current}`;
	    }
	    return current;
	  }

	  currentTranscriptForRelevance(unit) {
	    const current = this.state.provisionalTranscript || this.state.finalizedTranscript || "";
	    if (unit?.kind === "answer" && this.state.resumeIntentText && isExplicitContinueRequest(current)) {
	      return this.state.resumeIntentText;
	    }
	    if (unit?.kind === "answer" && isKnownTaskEditingFollowup(current)) {
	      const task = recentUserTaskFromConversation(this.state.conversation, current);
	      if (task) return `${task} ${current}`;
	    }
	    return current;
	  }

	  latestInterruptedSpeech() {
	    return [...this.state.conversation].reverse().find((entry) => entry.role === "assistant" && entry.heardStatus === "interrupted") || null;
	  }

	  commitEvidenceBackedFastSpeech(text) {
	    if (hasUnderspecifiedCorrection(text)) return false;
	    const evidence = this.bestEligibleLocalEvidence(text);
	    if (!evidence) return false;
	    const sentence = bestEvidenceSentence(evidence.content, text);
	    if (!sentence) return false;
	    const speech = `${sentence} ${contextualEvidenceQuestion(text)}`.replace(/\s+/g, " ").trim();
	    if (!speech || this.state.speech.some((unit) => unit.text === speech && !["cancelled", "failed"].includes(unit.status))) return true;
	    const ctx = {
	      mode: "evidence-bridge",
	      epoch: this.state.generationEpoch,
	      inputVersion: this.state.inputVersion,
	      knowledgeVersion: this.state.knowledgeVersion,
	      sessionId: this.state.sessionId,
	    };
	    this.cancelPreparedSpeech("Evidence-backed fast speech superseded prepared draft");
	    const shouldContinue = this.hasPendingWebWork(this.state.inputVersion);
	    this.commitSpeech(speech, ctx, [evidence.id], {
	      kind: "answer",
	      usefulness: "substantive",
	      yieldsFloor: !shouldContinue,
	      continueAfterPlayback: shouldContinue,
	    });
	    this.state.floor = "assistant_turn";
	    this.emitState();
	    return true;
	  }

	  cancelPreparedSpeech(reason) {
	    const prepared = this.state.preparedSpeech;
	    if (!prepared || ["cancelled", "failed", "played"].includes(prepared.status)) return;
	    prepared.status = "cancelled";
	    this.state.metrics.cancelledPreparations += 1;
	    this.ttsControllers.get(prepared.id)?.abort();
	    this.ttsControllers.delete(prepared.id);
	    this.emit("audio", { event: "cancel", speechId: prepared.id });
	    this.state.preparedSpeech = null;
	    this.event("speech", reason, { speechId: prepared.id, text: prepared.text });
	  }

	  cancelQueuedAcknowledgements(reason) {
	    this.clearBridgeAcknowledgement(reason);
	    for (const unit of this.state.speech) {
	      if (unit.kind !== "acknowledgement") continue;
	      if (["played", "failed", "cancelled", "playing"].includes(unit.status)) continue;
	      unit.status = "cancelled";
	      this.ttsControllers.get(unit.id)?.abort();
	      this.ttsControllers.delete(unit.id);
	      this.emit("audio", { event: "cancel", speechId: unit.id });
	      this.event("speech", "Queued acknowledgement cancelled", { speechId: unit.id, reason });
	    }
	  }

	  cancelQueuedAssistantSpeech(reason) {
	    for (const unit of this.state.speech) {
	      if (["played", "failed", "cancelled", "playing"].includes(unit.status)) continue;
	      unit.status = "cancelled";
	      this.ttsControllers.get(unit.id)?.abort();
	      this.ttsControllers.delete(unit.id);
	      this.emit("audio", { event: "cancel", speechId: unit.id });
	      this.event("speech", "Queued speech cancelled", { speechId: unit.id, reason });
	    }
	  }

	  bestEligibleLocalEvidence(text) {
	    const currentTerms = terms(text);
	    const candidates = [...this.state.evidence.values()]
	      .filter((ev) => ev.state === "eligible" && ev.source === "local_rag" && ev.originatingInputVersion <= this.state.inputVersion)
	      .map((ev) => {
	        const contentTerms = terms(`${ev.retrievedForQuery || ""} ${ev.title || ""} ${ev.content || ""}`);
	        const overlap = currentTerms.filter((term) => contentTerms.includes(term)).length;
	        return { ev, score: overlap + Number(ev.score || 0) };
	      })
	      .sort((a, b) => b.score - a.score);
	    return candidates[0]?.ev || null;
	  }

	  prepareFastConversationSpeech(text) {
    const speech = this.fastConversationSpeech(text);
    if (!speech) return;
    if (this.state.preparedSpeech) {
      const existing = this.state.preparedSpeech;
      if (existing.text === speech) return;
      if (this.fastSpeechPriority(speech) <= this.fastSpeechPriority(existing.text)) return;
      existing.status = "cancelled";
      this.ttsControllers.get(existing.id)?.abort();
      this.ttsControllers.delete(existing.id);
      this.state.preparedSpeech = null;
      this.event("speech", "Prepared speech replaced by more specific partial", { oldSpeechId: existing.id, text: speech });
    }
    const ctx = {
      mode: "fast-plan",
      epoch: this.state.generationEpoch,
      inputVersion: this.state.inputVersion,
      knowledgeVersion: this.state.knowledgeVersion,
      sessionId: this.state.sessionId,
    };
    const kind = /leave it there|step back|won't push/i.test(speech) ? "closure" : "clarification";
    this.prepareSpeech(speech, ctx, [], { kind, yieldsFloor: true, continueAfterPlayback: false });
  }

	  fastConversationSpeech(text) {
	    const normalized = String(text || "").toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();
	    if (!normalized) return "";
	    if (isExplicitDismissalRequest(normalized)) {
	      return "Understood. I'll leave it there.";
	    }
	    return "";
	  }

	  fastSpeechPriority(text) {
	    const normalized = String(text || "").toLowerCase();
	    if (/leave it there/.test(normalized)) return 100;
	    return 20;
	  }

	  hasRecentClosure() {
	    return this.state.speech.slice(-6).some((unit) => (
	      unit.kind === "closure" &&
	      !["cancelled", "failed"].includes(unit.status)
	    )) || this.state.conversation.slice(-8).some((entry) => (
	      entry.role === "assistant" &&
	      (entry.kind === "closure" || /leave it there|stop here|pause here|remain available/i.test(entry.content || ""))
	    ));
	  }

  isSpeechStillRelevant(text) {
    const currentTerms = terms(this.state.finalizedTranscript || this.state.provisionalTranscript || "");
    const speechTerms = terms(text);
    if (!currentTerms.length || !speechTerms.length) return false;
    const overlap = speechTerms.filter((term) => currentTerms.includes(term)).length / Math.min(speechTerms.length, currentTerms.length);
    return overlap >= 0.2;
  }

  satisfiesRequiredCurrentTurnText(speech) {
    const required = requiredCurrentNonLatinSpans(this.state.finalizedTranscript || this.state.provisionalTranscript || "");
    if (!required.length) return true;
    const spoken = new Set(nonLatinSpans(speech).map((span) => normalizeTranscriptForTurn(span)).filter(Boolean));
    return required.every((span) => spoken.has(normalizeTranscriptForTurn(span)));
  }

  selectEvidenceIds(selected = null) {
    const eligible = [...this.state.evidence.values()].filter((ev) => ev.state === "eligible");
    if (!selected) return eligible.map((ev) => ev.id);
    const matched = eligible.filter((ev) => selected.has(ev.id)).map((ev) => ev.id);
    return matched.length ? matched : eligible.map((ev) => ev.id);
  }

  startSearch(source, query, required = false, ctx = {}) {
    if (!query || source === "none") return;
    if (source === "knowledge" || source === "memory") source = "local_rag";
    if (source === "web" && !this.state.webEnabled) {
      this.event("job", "Public web search blocked because session switch is off", { query });
      return;
    }
    const key = `${source}:${query.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const existing = [...this.state.jobs.values()].find((j) => j.key === key && ["scheduled", "running", "done"].includes(j.status));
    if (existing) {
      this.event("job", "Duplicate search deduped", { source, query, existing: existing.id });
      return existing.id;
    }
	    if (source === "claude_task") {
	      const runningWork = [...this.state.jobs.values()].find((j) => j.source === "claude_task" && ["scheduled", "running"].includes(j.status));
	      if (runningWork) {
	        const sim = wordSetJaccard(runningWork.query, query);
	        if (sim >= 0.8) {
	          this.event("job", "Duplicate work request suppressed (already building)", { query: query.slice(0, 120), similarity: Math.round(sim * 100) / 100 });
	          return runningWork.id;
	        }
	        this.pendingClaudeTask = this.pendingClaudeTask
	          ? `${this.pendingClaudeTask}; also: ${query}`
	          : query;
	        this.event("job", "Work follow-up queued while build runs", { query: query.slice(0, 140) });
	        this.emitState();
	        return null;
	      }
	    }
	    const localRunning = [...this.state.jobs.values()].filter((j) => ["scheduled", "running"].includes(j.status) && j.source !== "web" && j.source !== "claude_task").length;
	    const webRunning = [...this.state.jobs.values()].filter((j) => ["scheduled", "running"].includes(j.status) && j.source === "web").length;
    if (source !== "web" && localRunning >= 2) {
      this.event("job", "Search deferred by concurrency cap", { source, query });
      return null;
    }
    if (source === "web" && webRunning >= 1) {
      this.event("job", "Web search deferred by concurrency cap", { query });
      return null;
    }
	    const job = {
	      id: `job_${nanoid(6)}`,
	      key,
	      source,
	      query,
	      status: "scheduled",
	      required,
      inputVersion: ctx.inputVersion ?? this.state.inputVersion,
      epoch: ctx.epoch ?? this.state.generationEpoch,
      cause: { modelMode: ctx.mode, inputVersion: ctx.inputVersion, originalInputVersion: ctx.originalInputVersion, epoch: ctx.epoch, responseId: ctx.responseId, toolCallId: ctx.toolCallId, model: ctx.model },
	    };
	    job.startedAt = new Date().toISOString();
	    job.startedMonoMs = nowMs();
	    this.state.jobs.set(job.id, job);
	    this.event("job", `${source} search scheduled`, { jobId: job.id, query, required });
	    if (this.state.floor === "user_speaking") this.state.metrics.speculativeJobs += 1;
	    this.emitState();
	    queueMicrotask(() => this.runSearch(job.id));
	    return job.id;
	  }

  startObviousSearches(text) {
    const normalized = String(text || "").toLowerCase();
    if (!normalized) {
      this.recordNoSearch("empty transcript", text);
      return false;
    }
    if (isShortFollowup(text)) {
      this.recordNoSearch("short follow-up; waiting for conversational context", text);
      return false;
    }
    const ctx = {
      mode: "scheduler",
      epoch: this.state.generationEpoch,
      inputVersion: this.state.inputVersion,
      knowledgeVersion: this.state.knowledgeVersion,
      sessionId: this.state.sessionId,
    };
    let started = false;
    if (/\b(pricing|annual|checkout|conversion|retention|onboarding|enterprise|support|security|growth|experiment)\b/i.test(normalized)) {
      started = Boolean(this.startSearch("local_rag", conciseQuery(text), false, ctx)) || started;
    }
    if (this.state.webEnabled && shouldStartPublicResearch(normalized)) {
      started = Boolean(this.startSearch("web", publicWebQuery(text), false, ctx)) || started;
    }
    if (!started) this.recordNoSearch(researchSkipReason(text, this.state.webEnabled), text);
    return started;
  }

  recordNoSearch(reason, text) {
    const entry = {
      at: new Date().toISOString(),
      inputVersion: this.state.inputVersion,
      reason,
      transcript: String(text || "").slice(0, 180),
    };
    this.state.metrics.noSearchReasons.push(entry);
    if (this.state.metrics.noSearchReasons.length > 40) this.state.metrics.noSearchReasons.shift();
    this.event("job", "No proactive search scheduled", entry);
  }

  async runSearch(jobId) {
    const job = this.state.jobs.get(jobId);
    if (!job || job.status !== "scheduled") return;
    if (!this.isJobStillRelevant(job) || this.state.floor === "closed") {
      job.status = "cancelled";
      this.state.metrics.wastedJobs += 1;
      this.event("job", `${job.source} search cancelled before start`, { jobId });
      this.emitState();
      return;
    }
	    job.status = "running";
	    if (!job.startedAt) {
	      job.startedAt = new Date().toISOString();
	      job.startedMonoMs = nowMs();
	    }
    this.event("job", `${job.source} search running`, { jobId, query: job.query, inputVersion: job.inputVersion });
    try {
      await this.applyFault(job);
      let results = [];
      if (job.source === "claude_task") {
        const work = await runClaudeTask(job.query);
        job.model = work.model;
        job.workFailed = work.failed;
        results = [{
          id: "work-1",
          source: "work",
          title: `Work result: ${job.query.slice(0, 90)}`,
          content: String(work.text || "").slice(0, 2400),
        }];
      } else if (job.source === "local_rag") results = await searchRag(job.query);
      else if (job.source === "web") {
        const web = await webSearch(job.query);
        job.responseId = web.responseId;
        job.model = web.model;
        results = web.results;
      } else {
        results = searchCorpus(job.query, job.source);
      }
      if (!this.isJobStillRelevant(job) || this.state.floor === "closed") {
        job.status = "cancelled";
        job.resultCount = results.length;
        this.state.metrics.wastedJobs += 1;
        this.event("job", `${job.source} result ignored as obsolete`, { jobId, resultCount: results.length });
        this.emitState();
        return;
      }
      this.retireConflictingEvidence(job);
      for (const result of results) {
        const ev = {
          id: `ev_${nanoid(6)}`,
          source: result.source,
          title: result.title,
          content: result.content,
          sourceId: result.sourceId || result.id,
          sourceUrl: result.sourceUrl || result.url,
          fileName: result.fileName,
          chunkIndex: result.chunkIndex,
          score: result.score,
          fetchedAt: new Date().toISOString(),
          retrievedForQuery: job.query,
          originatingInputVersion: job.inputVersion,
          state: "eligible",
          privacy: result.source === "memory" ? "private" : result.source === "web" ? "public" : "synthetic",
        };
        this.state.evidence.set(ev.id, ev);
      }
      job.status = "done";
      job.completedAt = new Date().toISOString();
      job.completedMonoMs = nowMs();
      job.durationMs = job.completedMonoMs - job.startedMonoMs;
      job.resultCount = results.length;
      this.state.knowledgeVersion += 1;
      this.event("job", `${job.source} search completed`, { jobId, resultCount: results.length, durationMs: job.durationMs });
      this.emitState();
      if (job.source === "claude_task" && this.pendingClaudeTask) {
        const queued = this.pendingClaudeTask;
        this.pendingClaudeTask = null;
        this.event("job", "Starting queued work follow-up", { query: queued.slice(0, 140) });
        this.startSearch("claude_task", queued, false, { modelMode: "queued-followup" });
      }
	      this.clearBridgeAcknowledgement("research completed");
      if (this.state.floor !== "user_speaking" && this.shouldSpeakAfterResearch(job)) this.wakeup("respond");
    } catch (error) {
      job.status = "failed";
      job.error = error.message;
      job.completedAt = new Date().toISOString();
      job.completedMonoMs = nowMs();
      job.durationMs = job.completedMonoMs - job.startedMonoMs;
      this.event("error", `${job.source} search failed`, { jobId, message: error.message, durationMs: job.durationMs });
      this.emitState();
    }
  }

  async applyFault(job) {
    const fault = this.state.faults?.[job.source];
    if (!fault) return;
    if (fault.delayMs) {
      this.event("job", `${job.source} fault delay started`, { jobId: job.id, delayMs: fault.delayMs });
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    }
    if (fault.fail) throw new Error(`Injected ${job.source} failure`);
  }

  retireConflictingEvidence(job) {
    for (const ev of this.state.evidence.values()) {
      if (ev.source === "work") continue;
      if (ev.originatingInputVersion < job.inputVersion && !this.isQueryCompatible(ev.retrievedForQuery || ev.content)) ev.state = "stale";
    }
  }

  retireIrrelevantEvidence(text) {
    const currentTerms = terms(text);
    if (currentTerms.length < 5 || isShortFollowup(text)) return;
    for (const ev of this.state.evidence.values()) {
      if (ev.source === "work") continue;
      const evTerms = terms(ev.retrievedForQuery || ev.content);
      if (evTerms.length && currentTerms.length) {
        const overlap = evTerms.filter((term) => currentTerms.includes(term)).length / evTerms.length;
        if (overlap < 0.35) ev.state = "stale";
      }
    }
  }

  isJobStillRelevant(job) {
    if (job.source === "claude_task") return true;
    if (job.inputVersion === this.state.inputVersion) return true;
    const current = this.state.provisionalTranscript || this.state.finalizedTranscript || "";
	    if (isCompatibleTranscriptRevision(job.query, current)) return true;
    const queryTerms = terms(job.query);
    const currentTerms = terms(current);
    if (currentTerms.length < 4) return true;
    if (!queryTerms.length || !currentTerms.length) return true;
    const overlap = queryTerms.filter((term) => currentTerms.includes(term)).length / queryTerms.length;
    return overlap >= 0.35;
  }

  isQueryCompatible(query) {
    const current = this.state.provisionalTranscript || this.state.finalizedTranscript || "";
	    if (isCompatibleTranscriptRevision(query, current)) return true;
    const queryTerms = terms(query);
    const currentTerms = terms(current);
    if (!queryTerms.length || !currentTerms.length) return false;
    const overlap = queryTerms.filter((term) => currentTerms.includes(term)).length / queryTerms.length;
    return overlap >= 0.35;
  }

  hasBlockingRequiredSearch(inputVersion) {
    const requiredJobs = [...this.state.jobs.values()].filter((job) => (
      job.required &&
      job.inputVersion <= inputVersion &&
      ["scheduled", "running"].includes(job.status)
    ));
    if (requiredJobs.length) return true;
    const completedRequired = [...this.state.jobs.values()].some((job) => (
      job.required &&
      job.inputVersion <= inputVersion &&
      job.status === "done"
    ));
    const eligibleEvidence = [...this.state.evidence.values()].some((ev) => (
      ev.originatingInputVersion <= inputVersion &&
      ev.state === "eligible"
    ));
    return completedRequired && !eligibleEvidence;
  }

			  hasPendingUsefulWork(inputVersion) {
			    return [...this.state.jobs.values()].some((job) => (
			      job.inputVersion <= inputVersion &&
			      this.isJobStillRelevant(job) &&
			      ["scheduled", "running"].includes(job.status)
			    ));
			  }

			  hasPendingWebWork(inputVersion) {
			    return [...this.state.jobs.values()].some((job) => (
			      job.source === "web" &&
			      job.inputVersion <= inputVersion &&
			      ["scheduled", "running"].includes(job.status)
			    ));
			  }

		  hasEligibleEvidenceForInput(inputVersion) {
		    return [...this.state.evidence.values()].some((ev) => (
		      ev.originatingInputVersion <= inputVersion &&
		      ev.state === "eligible"
		    ));
		  }

	  shouldSpeakAfterResearch(job) {
	    if (!job || job.status !== "done") return false;
	    if (this.state.awaitingUser && job.source !== "web") return false;
	    if (this.state.awaitingUser && job.source === "web") {
	      return this.hasPriorAnswerForInput(job.inputVersion) && this.hasUnspokenWebEvidence();
	    }
	    return true;
	  }

	  hasPriorAnswerForInput(inputVersion) {
	    return this.state.speech.some((s) => (
	      s.kind === "answer" &&
	      ["played", "playing", "audio_generated", "audio_streaming"].includes(s.status) &&
	      s.inputVersion <= inputVersion
	    ));
	  }

	  commitUserTranscript(text, source = "voice", targetTurnId = null) {
	    const clean = String(text || "").trim();
	    if (!clean) return;
	    if (!targetTurnId && this.state.currentTurnUserCommitted) this.advanceConversationTurn();
	    const isCurrentTurn = !targetTurnId || targetTurnId === this.state.turnId;
	    const resolvedTurnId = targetTurnId || this.state.turnId;
	    let existingIndex = isCurrentTurn ? this.state.currentUserConversationIndex : null;
	    if (!Number.isInteger(existingIndex) || existingIndex < 0) {
	      existingIndex = this.state.conversation.findLastIndex((entry) => entry.role === "user" && entry.turnId === resolvedTurnId);
	    }
	    if (Number.isInteger(existingIndex) && existingIndex >= 0) {
	      const entry = this.state.conversation[existingIndex];
	      if (entry?.role === "user") {
	        const providerFinal = !/optimistic/i.test(source);
		        if (entry.content !== clean) {
		          entry.content = clean;
		          entry.correctedByProviderFinal = providerFinal;
		          if (providerFinal) entry.providerFinalReconciled = true;
		          entry.source = source;
		          entry.inputVersion = this.state.inputVersion;
		          entry.transcriptRevision = this.state.transcriptRevision;
		          this.event("transcript", "Final transcript reconciled into existing user turn", {
	            turnId: entry.turnId,
	            source,
		            text: clean,
		          });
		        }
	        this.updateDurableMemoryFromUser(clean, entry);
	        if (providerFinal && !entry.providerFinalReconciled) {
	          entry.providerFinalReconciled = true;
	          entry.source = source;
	          entry.inputVersion = this.state.inputVersion;
	          entry.transcriptRevision = this.state.transcriptRevision;
	          this.event("transcript", "Provider final confirmed existing user turn", {
	            turnId: entry.turnId,
	            source,
	            text: clean,
	          });
	        }
		        if (isCurrentTurn) {
		          this.state.currentTurnUserCommitted = true;
		          this.state.currentUserConversationIndex = existingIndex;
		        }
		        return;
		      }
	    }
	    const entry = {
	      role: "user",
	      content: clean,
	      turnId: resolvedTurnId,
	      inputVersion: this.state.inputVersion,
	      transcriptRevision: this.state.transcriptRevision,
	      source,
	    };
	    this.state.conversation.push(entry);
	    this.updateDurableMemoryFromUser(clean, entry);
	    if (isCurrentTurn) {
	      this.state.currentTurnUserCommitted = true;
	      this.state.currentUserConversationIndex = this.state.conversation.length - 1;
	    }
	    this.event("transcript", "Final transcript committed to conversation", {
	      turnId: entry.turnId,
	      source,
	      text: clean,
	    });
	  }

	  updateDurableMemoryFromUser(text, entry) {
	    const memory = this.state.durableMemory || createDurableMemory();
	    this.state.durableMemory = memory;
	    const raw = String(text || "").trim();
	    const normalized = normalizeTranscriptForTurn(raw);
	    if (!raw || !normalized) return;
	    const item = { text: raw, turnId: entry.turnId, inputVersion: entry.inputVersion, at: new Date().toISOString() };
	    if (hasUncertainty(raw)) addBoundedMemory(memory.uncertainties, item, 12);
	    if (hasCorrection(raw)) {
	      addBoundedMemory(memory.corrections, item, 12);
	      const correctionTerms = terms(raw);
	      for (const fact of memory.facts) {
	        if (jaccard(terms(fact.text), correctionTerms) > 0.25 || /\b(actually|not|instead|rather|wrong)\b/i.test(raw)) fact.rejectedAt = item.at;
	      }
	    }
	    if (hasYesNoOnlyConstraint(raw) || /\b(only|never|always|don'?t|do not|must|constraint|requirement|rule)\b/i.test(raw)) {
	      addBoundedMemory(memory.constraints, item, 16);
	    }
	    if (hasGuessingGameContext(raw) || /\b(let'?s play|guess|game|task is|we are doing|i am thinking|my person|character)\b/i.test(raw)) {
	      memory.chosenTask = item;
	    }
	    if (!hasUncertainty(raw) && !hasCorrection(raw) && looksLikeSalientFact(raw)) {
	      addBoundedMemory(memory.facts, item, 18);
	    }
	    if (/\b(no|not|instead|rather|different|wrong)\b/i.test(raw)) addBoundedMemory(memory.rejectedAlternatives, item, 12);
	  }

		  nonblockingFallbackQuestion() {
		    const text = String(this.state.finalizedTranscript || this.state.provisionalTranscript || "").toLowerCase();
		    if (isExplicitDismissalRequest(text)) {
		      return "Understood. I'll leave it there.";
		    }
	    if (text.trim()) return this.researchBridgeQuestion(text);
	    return "";
	  }

  commitResearchBridgeQuestion(text, startedSearch) {
    const speech = startedSearch ? this.researchBridgeQuestion(text) : "";
    if (!speech) return false;
    if (this.state.speech.some((unit) => unit.text === speech && !["cancelled", "failed"].includes(unit.status))) return true;
    const ctx = {
      mode: "scheduler-bridge",
      epoch: this.state.generationEpoch,
      inputVersion: this.state.inputVersion,
      knowledgeVersion: this.state.knowledgeVersion,
      sessionId: this.state.sessionId,
    };
	    this.commitSpeech(speech, ctx, [], { kind: "clarification", usefulness: "contextual_question", yieldsFloor: true, continueAfterPlayback: false });
    this.state.floor = "awaiting_user";
    this.state.awaitingUser = true;
    this.emitState();
    return true;
  }

  researchBridgeQuestion(text) {
    const normalized = String(text || "").toLowerCase();
    if (!isBusinessResearchTopic(normalized)) return "";
    if (hasExplicitOutcome(normalized)) return "";
	    const focus = shortFocusPhrase(normalized);
	    return `For ${focus}, should I optimize for upside, risk reduction, or speed?`;
  }

		  hasUnspokenWebEvidence(currentEvidenceIds = []) {
		    const current = new Set(currentEvidenceIds || []);
		    const used = new Set(this.state.speech
		      .filter((s) => !["cancelled", "failed"].includes(s.status))
		      .flatMap((s) => s.evidenceIds || []));
		    for (const ev of this.state.evidence.values()) {
		      if (ev.state !== "eligible" || ev.source !== "web") continue;
		      if (!current.has(ev.id) && !used.has(ev.id)) return true;
		    }
		    return false;
		  }

		  hasUnplayedSpeech() {
		    return this.state.speech.some((s) => (
		      s.epoch === this.state.generationEpoch &&
		      ["drafted", "committed", "audio_streaming", "audio_generated", "playing"].includes(s.status)
		    ));
		  }

		  isListenerBackchannelSpeech(unit) {
		    return unit?.kind === "acknowledgement" && unit?.usefulness === "listener_backchannel";
		  }

		  hasResponseBlockingUnplayedSpeech() {
		    return this.currentResponseBlockingUnplayedSpeech().length > 0;
		  }

		  // Bound the browser-dependent playback states so a vanished client (page
		  // reload, tab close, phone lock) cannot deadlock respond wakeups forever.
		  reapStalePlaybackUnits() {
		    const now = nowMs();
		    let reaped = 0;
		    for (const unit of this.state.speech) {
		      if (unit.epoch !== this.state.generationEpoch) continue;
		      if (unit.status === "playing") {
		        const startedMono = unit.playbackStartedMonoMs || unit.createdMonoMs || 0;
		        const bytes = unit.audioBase64 ? Math.floor(unit.audioBase64.length * 0.75) : 0;
		        const estPlaybackMs = bytes ? bytes / PCM_BYTES_PER_MS : 8000;
		        const staleAfterMs = Math.max(PLAYBACK_CONFIRM_STALE_MS, estPlaybackMs * 1.5 + 5000);
		        if (startedMono && now - startedMono > staleAfterMs) {
		          unit.status = "played";
		          reaped += 1;
		          this.event("speech", "Stale playback confirmation reaped; treating speech as heard", { speechId: unit.id, text: String(unit.text || "").slice(0, 80), ageMs: Math.round(now - startedMono) });
		        }
		      } else if (["drafted", "committed", "audio_streaming", "audio_generated"].includes(unit.status)) {
		        const createdMono = unit.createdMonoMs || 0;
		        if (createdMono && now - createdMono > UNPLAYED_SPEECH_STALE_MS) {
		          unit.status = "cancelled";
		          reaped += 1;
		          this.event("speech", "Unplayed speech reaped; browser never started playback", { speechId: unit.id, text: String(unit.text || "").slice(0, 80), ageMs: Math.round(now - createdMono) });
		        }
		      }
		    }
		    if (reaped) this.emitState();
		    return reaped;
		  }

		  schedulePlaybackStallRetry(reason) {
		    if (this.playbackStallTimer) return;
		    this.event("speech", "Respond wakeup blocked by unplayed speech; stall watchdog armed", { reason, retryMs: PLAYBACK_STALL_RETRY_MS });
		    this.playbackStallTimer = setTimeout(() => {
		      this.playbackStallTimer = null;
		      if (this.state.floor === "end_candidate" && !this.state.respondInFlight) this.wakeup(reason);
		    }, PLAYBACK_STALL_RETRY_MS);
		  }

		  currentUnplayedSpeech() {
		    return this.state.speech.filter((s) => (
		      s.epoch === this.state.generationEpoch &&
		      ["drafted", "committed", "audio_streaming", "audio_generated", "playing"].includes(s.status)
		    ));
		  }

		  currentResponseBlockingUnplayedSpeech() {
		    return this.currentUnplayedSpeech().filter((unit) => !this.isListenerBackchannelSpeech(unit));
		  }

		  isLatencyBridgeSpeech(unit) {
		    return unit?.kind === "acknowledgement" && unit?.usefulness === "latency_bridge";
		  }

		  isAudibleSpeechUnit(unit) {
		    return unit?.status === "playing" || Boolean(unit?.playbackStartedAt);
		  }

		  handleLatencyBridgeResponseConflict(decision, ctx) {
		    const blockers = this.currentResponseBlockingUnplayedSpeech();
		    if (!blockers.length || !blockers.every((unit) => this.isLatencyBridgeSpeech(unit))) return false;
		    if (blockers.some((unit) => this.isAudibleSpeechUnit(unit))) {
		      this.deferredBridgeBlockedDecision = { decision, ctx };
		      this.event("speech", "Respond draft deferred until audible bridge finishes", {
		        inputVersion: ctx.inputVersion,
		        responseId: ctx.responseId,
		        bridgeSpeechIds: blockers.map((unit) => unit.id),
		      });
		      return true;
		    }
		    this.cancelQueuedAcknowledgements("useful speech ready before bridge was audible");
		    return false;
		  }

		  releaseDeferredBridgeBlockedDecision(unit) {
		    const deferred = this.deferredBridgeBlockedDecision;
		    if (!deferred || !this.isLatencyBridgeSpeech(unit)) return false;
		    this.deferredBridgeBlockedDecision = null;
		    const { decision, ctx } = deferred;
		    if (ctx.sessionId !== this.state.sessionId || ctx.epoch !== this.state.generationEpoch || ctx.inputVersion !== this.state.inputVersion) {
		      this.event("speech", "Deferred response discarded after bridge because context changed", { speechId: unit.id, inputVersion: ctx.inputVersion });
		      return false;
		    }
		    this.state.floor = "assistant_turn";
		    this.event("speech", "Deferred response released after audible bridge", { speechId: unit.id, inputVersion: ctx.inputVersion, responseId: ctx.responseId });
		    this.emitState();
		    queueMicrotask(() => this.applyDecision(decision, ctx));
		    return true;
		  }

	  isRedundantSpeech(evidenceIds, text) {
	    const activeAnswers = this.state.speech.filter((s) => !["cancelled", "failed"].includes(s.status) && s.kind === "answer");
	    const played = activeAnswers.filter((s) => s.status === "played");
	    if (!activeAnswers.length) return false;
	    const current = this.state.finalizedTranscript || this.state.provisionalTranscript || "";
	    if (isKnownTaskEditingFollowup(current) && isDraftLikeResponseToKnownWritingTask(text, this.state.conversation, current)) return false;
	    const ids = new Set(evidenceIds || []);
	    const unusedWeb = [...this.state.evidence.values()].some((ev) => ev.state === "eligible" && ev.source === "web" && !activeAnswers.some((s) => (s.evidenceIds || []).includes(ev.id)));
	    const usesUnusedWeb = [...ids].some((id) => {
	      const ev = this.state.evidence.get(id);
	      return ev?.source === "web" && !activeAnswers.some((s) => (s.evidenceIds || []).includes(id));
	    });
	    if (unusedWeb && !usesUnusedWeb) {
	      const heardAskedForLater = activeAnswers.some((s) => /public|web|benchmark|source|arriv/i.test(s.text || ""));
	      if (heardAskedForLater) return true;
	    }
	    if (played.length && !usesUnusedWeb) {
	      const newLocalFacts = [...ids].filter((id) => {
	        const ev = this.state.evidence.get(id);
	        if (ev?.source !== "local_rag") return false;
	        return !played.some((s) => (s.evidenceIds || []).includes(id));
	      });
	      const priorText = played.map((s) => s.text).join(" ");
	      const textOverlap = jaccard(terms(priorText), terms(text));
	      const impactWords = terms(text).filter((term) => !terms(priorText).includes(term));
	      const hasDistinctLocalFact = newLocalFacts.some((id) => {
	        const ev = this.state.evidence.get(id);
	        const contentTerms = terms(ev?.content || "");
	        return impactWords.some((term) => contentTerms.includes(term));
	      });
	      if (textOverlap > 0.52 && !hasDistinctLocalFact) return true;
	    }
	    return activeAnswers.some((s) => {
	      const prevIds = new Set(s.evidenceIds || []);
	      const sameEvidence = ids.size && ids.size === prevIds.size && [...ids].every((id) => prevIds.has(id));
	      const sameLocalSource = [...ids].length && [...ids].every((id) => {
	        const ev = this.state.evidence.get(id);
	        return ev?.source === "local_rag" && (s.evidenceIds || []).some((prevId) => {
	          const prev = this.state.evidence.get(prevId);
	          return prev?.source === "local_rag" && prev.fileName && prev.fileName === ev.fileName;
	        });
	      });
	      const textOverlap = jaccard(terms(s.text), terms(text));
	      return (sameEvidence || sameLocalSource) && textOverlap > 0.72;
	    });
	  }

	  commitSpeech(text, ctx, evidenceIds, options = {}) {
	    if (this.state.floor === "user_speaking" && !options.allowDuringUserSpeech) {
	      this.event("speech", "Speech blocked while user has floor", { text });
      return false;
    }
	    if (!this.isSpeechTextAllowedNow(text, options.kind || "answer")) {
	      this.event("speech", "Speech blocked by current intent repair gate", { text, current: this.state.finalizedTranscript || this.state.provisionalTranscript || "" });
	      return false;
	    }
	    if (this.hasRecentlyAskedSameThing(text)) {
	      this.event("speech", "Repeated heard question suppressed", { text });
	      this.state.metrics.qualityCounters.duplicatedQuestions += 1;
	      return false;
	    }
	    if (this.isQuestionIncompatibleWithUserActivity(text)) {
	      this.event("speech", "Question incompatible with retained activity suppressed", { text });
	      this.state.metrics.qualityCounters.ignoredConstraints += 1;
	      const fallback = options.fallbackQuestion !== false ? this.constrainedGameFallbackQuestion(text) : "";
	      if (fallback && normalizeTranscriptForTurn(fallback) !== normalizeTranscriptForTurn(text)) {
	        return this.commitSpeech(fallback, ctx, [], { kind: "clarification", usefulness: "contextual_question", yieldsFloor: true, continueAfterPlayback: false, fallbackQuestion: false });
	      }
	      queueMicrotask(() => this.wakeup("respond"));
	      return false;
	    }
	    if (this.hasQuestionAnsweredByHistory(text)) {
	      const normalized = normalizeTranscriptForTurn(text);
	      this.event("speech", "Question answered by retained user history suppressed", { text });
	      this.suppressedAnsweredQuestions.add(normalized);
	      const fallback = options.fallbackQuestion !== false ? this.constrainedGameFallbackQuestion(text) : "";
	      if (fallback && normalizeTranscriptForTurn(fallback) !== normalized) {
	        return this.commitSpeech(fallback, ctx, [], { kind: "clarification", usefulness: "contextual_question", yieldsFloor: true, continueAfterPlayback: false, fallbackQuestion: false });
	      }
	      this.state.floor = "awaiting_user";
	      this.state.awaitingUser = true;
	      this.emitState();
	      return false;
	    }
    if (ctx.epoch !== this.state.generationEpoch || ctx.inputVersion !== this.state.inputVersion) {
      this.event("speech", "Draft blocked by stale context before TTS", ctx);
      return false;
    }
    const unit = {
      id: `sp_${nanoid(6)}`,
      turnId: this.state.turnId,
      epoch: ctx.epoch,
      inputVersion: ctx.inputVersion,
      text,
      evidenceIds,
      status: "drafted",
	      kind: options.kind || "answer",
	      usefulness: options.usefulness || (evidenceIds.length ? "substantive" : "useful"),
      yieldsFloor: isQuestion(text) ? true : options.yieldsFloor !== false,
	      continueAfterPlayback: isQuestion(text) ? false : Boolean(options.continueAfterPlayback),
	      createdAt: new Date().toISOString(),
	      createdMonoMs: nowMs(),
      preparedForTranscript: this.preparedForTranscriptFor(options.kind || "answer"),
	    };
    this.state.speech.push(unit);
    this.event("speech", "Speech drafted", { speechId: unit.id, text });
    unit.status = "committed";
    this.event("speech", "Speech committed to voice", { speechId: unit.id });
	    if (unit.kind !== "acknowledgement") this.cancelQueuedAcknowledgements("useful speech committed");
	    this.emitState();
	    this.synthesizeAndEmit(unit.id);
	    return true;
	  }

	  prepareSpeech(text, ctx, evidenceIds, options = {}) {
	    if (ctx.epoch !== this.state.generationEpoch) return;
	    if (this.state.preparedSpeech && ["preparing", "audio_prepared", "audio_streaming"].includes(this.state.preparedSpeech.status)) {
	      const existing = this.state.preparedSpeech;
	      const newerInput = (ctx.inputVersion ?? 0) > (existing.inputVersion ?? 0);
	      const higherPriority = this.preparedSpeechPriority(text, options.kind || "answer") > this.preparedSpeechPriority(existing.text, existing.kind);
	      if (!newerInput && !higherPriority) return;
	      existing.status = "cancelled";
	      this.state.metrics.cancelledPreparations += 1;
	      this.ttsControllers.get(existing.id)?.abort();
	      this.ttsControllers.delete(existing.id);
	      this.emit("audio", { event: "cancel", speechId: existing.id });
	      this.event("speech", "Prepared speech replaced by newer plan", { oldSpeechId: existing.id, text });
	      this.state.preparedSpeech = null;
	    }
	    const kind = options.kind || "answer";
	    if (!this.isSpeechTextAllowedNow(text, kind)) return;
	    if (this.hasRecentlyAskedSameThing(text)) return;
	    if (this.isQuestionIncompatibleWithUserActivity(text)) {
	      this.event("speech", "Prepared question incompatible with retained activity suppressed", { text });
	      this.state.metrics.qualityCounters.ignoredConstraints += 1;
	      const fallback = options.fallbackQuestion !== false ? this.constrainedGameFallbackQuestion(text) : "";
	      if (fallback && normalizeTranscriptForTurn(fallback) !== normalizeTranscriptForTurn(text)) {
	        this.prepareSpeech(fallback, ctx, [], { kind: "clarification", usefulness: "contextual_question", yieldsFloor: true, continueAfterPlayback: false, fallbackQuestion: false });
	      }
	      return;
	    }
	    if (this.hasQuestionAnsweredByHistory(text)) {
	      this.event("speech", "Prepared question answered by retained user history suppressed", { text });
	      const fallback = options.fallbackQuestion !== false ? this.constrainedGameFallbackQuestion(text) : "";
	      if (fallback && normalizeTranscriptForTurn(fallback) !== normalizeTranscriptForTurn(text)) {
	        this.prepareSpeech(fallback, ctx, [], { kind: "clarification", usefulness: "contextual_question", yieldsFloor: true, continueAfterPlayback: false, fallbackQuestion: false });
	      }
	      return;
	    }
	    if (kind === "answer" && evidenceIds.length && this.isRedundantSpeech(evidenceIds, text)) return;
	    const unit = {
	      id: `sp_${nanoid(6)}`,
	      turnId: this.state.turnId,
	      epoch: ctx.epoch,
	      inputVersion: ctx.inputVersion,
	      text,
	      evidenceIds,
		      status: "preparing",
		      kind,
		      usefulness: options.usefulness || (evidenceIds.length ? "substantive" : "useful"),
	      yieldsFloor: isQuestion(text) ? true : options.yieldsFloor !== false,
	      continueAfterPlayback: isQuestion(text) ? false : Boolean(options.continueAfterPlayback),
	      createdAt: new Date().toISOString(),
	      createdMonoMs: nowMs(),
		      preparedForTranscript: this.preparedForTranscriptFor(kind),
	      prepared: true,
	      preparedChunks: [],
	      streamReleased: false,
	      streamEnded: false,
	    };
	    this.state.preparedSpeech = unit;
	    this.event("speech", "Speech prepared during partial turn", { speechId: unit.id, text, kind });
	    this.emitState();
	    this.synthesizePrepared(unit);
	  }

	  preparedSpeechPriority(text, kind = "answer") {
	    if (kind === "closure") return 100;
	    if (/\?/.test(String(text || ""))) return kind === "clarification" ? 80 : 70;
	    return kind === "answer" ? 60 : 40;
	  }

	  async synthesizePrepared(unit) {
	    try {
	      if (this.populatePreparedFromCache(unit)) return;
	      await this.streamUnitAudio(unit, { prepared: true });
	    } catch (error) {
	      if (this.state.preparedSpeech?.id === unit.id) this.state.preparedSpeech = null;
	      this.event("error", "Prepared TTS failed", { speechId: unit.id, message: error.message });
	      if (this.state.floor !== "user_speaking" && this.state.floor !== "closed") this.wakeup("respond");
	    } finally {
	      this.emitState();
	    }
	  }

	  releasePreparedSpeech({ onlyReady = false } = {}) {
	    const unit = this.state.preparedSpeech;
	    if (!unit || !["preparing", "audio_prepared", "audio_streaming"].includes(unit.status)) return false;
	    if (unit.epoch !== this.state.generationEpoch || this.state.floor === "user_speaking" || this.state.floor === "closed") return false;
	    if (onlyReady && unit.status === "preparing" && !unit.preparedChunks?.length) return false;
	    if (!this.isPreparedStillRelevant(unit)) {
	      unit.status = "cancelled";
	      this.state.metrics.cancelledPreparations += 1;
	      this.ttsControllers.get(unit.id)?.abort();
	      this.ttsControllers.delete(unit.id);
	      this.state.preparedSpeech = null;
	      this.event("speech", "Prepared speech invalidated before release", { speechId: unit.id });
	      return false;
	    }
	    unit.inputVersion = this.state.inputVersion;
	    this.state.speech.push(unit);
	    this.state.preparedSpeech = null;
	    this.state.floor = "assistant_turn";
	    this.event("speech", "Prepared speech released to voice", { speechId: unit.id });
	    unit.streamReleased = true;
	    unit.status = "audio_streaming";
	    this.emitAudioStart(unit);
	    for (const chunk of unit.preparedChunks || []) this.emit("audio", { event: "chunk", speechId: unit.id, audioBase64: chunk });
	    if (unit.streamEnded) this.emitAudioEnd(unit);
	    this.emitState();
	    return true;
	  }

		  isPreparedStillRelevant(unit) {
		    return this.isSpeechUnitStillRelevant(unit);
		  }

		  isSpeechUnitStillRelevant(unit) {
		    return this.speechUnitRelevance(unit).ok;
		  }

		  speechUnitRelevance(unit) {
			    const current = this.currentTranscriptForRelevance(unit);
				    if (!current) return { ok: false, reason: "missing_current_transcript" };
				    if (hasListeningOnlyPreference(current) && isAdviceLikeSpeech(unit.text, unit.kind)) return { ok: false, reason: "listening_only_preference" };
				    if (!this.isSpeechTextAllowedNow(unit.text, unit.kind)) return { ok: false, reason: "text_not_allowed_for_current_intent" };
				    if (this.isListenerBackchannelSpeech(unit)) {
				      if (isExplicitDismissalRequest(current)) return { ok: false, reason: "explicit_dismissal" };
				      if (isExplicitHoldRequest(current)) return { ok: false, reason: "explicit_hold" };
				      return { ok: true, reason: "listener_backchannel" };
				    }
				    if (this.hasContradictingCorrection(unit, current)) return { ok: false, reason: "contradicting_correction" };
				    if (hasYesNoOnlyConstraint(current) && !isDiscriminatingYesNoQuestion(unit.text)) return { ok: false, reason: "yes_no_only_constraint" };
				    if (isBareShortReply(current) && normalizeTranscriptForTurn(unit.preparedForTranscript || "") !== normalizeTranscriptForTurn(current)) return { ok: false, reason: "bare_short_reply_changed" };
				    if (["acknowledgement", "repair", "closure", "silence_check"].includes(unit.kind) && unit.inputVersion === this.state.inputVersion) return { ok: true, reason: "current_control_speech" };
				    if (unit.kind === "closure") return { ok: true, reason: "closure" };
		    if (this.isQuestionIncompatibleWithUserActivity(unit.text)) return { ok: false, reason: "question_incompatible_with_activity" };
		    if (this.hasQuestionAnsweredByHistory(unit.text)) return { ok: false, reason: "question_answered_by_history" };
		    if (unit.kind === "clarification") {
		      const preparedTerms = new Set(terms(unit.preparedForTranscript || ""));
		      const questionTerms = terms(unit.text).filter((term) => !preparedTerms.has(term));
		      const newFinalTerms = terms(current).filter((term) => !preparedTerms.has(term));
		      const answered = questionTerms.some((term) => newFinalTerms.includes(term)) ||
		        isClarificationAnsweredByCurrentDetails(unit.text, unit.preparedForTranscript || "", current);
		      return answered ? { ok: false, reason: "clarification_already_answered" } : { ok: true, reason: "clarification_still_open" };
		    }
		    if (
		      unit.inputVersion === this.state.inputVersion &&
		      normalizeTranscriptForTurn(unit.preparedForTranscript || "") === normalizeTranscriptForTurn(current)
		    ) {
		      return { ok: true, reason: "current_turn_exact_transcript" };
		    }
		    if (!unit.evidenceIds?.length) {
		      const preparedTerms = terms(unit.preparedForTranscript || "");
		      const currentTerms = terms(current);
		      if (sharesNonLatinSpan(unit.text, current)) return { ok: true, reason: "shared_non_latin_span" };
		      if (!preparedTerms.length || !currentTerms.length) return { ok: false, reason: "missing_overlap_terms" };
		      const overlap = preparedTerms.filter((term) => currentTerms.includes(term)).length / Math.min(preparedTerms.length, currentTerms.length);
		      const ok = overlap >= 0.35 || isShortFollowup(current);
		      return { ok, reason: ok ? "transcript_overlap" : "low_transcript_overlap", overlap };
		    }
		    const speechTerms = terms(unit.text);
		    const currentTerms = terms(current);
		    if (sharesNonLatinSpan(unit.text, current)) return { ok: true, reason: "shared_non_latin_span" };
		    if (!speechTerms.length || !currentTerms.length) return { ok: false, reason: "missing_speech_or_current_terms" };
		    const overlap = speechTerms.filter((term) => currentTerms.includes(term)).length / Math.min(speechTerms.length, currentTerms.length);
		    return { ok: overlap >= 0.2, reason: overlap >= 0.2 ? "speech_current_overlap" : "low_speech_current_overlap", overlap };
		  }

	  isSpeechTextAllowedNow(text, kind = "answer") {
	    const current = this.state.finalizedTranscript || this.state.provisionalTranscript || "";
	    if (!current) return true;
	    if (["repair", "closure", "acknowledgement", "silence_check"].includes(kind)) return true;
	    if (isPresenceStatusAnswer(text) && !isPresenceCheckRequest(current)) return false;
	    if (isUserCriticismOrMetaRepair(current)) {
	      const normalized = normalizeTranscriptForTurn(text);
	      if (/\b(sorry|right|drifted|missed|misheard|fix|focus|try again|what should i)\b/.test(normalized)) return true;
	      return isDraftLikeResponseToKnownWritingTask(text, this.state.conversation, current);
	    }
	    if (isUnclearFragment(current) && !isQuestion(text)) return false;
	    return true;
	  }

	  hasContradictingCorrection(unit, current) {
	    const currentText = String(current || "").toLowerCase();
	    if (isExplicitDismissalRequest(currentText)) {
	      return unit.kind !== "closure";
	    }
	    if (
	      unit.inputVersion === this.state.inputVersion &&
	      normalizeTranscriptForTurn(unit.preparedForTranscript || "") === normalizeTranscriptForTurn(current)
	    ) {
	      return false;
	    }
	    const unitTerms = new Set(terms(`${unit.text} ${unit.preparedForTranscript || ""}`));
	    const correctionMatch = materialCorrectionSpan(currentText);
	    if (!correctionMatch) return false;
	    const correctionTerms = terms(correctionMatch);
	    if (!correctionTerms.length) return true;
	    const overlap = correctionTerms.filter((term) => unitTerms.has(term)).length / correctionTerms.length;
	    const negatesPrior = /\b(no\b|not\b|no longer|instead|rather|stop|forget|different|switch|change|wrong|correct that|correction)\b/i.test(correctionMatch);
	    return negatesPrior || overlap < 0.3;
	  }

	  cancelIncompatibleUnheardSpeech(current) {
	    for (const unit of this.state.speech) {
	      if (["played", "failed", "cancelled"].includes(unit.status)) continue;
	      if (!this.hasContradictingCorrection(unit, current)) continue;
	      unit.status = "cancelled";
	      this.ttsControllers.get(unit.id)?.abort();
	      this.ttsControllers.delete(unit.id);
	      this.emit("audio", { event: "cancel", speechId: unit.id });
	      this.event("speech", "Unheard speech cancelled after material transcript correction", { speechId: unit.id, text: unit.text });
	    }
	    const prepared = this.state.preparedSpeech;
	    if (prepared && !["played", "failed", "cancelled"].includes(prepared.status) && this.hasContradictingCorrection(prepared, current)) {
	      prepared.status = "cancelled";
	      this.state.metrics.cancelledPreparations += 1;
	      this.ttsControllers.get(prepared.id)?.abort();
	      this.ttsControllers.delete(prepared.id);
	      this.emit("audio", { event: "cancel", speechId: prepared.id });
	      this.state.preparedSpeech = null;
	      this.event("speech", "Prepared speech cancelled after material transcript correction", { speechId: prepared.id, text: prepared.text });
	    }
	  }

	  cancelIrrelevantUnheardSpeech(current) {
	    for (const unit of this.state.speech) {
	      if (["played", "failed", "cancelled"].includes(unit.status)) continue;
	      if (unit.inputVersion >= this.state.inputVersion) continue;
	      if (this.isSpeechUnitStillRelevant(unit)) continue;
	      unit.status = "cancelled";
	      this.ttsControllers.get(unit.id)?.abort();
	      this.ttsControllers.delete(unit.id);
	      this.emit("audio", { event: "cancel", speechId: unit.id });
	      this.event("speech", "Unheard speech invalidated by provider-final transcript", { speechId: unit.id, text: unit.text, current });
	    }
	    const prepared = this.state.preparedSpeech;
	    if (prepared && !["played", "failed", "cancelled"].includes(prepared.status) && !this.isSpeechUnitStillRelevant(prepared)) {
	      prepared.status = "cancelled";
	      this.state.metrics.cancelledPreparations += 1;
	      this.ttsControllers.get(prepared.id)?.abort();
	      this.ttsControllers.delete(prepared.id);
	      this.emit("audio", { event: "cancel", speechId: prepared.id });
	      this.state.preparedSpeech = null;
	      this.event("speech", "Prepared speech invalidated by provider-final transcript", { speechId: prepared.id, text: prepared.text, current });
	    }
	  }

	  async synthesizeAndEmit(speechId) {
    const unit = this.state.speech.find((s) => s.id === speechId);
    if (!unit) return;
    try {
      if (this.emitCachedAudio(unit)) return;
      if (await this.emitWarmedAudioWhenReady(unit)) return;
      await this.streamUnitAudio(unit, { prepared: false });
    } catch (error) {
      if (error.name === "AbortError" || unit.status === "cancelled") return;
      unit.status = "failed";
      this.event("error", "TTS failed", { speechId: unit.id, message: error.message });
    } finally {
      this.emitState();
    }
  }

	  beginActiveSession() {
	    // keep the GC endpointer connection warm so live classifications don't
	    // pay a cold TLS handshake inside the race budget
	    if (semanticEndpointAvailable() && nowMs() - this.lastEndpointWarm > 60000) {
	      this.lastEndpointWarm = nowMs();
	      this.classifyTurnCompletion({ transcript: "hello", context: [] }).catch(() => {});
	    }
	    if (this.audioWarmPreloaded) return;
	    this.audioWarmPreloaded = true;
	    for (const text of initialAcknowledgementBank()) {
	      this.cacheSpeechAudio(text, { purpose: "active-session-preload" });
	    }
	    this.event("speech", "Acknowledgement audio preload queued", { count: initialAcknowledgementBank().length, voice: config.ttsVoice, model: config.ttsModel });
	  }

	  warmContextualAcknowledgements(text) {
	    if (!text || this.contextWarmInputVersions.has(this.state.inputVersion)) return;
	    this.contextWarmInputVersions.add(this.state.inputVersion);
	    const variants = contextualAcknowledgementBank(text);
	    for (const variant of variants) this.cacheSpeechAudio(variant, { purpose: "contextual-warm" });
	    if (variants.length) this.event("speech", "Contextual acknowledgement audio warm queued", { inputVersion: this.state.inputVersion, count: variants.length });
	  }

	  cacheSpeechAudio(text, { purpose = "lazy" } = {}) {
	    const key = speechCacheKey(text);
	    if (!text || this.speechAudioCache.has(key)) return;
	    this.evictSpeechAudioCacheIfNeeded();
	    const entry = { status: "queued", text, key, chunks: [], bytes: 0, chunkCount: 0, promise: null, purpose, attempts: 0, createdMonoMs: nowMs(), model: config.ttsModel, voice: config.ttsVoice };
	    this.speechAudioCache.set(key, entry);
	    this.audioWarmQueue.push(entry);
	    this.drainSpeechAudioWarmQueue();
	  }

	  evictSpeechAudioCacheIfNeeded() {
	    const maxEntries = 16;
	    if (this.speechAudioCache.size < maxEntries) return;
	    const candidates = [...this.speechAudioCache.values()]
	      .filter((entry) => entry.status !== "warming")
	      .sort((a, b) => (a.createdMonoMs || 0) - (b.createdMonoMs || 0));
	    const evicted = candidates[0];
	    if (evicted) this.speechAudioCache.delete(evicted.key);
	  }

	  drainSpeechAudioWarmQueue() {
	    const maxConcurrent = 2;
	    while (this.audioWarmInFlight < maxConcurrent && this.audioWarmQueue.length) {
	      const entry = this.audioWarmQueue.shift();
	      if (!entry || !this.speechAudioCache.has(entry.key) || entry.status === "ready") continue;
	      this.runSpeechAudioWarm(entry);
	    }
	  }

	  runSpeechAudioWarm(entry) {
	    entry.status = "warming";
	    entry.attempts += 1;
	    this.audioWarmInFlight += 1;
	    entry.promise = streamSpeech(entry.text, {
	      onStart: ({ sampleRate }) => { entry.sampleRate = sampleRate || 24000; },
	      onChunk: ({ chunk, chunkCount, bytes }) => {
	        entry.chunks.push(chunk.toString("base64"));
	        entry.chunkCount = chunkCount;
	        entry.bytes = bytes;
	      },
	      onEnd: ({ elapsedMs, model }) => {
	        entry.status = "ready";
	        entry.elapsedMs = elapsedMs;
	        entry.model = model;
	        this.event("speech", "Speech audio warm ready", { text: entry.text, purpose: entry.purpose, bytes: entry.bytes, chunkCount: entry.chunkCount, elapsedMs, model });
	      },
	    }).catch((error) => {
	      entry.error = error.message;
	      if (entry.attempts < 2) {
	        entry.status = "queued";
	        entry.chunks = [];
	        entry.bytes = 0;
	        entry.chunkCount = 0;
	        this.audioWarmQueue.push(entry);
	      } else {
	        entry.status = "failed";
	        this.event("speech", "Speech audio warm failed", { text: entry.text, purpose: entry.purpose, message: error.message });
	      }
	    }).finally(() => {
	      this.audioWarmInFlight = Math.max(0, this.audioWarmInFlight - 1);
	      this.drainSpeechAudioWarmQueue();
	    });
	  }

	  async emitWarmedAudioWhenReady(unit) {
	    const cached = this.speechAudioCache.get(speechCacheKey(unit.text));
	    if (!cached || cached.status !== "warming" || !cached.promise) return false;
	    await cached.promise;
	    if (unit.status === "cancelled" || unit.epoch !== this.state.generationEpoch) return true;
	    return this.emitCachedAudio(unit);
	  }

	  populatePreparedFromCache(unit) {
	    const cached = this.speechAudioCache.get(speechCacheKey(unit.text));
	    if (!cached || cached.status !== "ready" || !cached.chunks.length) return false;
	    unit.ttsStartedAt = new Date().toISOString();
	    unit.ttsStartedMonoMs = nowMs();
	    unit.ttsFirstChunkMs = 0;
	    unit.ttsFirstChunkAt = unit.ttsStartedAt;
	    unit.ttsFirstChunkMonoMs = unit.ttsStartedMonoMs;
	    unit.ttsElapsedMs = 0;
	    unit.ttsModel = cached.model || "prewarmed";
	    unit.audioMime = `audio/pcm;rate=${cached.sampleRate || 24000}`;
	    unit.audioSampleRate = cached.sampleRate || 24000;
	    unit.audioEncoding = "s16le";
	    unit.audioChannels = 1;
	    unit.audioBytes = cached.bytes;
	    unit.audioChunkCount = cached.chunkCount;
	    unit.preparedChunks = [...cached.chunks];
	    unit.streamEnded = true;
	    unit.status = "audio_prepared";
	    this.event("speech", "Prepared audio loaded from cache", { speechId: unit.id, bytes: unit.audioBytes, chunkCount: unit.audioChunkCount });
	    this.releasePreparedSpeech();
	    return true;
	  }

	  emitCachedAudio(unit) {
	    const cached = this.speechAudioCache.get(speechCacheKey(unit.text));
	    if (!cached || cached.status !== "ready" || !cached.chunks.length) return false;
	    unit.ttsStartedAt = new Date().toISOString();
	    unit.ttsStartedMonoMs = nowMs();
	    unit.ttsFirstChunkMs = 0;
	    unit.ttsFirstChunkAt = unit.ttsStartedAt;
	    unit.ttsFirstChunkMonoMs = unit.ttsStartedMonoMs;
	    unit.ttsElapsedMs = 0;
	    unit.ttsModel = cached.model || "prewarmed";
	    unit.audioMime = `audio/pcm;rate=${cached.sampleRate || 24000}`;
	    unit.audioSampleRate = cached.sampleRate || 24000;
	    unit.audioEncoding = "s16le";
	    unit.audioChannels = 1;
	    unit.audioBytes = cached.bytes;
	    unit.audioChunkCount = cached.chunkCount;
	    unit.status = "audio_streaming";
	    this.event("speech", "Cached audio stream started", { speechId: unit.id, bytes: unit.audioBytes, chunkCount: unit.audioChunkCount });
	    this.emitAudioStart(unit);
	    for (const audioBase64 of cached.chunks) this.emit("audio", { event: "chunk", speechId: unit.id, audioBase64 });
	    unit.streamEnded = true;
	    unit.streamComplete = true;
	    unit.status = "audio_generated";
	    this.event("speech", "Cached audio stream ended", { speechId: unit.id, bytes: unit.audioBytes, chunkCount: unit.audioChunkCount });
	    this.emitAudioEnd(unit);
	    return true;
	  }

	  async streamUnitAudio(unit, { prepared }) {
	    for (let attempt = 1; attempt <= 2; attempt += 1) {
	      unit.ttsFirstChunkTimedOut = false;
	      unit.ttsFirstChunkMs = null;
	      unit.ttsFirstChunkAt = null;
	      unit.ttsFirstChunkMonoMs = null;
	      if (prepared && !unit.streamReleased) unit.preparedChunks = [];
	      try {
	        return await this.streamUnitAudioAttempt(unit, { prepared, attempt });
	      } catch (error) {
	        if (unit.ttsFirstChunkTimedOut && attempt < 2 && unit.status !== "cancelled" && unit.epoch === this.state.generationEpoch) {
	          this.event("speech", prepared ? "Prepared TTS first chunk timed out; retrying" : "TTS first chunk timed out; retrying", { speechId: unit.id, attempt });
	          this.ttsControllers.delete(unit.id);
	          continue;
	        }
	        throw error;
	      }
	    }
	  }

	  async streamUnitAudioAttempt(unit, { prepared, attempt }) {
	    unit.ttsStartedAt = new Date().toISOString();
	    unit.ttsStartedMonoMs = nowMs();
	    unit.audioMime = "audio/pcm;rate=24000";
	    unit.audioSampleRate = 24000;
	    unit.audioEncoding = "s16le";
	    unit.audioChannels = 1;
	    this.event("speech", prepared ? "Prepared TTS stream started" : "TTS stream started", { speechId: unit.id, attempt });
	    let firstChunkTimer = null;
	    await streamSpeech(unit.text, {
      onStart: ({ controller, model, sampleRate }) => {
        this.ttsControllers.set(unit.id, controller);
        unit.ttsModel = model;
        if (sampleRate && sampleRate !== unit.audioSampleRate) {
          unit.audioSampleRate = sampleRate;
          unit.audioMime = `audio/pcm;rate=${sampleRate}`;
        }
	        firstChunkTimer = setTimeout(() => {
	          if (!unit.ttsFirstChunkMs && unit.status !== "cancelled") {
	            unit.ttsFirstChunkTimedOut = true;
	            controller.abort();
	          }
	        }, 1800);
        if (!prepared) {
          unit.status = "audio_streaming";
          this.emitAudioStart(unit);
        }
      },
      onChunk: ({ chunk, chunkCount, bytes, elapsedMs, firstChunkMs }) => {
        const inputChanged = !prepared && unit.inputVersion !== this.state.inputVersion;
        const currentTranscript = this.state.finalizedTranscript || this.state.provisionalTranscript || "";
        const canSurviveInputChange = inputChanged &&
          (this.isListenerBackchannelSpeech(unit) || ["clarification", "closure"].includes(unit.kind)) &&
          !this.hasContradictingCorrection(unit, currentTranscript);
        if (unit.epoch !== this.state.generationEpoch || this.state.floor === "closed" || (inputChanged && !canSurviveInputChange)) {
          unit.status = "cancelled";
          this.ttsControllers.get(unit.id)?.abort();
          return;
        }
        if (unit.status === "cancelled") return;
        const encoded = chunk.toString("base64");
        unit.audioChunkCount = chunkCount;
        unit.audioBytes = bytes;
        if (!unit.ttsFirstChunkMs) {
	          if (firstChunkTimer) clearTimeout(firstChunkTimer);
          unit.ttsFirstChunkMs = firstChunkMs ?? elapsedMs;
          unit.ttsFirstChunkAt = new Date().toISOString();
          unit.ttsFirstChunkMonoMs = nowMs();
          this.event("speech", prepared ? "Prepared first audio chunk" : "First audio chunk generated", {
            speechId: unit.id,
            elapsedMs: unit.ttsFirstChunkMs,
          });
        }
        if (prepared && !unit.streamReleased) {
          unit.preparedChunks.push(encoded);
          return;
        }
        if (prepared && unit.streamReleased && unit.audioChunkCount === 1 && !unit.audioStartEmitted) this.emitAudioStart(unit);
        this.emit("audio", { event: "chunk", speechId: unit.id, audioBase64: encoded });
      },
      onEnd: ({ elapsedMs, bytes, chunkCount, model, firstChunkMs }) => {
	        if (firstChunkTimer) clearTimeout(firstChunkTimer);
        this.ttsControllers.delete(unit.id);
        if (unit.status === "cancelled") return;
        unit.ttsElapsedMs = elapsedMs;
        unit.ttsFirstChunkMs = unit.ttsFirstChunkMs || firstChunkMs;
        unit.audioBytes = bytes;
        unit.audioChunkCount = chunkCount;
        unit.ttsModel = model;
        unit.streamEnded = true;
        if (prepared && !unit.streamReleased) {
          unit.status = "audio_prepared";
          this.event("speech", "Prepared audio stream ready", { speechId: unit.id, elapsedMs, firstChunkMs, bytes, chunkCount, model });
          this.releasePreparedSpeech();
          return;
        }
        unit.streamComplete = true;
        if (unit.status === "audio_streaming") unit.status = "audio_generated";
        this.event("speech", prepared ? "Prepared audio stream ended" : "Audio stream ended", { speechId: unit.id, elapsedMs, firstChunkMs, bytes, chunkCount, model });
        this.emitAudioEnd(unit);
      },
	    });
  }

  scheduleBridgeAcknowledgement({ reason, inputVersion }) {
	    if (this.state.mode !== "live") return;
	    if (this.state.pausedConversation) return;
	    if (this.state.floor === "user_speaking" || this.state.floor === "closed") return;
	    if (this.hasUnplayedSpeech()) return;
	    if (!this.hasPendingUsefulWork(inputVersion) && !this.state.respondInFlight) return;
	    if (this.state.speech.slice(-4).some((s) => s.kind === "acknowledgement" && !["cancelled", "failed", "played"].includes(s.status))) return;
	    if (nowMs() - (this.lastBridgeAcknowledgement?.at || 0) < 1800) return;
	    if (this.bridgeDecisionInputVersions.has(inputVersion)) return;
	    const current = this.state.finalizedTranscript || this.state.provisionalTranscript || "";
	    if (isBridgeObviouslyUnhelpful(current, this.state.conversation)) {
	      this.event("speech", "Delayed acknowledgement bridge skipped for short conversational turn", { reason, inputVersion });
	      return;
	    }
	    this.bridgeDecisionInputVersions.add(inputVersion);
	    clearTimeout(this.bridgeTimer);
	    this.bridgeTimer = setTimeout(() => {
	      this.bridgeTimer = null;
	      this.releaseBridgeAcknowledgement({ reason, inputVersion });
	    }, 0);
	    this.event("speech", "Delayed acknowledgement bridge armed", { reason, inputVersion });
	  }

	  async releaseBridgeAcknowledgement({ reason, inputVersion }) {
	    if (!this.canReleaseBridgeAcknowledgement(inputVersion)) return;
	    const controller = new AbortController();
	    this.bridgeAbortController = controller;
	    let fallbackReleased = false;
	    let resolved = false;
	    const timeout = setTimeout(() => controller.abort(), Math.max(BRIDGE_FALLBACK_DELAY_MS + 100, config.bridgeTimeoutMs || 1200));
	    const fallbackTimer = setTimeout(() => {
	      if (resolved || controller.signal.aborted || !this.canReleaseBridgeAcknowledgement(inputVersion)) return;
	      const text = this.contextualBridgeFallbackText(inputVersion);
	      if (!text || this.isRecentBridgeText(text)) {
	        this.event("speech", "Delayed acknowledgement bridge fallback stayed silent", { reason, inputVersion });
	        resolved = true;
	        controller.abort();
	        return;
	      }
	      fallbackReleased = true;
	      resolved = true;
	      controller.abort();
	      this.releaseBridgeText(text, { reason, inputVersion, source: "fallback", elapsedMs: BRIDGE_FALLBACK_DELAY_MS });
	    }, BRIDGE_FALLBACK_DELAY_MS);
	    let result = null;
	    try {
	      result = await this.decideBridgeAcknowledgement({
	        snapshot: this.bridgeDecisionSnapshot(reason, inputVersion),
	        signal: controller.signal,
	      });
	    } catch (error) {
	      if (!fallbackReleased) this.event("speech", "Delayed acknowledgement bridge decision silent", { reason, inputVersion, message: error.name === "AbortError" ? "aborted" : error.message });
	      return;
	    } finally {
	      resolved = true;
	      clearTimeout(timeout);
	      clearTimeout(fallbackTimer);
	      if (this.bridgeAbortController === controller) this.bridgeAbortController = null;
	    }
	    if (fallbackReleased || controller.signal.aborted || !this.canReleaseBridgeAcknowledgement(inputVersion)) return;
	    const text = String(result?.text || "").trim();
	    if (!text) {
	      const fallbackText = this.hasRecentHeardLatencyBridge()
	        ? ""
	        : this.contextualBridgeFallbackText(inputVersion);
	      if (fallbackText && !this.isRecentBridgeText(fallbackText)) {
	        this.event("speech", "Delayed acknowledgement bridge decision chose silence; releasing contextual fallback", {
	          reason,
	          inputVersion,
	          model: result?.model,
	          elapsedMs: result?.elapsedMs,
	        });
	        this.releaseBridgeText(fallbackText, { reason, inputVersion, source: "fallback-after-silence", model: result?.model, elapsedMs: result?.elapsedMs });
	        return;
	      }
	      this.event("speech", "Delayed acknowledgement bridge decision chose silence", {
	        reason,
	        inputVersion,
	        model: result?.model,
	        elapsedMs: result?.elapsedMs,
	      });
	      return;
	    }
	    if (this.isRecentBridgeText(text)) {
	      this.event("speech", "Delayed acknowledgement bridge duplicate suppressed", { reason, inputVersion, text });
	      return;
	    }
	    if (!hasMeaningfulBridgeCue(this.state.finalizedTranscript || this.state.provisionalTranscript || "", this.state.conversation)) {
	      this.event("speech", "Delayed acknowledgement bridge provider speech suppressed without cue", { reason, inputVersion, text });
	      return;
	    }
	    this.releaseBridgeText(text, { reason, inputVersion, source: "provider", model: result?.model, elapsedMs: result?.elapsedMs });
	  }

	  releaseBridgeText(text, { reason, inputVersion, source, model, elapsedMs }) {
	    if (!this.canReleaseBridgeAcknowledgement(inputVersion)) return false;
	    const ctx = {
	      mode: "bridge",
	      epoch: this.state.generationEpoch,
	      inputVersion,
	      knowledgeVersion: this.state.knowledgeVersion,
	      sessionId: this.state.sessionId,
	    };
	    this.cacheSpeechAudio(text, { purpose: "bridge-generated" });
	    this.event("speech", "Delayed acknowledgement bridge released", { reason, inputVersion, text, source, model, elapsedMs });
	    this.commitSpeech(text, ctx, [], { kind: "acknowledgement", usefulness: "latency_bridge", yieldsFloor: false, continueAfterPlayback: true });
	    this.lastBridgeAcknowledgement = { text, at: nowMs() };
	    this.state.floor = "assistant_turn";
	    this.emitState();
	    return true;
	  }

	  canReleaseBridgeAcknowledgement(inputVersion) {
	    if (this.state.inputVersion !== inputVersion) return false;
	    if (this.state.pausedConversation) return false;
	    if (this.state.floor === "user_speaking" || this.state.floor === "closed") return false;
	    if (this.hasUnplayedSpeech() || this.hasEligibleEvidenceForInput(inputVersion)) return false;
	    if (!this.state.respondInFlight && !this.hasPendingUsefulWork(inputVersion)) return false;
	    if (nowMs() - (this.lastBridgeAcknowledgement?.at || 0) < 1800) return false;
	    return true;
	  }

	  hasRecentHeardLatencyBridge() {
	    return this.state.conversation.slice(-6).some((entry) => (
	      entry.role === "assistant" &&
	      entry.kind === "acknowledgement" &&
	      entry.usefulness === "latency_bridge" &&
	      entry.heardStatus === "played"
	    ));
	  }

	  bridgeDecisionSnapshot(reason, inputVersion) {
	    return {
	      reason,
	      inputVersion,
	      currentTranscript: this.state.finalizedTranscript || this.state.provisionalTranscript || "",
	      floor: this.state.floor,
	      respondInFlight: this.state.respondInFlight,
	      pendingUsefulWork: [...this.state.jobs.values()]
	        .filter((job) => job.inputVersion <= inputVersion && ["scheduled", "running"].includes(job.status) && this.isJobStillRelevant(job))
	        .map(({ source, query, status, required }) => ({ source, query, status, required })),
	      recentConversation: this.state.conversation.slice(-8).map((entry) => ({
	        role: entry.role,
	        content: entry.role === "assistant" ? (entry.heardContent || entry.content || "") : entry.content,
	        kind: entry.kind,
	        usefulness: entry.usefulness,
	        heardStatus: entry.heardStatus,
	      })),
	      recentHeardBridges: this.state.conversation
	        .filter((entry) => entry.role === "assistant" && entry.kind === "acknowledgement" && entry.usefulness === "latency_bridge" && entry.heardStatus === "played")
	        .slice(-6)
	        .map((entry) => entry.heardContent || entry.content || ""),
	    };
	  }

	  contextualBridgeFallbackText(inputVersion) {
	    const current = this.state.finalizedTranscript || this.state.provisionalTranscript || "";
	    if (!hasMeaningfulBridgeCue(current, this.state.conversation)) return "";
	    if (!this.hasPendingUsefulWork(inputVersion) && !this.state.respondInFlight) return "";
	    return "Okay.";
	  }

	  maybeCommitListenerAcknowledgement(text) {
	    if (!this.canCommitListenerAcknowledgement(text)) return false;
	    const ack = listenerAcknowledgementText(text);
	    if (!ack || this.isRecentBridgeText(ack)) return false;
	    const ctx = {
	      mode: "listener-backchannel",
	      epoch: this.state.generationEpoch,
	      inputVersion: this.state.inputVersion,
	      knowledgeVersion: this.state.knowledgeVersion,
	      sessionId: this.state.sessionId,
	    };
	    this.cacheSpeechAudio(ack, { purpose: "listener-backchannel" });
	    this.event("speech", "Listener acknowledgement released during user floor", { inputVersion: this.state.inputVersion, text: ack });
	    this.commitSpeech(ack, ctx, [], { kind: "acknowledgement", usefulness: "listener_backchannel", yieldsFloor: false, continueAfterPlayback: false, allowDuringUserSpeech: true });
	    this.lastListenerAcknowledgement = { text: ack, at: nowMs(), turnId: this.state.turnId };
	    return true;
	  }

	  canCommitListenerAcknowledgement(text) {
	    if (this.state.mode !== "live") return false;
	    if (this.state.pausedConversation || this.state.floor !== "user_speaking" || this.state.floor === "closed") return false;
	    const unplayed = this.currentUnplayedSpeech();
	    if (unplayed.some((unit) => this.isListenerBackchannelSpeech(unit))) return false;
	    if (unplayed.some((unit) => !this.isListenerBackchannelSpeech(unit) && this.isAudibleSpeechUnit(unit))) return false;
	    if (this.lastListenerAcknowledgement?.turnId === this.state.turnId) return false;
	    if (nowMs() - (this.lastListenerAcknowledgement?.at || 0) < 3500) return false;
	    if (isBridgeObviouslyUnhelpful(text, this.state.conversation)) return false;
	    return hasPartialUtteranceAcknowledgementCue(text);
	  }

	  isRecentBridgeText(text) {
	    const normalized = normalizeTranscriptForTurn(text);
	    if (!normalized) return true;
	    if (normalizeTranscriptForTurn(this.lastBridgeAcknowledgement?.text || "") === normalized) return true;
	    return this.state.conversation.slice(-10).some((entry) => (
	      entry.role === "assistant" &&
	      entry.kind === "acknowledgement" &&
	      entry.usefulness === "latency_bridge" &&
	      normalizeTranscriptForTurn(entry.heardContent || entry.content || "") === normalized
	    ));
	  }

	  clearBridgeAcknowledgement(reason) {
	    const hadBridge = Boolean(this.bridgeTimer || this.bridgeAbortController);
	    if (this.bridgeTimer) clearTimeout(this.bridgeTimer);
	    this.bridgeTimer = null;
	    if (this.bridgeAbortController) this.bridgeAbortController.abort();
	    this.bridgeAbortController = null;
	    if (hadBridge) this.event("speech", "Delayed acknowledgement bridge suppressed", { reason });
	  }

  emitAudioStart(unit) {
    unit.audioStartEmitted = true;
    this.emit("audio", {
      event: "start",
      id: unit.id,
      speechId: unit.id,
      text: unit.text,
      audioMime: unit.audioMime,
      sampleRate: unit.audioSampleRate,
      encoding: unit.audioEncoding,
      channels: unit.audioChannels,
      epoch: unit.epoch,
      inputVersion: unit.inputVersion,
      kind: unit.kind,
      prepared: Boolean(unit.prepared),
    });
  }

  emitAudioEnd(unit) {
    this.emit("audio", {
      event: "end",
      id: unit.id,
      speechId: unit.id,
      kind: unit.kind,
      audioBytes: unit.audioBytes,
      audioChunkCount: unit.audioChunkCount,
      ttsElapsedMs: unit.ttsElapsedMs,
    });
  }

  noteAcousticEnd(data = {}) {
    const acousticEndWallMs = Number(data.acousticEndWallMs);
    const committedWallMs = Number(data.committedWallMs || Date.now());
    const sample = {
      inputVersion: this.state.inputVersion + 1,
      at: new Date().toISOString(),
      acousticEndWallMs: Number.isFinite(acousticEndWallMs) ? acousticEndWallMs : null,
      committedWallMs,
      vadDelayMs: Number(data.vadDelayMs || 0),
      endpointDelayMs: Number(data.endpointDelayMs || 0),
      reason: data.reason || "",
    };
    this.state.metrics.acousticEnds.push(sample);
    if (this.state.metrics.acousticEnds.length > 80) this.state.metrics.acousticEnds.shift();
    this.event("latency", "Browser acoustic end noted", sample);
  }

	  markPlaybackStart(speechId) {
	    const unit = this.state.speech.find((s) => s.id === speechId);
	    if (unit && ["playing", "played"].includes(unit.status) && unit.epoch === this.state.generationEpoch) return true;
	    const relevance = unit ? this.speechUnitRelevance(unit) : { ok: false, reason: "missing_speech_unit" };
	    if (unit && ["audio_streaming", "audio_generated"].includes(unit.status) && unit.epoch === this.state.generationEpoch && relevance.ok) {
		      unit.status = "playing";
	      unit.playbackStartedAt = new Date().toISOString();
	      unit.playbackStartedMonoMs = nowMs();
	      const acoustic = [...this.state.metrics.acousticEnds].reverse().find((item) => item.inputVersion <= unit.inputVersion);
	      if (acoustic) {
	        const playbackWallMs = Date.now();
	        const sample = {
	          speechId,
	          inputVersion: unit.inputVersion,
	          acousticEndToPlaybackMs: acoustic.acousticEndWallMs ? Math.max(0, Math.round(playbackWallMs - acoustic.acousticEndWallMs)) : null,
	          commitToPlaybackMs: acoustic.committedWallMs ? Math.max(0, Math.round(playbackWallMs - acoustic.committedWallMs)) : null,
	          decisionToPlaybackMs: unit.createdMonoMs ? Math.max(0, unit.playbackStartedMonoMs - unit.createdMonoMs) : null,
	          ttsFirstChunkMs: unit.ttsFirstChunkMs ?? null,
	          ttsElapsedMs: unit.ttsElapsedMs ?? null,
	          prepared: Boolean(unit.prepared),
	          usefulness: unit.usefulness,
	          kind: unit.kind,
	          latencyRole: unit.kind === "acknowledgement" && unit.usefulness === "latency_bridge" ? "acknowledgement" : (unit.kind === "answer" ? "useful_answer" : unit.kind),
	        };
	        this.state.metrics.latencySamples.push(sample);
	        if (this.state.metrics.latencySamples.length > 80) this.state.metrics.latencySamples.shift();
	      }
		      this.event("speech", "Browser started actual playback", { speechId, inputVersion: unit.inputVersion, relevanceReason: relevance.reason });
		      this.emitState();
		      return true;
		    }
		    if (unit && !["played", "failed", "cancelled"].includes(unit.status)) {
		      unit.relevanceRejectionReason = relevance.reason;
		      unit.status = "cancelled";
	      this.ttsControllers.get(unit.id)?.abort();
	      this.ttsControllers.delete(unit.id);
	      this.emit("audio", { event: "cancel", speechId: unit.id });
	      this.state.metrics.qualityCounters.staleAudio += 1;
		      this.event("speech", "Playback start rejected stale speech", { speechId, inputVersion: unit.inputVersion, currentInputVersion: this.state.inputVersion, reason: relevance.reason, overlap: relevance.overlap });
	      this.emitState();
	    }
	    return false;
	  }

	  markPlayed(speechId) {
	    const unit = this.state.speech.find((s) => s.id === speechId);
	    if (unit && unit.epoch === this.state.generationEpoch && ["playing", "audio_streaming", "audio_generated"].includes(unit.status)) {
		      unit.status = "played";
		      unit.playedAt = new Date().toISOString();
		      unit.playedMonoMs = nowMs();
	      this.recordAssistantConversation(unit, "played");
	      if (!this.isListenerBackchannelSpeech(unit)) this.state.currentTurnAssistantCount += 1;
		      this.event("speech", "Browser ended actual playback", { speechId });
      if ((unit.evidenceIds || []).some((id) => this.state.evidence.get(id)?.source === "web")) this.state.metrics.qualityCounters.researchUsed += 1;
      if (this.releaseDeferredBridgeBlockedDecision(unit)) return;
      if (this.isListenerBackchannelSpeech(unit)) {
        this.emitState();
        return;
      }
      const shouldContinue = !this.state.awaitingUser && !isQuestion(unit.text) && unit.kind !== "clarification" && unit.continueAfterPlayback && this.state.currentTurnAssistantCount < 2;
      if (shouldContinue) {
        this.state.floor = "assistant_turn";
        this.emitState();
        this.wakeup("continue");
        return;
      }
	      this.advanceConversationTurn();
	      this.state.floor = "awaiting_user";
	      this.state.awaitingUser = unit.kind === "clarification";
      this.emitState();
    } else {
      this.event("speech", "Playback ack ignored for stale/cancelled speech", { speechId });
    }
  }

	  interrupt() {
	    this.state.generationEpoch += 1;
	    this.state.floor = "user_speaking";
	    const interruptedAt = nowMs();
	    this.deferredBridgeBlockedDecision = null;
	    this.clearBridgeAcknowledgement("user interrupted");
	    this.abortModelInvocations("user interrupted");
	    this.abortTts();
	    for (const s of this.state.speech) {
	      if (!["played", "failed"].includes(s.status)) {
	        const wasAudible = s.status === "playing" || Boolean(s.playbackStartedAt);
	        s.status = "cancelled";
	        if (wasAudible && s.playbackStartedMonoMs) {
	          s.interruptedAfterMs = Math.max(0, interruptedAt - s.playbackStartedMonoMs);
	          this.state.metrics.interruptionReactions.push({
	            speechId: s.id,
	            reactionMs: interruptedAt - s.playbackStartedMonoMs,
	            heardStatus: "interrupted",
	            text: s.text.slice(0, 160),
	          });
	          if (this.state.metrics.interruptionReactions.length > 40) this.state.metrics.interruptionReactions.shift();
	        }
	        if (wasAudible) this.recordAssistantConversation(s, "interrupted");
	      }
	    }
	    if (this.state.currentTurnUserCommitted) this.advanceConversationTurn();
	    this.event("interrupt", "Playback stopped and generation epoch advanced", { epoch: this.state.generationEpoch });
	    this.emitState();
	  }

  stop() {
    this.state.floor = "closed";
    this.state.generationEpoch += 1;
    this.deferredBridgeBlockedDecision = null;
    this.clearBridgeAcknowledgement("session stopped");
    this.abortModelInvocations("session stopped");
    this.abortTts();
    for (const job of this.state.jobs.values()) if (["scheduled", "running"].includes(job.status)) job.status = "cancelled";
    this.event("session", "Session stopped and pending work cancelled");
    this.emitState();
  }

	  abortTts() {
	    for (const controller of this.ttsControllers.values()) controller.abort();
	    this.ttsControllers.clear();
	  }

	  abortModelInvocations(reason) {
	    for (const [mode, active] of Object.entries(this.modelAbortControllers || {})) {
	      if (!active || active.controller.signal.aborted) continue;
	      active.controller.abort();
	      this.event("model", `Communicator ${mode} aborted`, { reason, inputVersion: active.inputVersion });
	    }
	  }

	  recordAssistantConversation(unit, heardStatus) {
	    if (unit.conversationRecorded) return;
	    unit.conversationRecorded = true;
	    const interrupted = heardStatus !== "played";
	    this.state.conversation.push({
	      role: "assistant",
	      content: unit.text,
	      heardContent: interrupted ? "" : unit.text,
	      heardNote: interrupted ? "Playback was interrupted after audio started; exact heard words are unknown." : "",
	      audibleMs: interrupted ? unit.interruptedAfterMs ?? null : null,
	      evidenceIds: unit.evidenceIds,
	      kind: unit.kind,
	      usefulness: unit.usefulness,
	      turnId: unit.turnId || this.state.turnId,
	      inputVersion: unit.inputVersion,
	      speechId: unit.id,
	      heardStatus,
	      cancelled: heardStatus !== "played",
	    });
	    if (heardStatus === "played") this.updateDurableMemoryFromAssistant(unit);
		  }

		  updateDurableMemoryFromAssistant(unit) {
		    const memory = this.state.durableMemory || createDurableMemory();
		    this.state.durableMemory = memory;
		    const item = {
		      text: unit.text,
		      turnId: unit.turnId || this.state.turnId,
		      inputVersion: unit.inputVersion,
		      at: new Date().toISOString(),
		      evidenceIds: unit.evidenceIds || [],
		      usefulness: unit.usefulness,
		    };
		    if (unit.kind === "answer" || unit.usefulness === "substantive") addBoundedMemory(memory.answered, item, 20);
		    if (String(unit.text || "").includes("?")) addBoundedMemory(memory.questionsAsked, item, 20);
		  }

		  retainedConversationContext() {
		    const recentIds = new Set(this.state.conversation.slice(-12).map((entry) => entry.turnId || entry.speechId || `${entry.role}:${entry.content}`));
		    const older = this.state.conversation
		      .slice(0, -12)
		      .filter((entry) => {
		        if (recentIds.has(entry.turnId || entry.speechId || `${entry.role}:${entry.content}`)) return false;
		        if (entry.role === "user") return looksLikeSalientFact(entry.content || "") || hasYesNoOnlyConstraint(entry.content || "") || hasCorrection(entry.content || "");
		        return entry.role === "assistant" && entry.heardStatus === "played" && (entry.usefulness === "substantive" || String(entry.content || "").includes("?"));
		      })
		      .slice(-10)
		      .map((entry) => ({
		        role: entry.role,
		        content: entry.role === "assistant" ? (entry.heardContent || entry.content || "") : entry.content,
		        kind: entry.kind,
		        usefulness: entry.usefulness,
		        heardStatus: entry.heardStatus,
		        inputVersion: entry.inputVersion,
		      }));
		    return {
		      olderSalientTurns: older,
		      pausedConversation: this.state.pausedConversation,
		    };
		  }

		  hasRecentlyAskedSameThing(text) {
		    const normalized = normalizeTranscriptForTurn(text);
		    if (!normalized || !String(text || "").includes("?")) return false;
		    return this.state.conversation.slice(-8).some((entry) => (
		      entry.role === "assistant" &&
		      /played|interrupted/.test(String(entry.heardStatus || "")) &&
		      normalizeTranscriptForTurn(entry.content) === normalized
		    ));
		  }

		  hasQuestionAnsweredByHistory(text) {
		    const normalizedQuestion = normalizeTranscriptForTurn(text);
		    if (!normalizedQuestion || !String(text || "").includes("?")) return false;
		    const recentUser = this.state.conversation
		      .slice(-12)
		      .filter((entry) => entry.role === "user")
		      .map((entry) => normalizeTranscriptForTurn(entry.content))
		      .join(" ");
		    const retainedUser = [
		      ...(this.state.durableMemory?.facts || []),
		      ...(this.state.durableMemory?.constraints || []),
		      ...(this.state.durableMemory?.corrections || []),
		    ].map((entry) => normalizeTranscriptForTurn(entry.text)).join(" ");
		    const knownUser = `${recentUser} ${retainedUser}`.trim();
		    if (!knownUser) return false;
		    const saysDead = /\b(dead|deceased|no longer alive|no longer part of us|not alive)\b/.test(knownUser);
		    if (saysDead && /\b(alive|still alive|living|living thing)\b/.test(normalizedQuestion)) return true;
		    if (/\bfamous\b/.test(knownUser) && /\bfamous\b/.test(normalizedQuestion)) return true;
		    if (/\b(tech|technology)\b/.test(knownUser) && isPlainTechnologyDomainQuestion(normalizedQuestion)) return true;
		    return false;
		  }

	  isQuestionIncompatibleWithUserActivity(text) {
	    if (!String(text || "").includes("?")) return false;
	    const retainedText = [
	      this.state.durableMemory?.chosenTask?.text || "",
	      ...(this.state.durableMemory?.facts || []).map((entry) => entry.text),
	      ...(this.state.durableMemory?.constraints || []).map((entry) => entry.text),
	    ].join(" ");
	    const recentText = `${this.state.finalizedTranscript || ""} ${this.state.provisionalTranscript || ""} ${this.state.conversation.slice(-10).map((entry) => entry.content || "").join(" ")} ${retainedText}`;
	    if (!hasGuessingGameContext(recentText)) return false;
	    const normalized = normalizeTranscriptForTurn(text);
	    if (/\b(hint|detail|what kind of hint|give me|share)\b/.test(normalized)) return true;
	    if (hasYesNoOnlyConstraint(recentText) && !isDiscriminatingYesNoQuestion(text)) return true;
	    if (/\b(dead|deceased|no longer alive|not alive)\b/.test(normalizeTranscriptForTurn(recentText)) && /\b(alive|living|living thing)\b/.test(normalized)) return true;
	    if (/\b(tech|technology)\b/.test(normalizeTranscriptForTurn(recentText)) && /\b(arts|entertainment|biology|chemistry)\b/.test(normalized)) return true;
	    return false;
	  }

	  constrainedGameFallbackQuestion(rejectedText = "") {
	    const retainedText = [
	      this.state.durableMemory?.chosenTask?.text || "",
	      ...(this.state.durableMemory?.facts || []).map((entry) => entry.text),
	      ...(this.state.durableMemory?.constraints || []).map((entry) => entry.text),
	    ].join(" ");
	    const recentText = `${this.state.finalizedTranscript || ""} ${this.state.provisionalTranscript || ""} ${this.state.conversation.slice(-18).map((entry) => entry.content || "").join(" ")} ${retainedText}`;
	    if (!hasGuessingGameContext(recentText)) return "";
	    const asked = new Set(this.state.conversation
	      .filter((entry) => entry.role === "assistant")
	      .map((entry) => normalizeTranscriptForTurn(entry.content)));
	    const normalizedRecent = normalizeTranscriptForTurn(recentText);
	    const candidates = [];
	    if (/\b(tech|technology)\b/.test(normalizedRecent)) {
	      candidates.push("Was this person known for inventing something?");
	      candidates.push("Was this person active before 1950?");
	    }
	    if (/\b(dead|deceased|not alive|no longer alive)\b/.test(normalizedRecent)) {
	      candidates.push("Was this person active before 1900?");
	    }
	    candidates.push("Was this person from Europe?");
	    candidates.push("Did this person work mainly in science?");
	    const rejected = normalizeTranscriptForTurn(rejectedText);
	    return candidates.find((candidate) => !asked.has(normalizeTranscriptForTurn(candidate)) && normalizeTranscriptForTurn(candidate) !== rejected) || "";
	  }

		  advanceConversationTurn() {
	    this.state.turnId = nanoid();
	    this.state.currentTurnUserCommitted = false;
	    this.state.currentUserConversationIndex = null;
	    this.state.currentTurnAssistantCount = 0;
	    this.state.resumeIntentText = null;
	  }
	}

function terms(text) {
  const stop = new Set("the a an and or to of in for on with i we you our should what how is are do does did this that it my me if without into from about instead".split(" "));
  return String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
	    .filter((term) => term.length > 2 && !stop.has(term));
}

function isShortFollowup(text) {
  const normalized = String(text || "").toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 3) return true;
  return words.length <= 8 && /\b(okay|ok|yes|yeah|sure|so|then|next|first|test|try|what|which|how)\b/.test(normalized);
}

function isClarificationAnsweredByCurrentDetails(questionText, preparedText, currentText) {
  const question = normalizeTranscriptForTurn(questionText);
  const current = normalizeTranscriptForTurn(currentText);
  if (!question || !current) return false;
  if (!/\b(full name|your name|event name|public details)\b/.test(question)) return false;
  if (!/\b(event name|public details|image|google|search|find)\b/.test(question)) return false;
  const preparedTerms = new Set(terms(preparedText || ""));
  const newTerms = terms(currentText).filter((term) => !preparedTerms.has(term));
  if (!newTerms.length) return false;
  const hasEventFrame = /\b(event|organizer|conference|summit|meetup|today|tonight|tomorrow|san francisco|sf)\b/.test(current);
  const hasNewSpecificDetail = newTerms.some((term) => (
    term.length >= 3 &&
    !["event", "organizer", "image", "google", "search", "find", "today"].includes(term)
  ));
  return hasEventFrame && hasNewSpecificDetail;
}

function isKnownTaskEditingFollowup(text) {
  const normalized = normalizeTranscriptForTurn(text);
  if (!normalized) return false;
  return /\b(make it|less|more|warmer|warmth|stiff|polished|sendable|tighten|shorter|longer|rewrite|revise|use that|add|remove|just help|help with the email|task is the email)\b/.test(normalized);
}

function isWritingTask(text) {
  const normalized = normalizeTranscriptForTurn(text);
  return /\b(email|reply|note|message|text|draft|write|sendable|clara|signoff)\b/.test(normalized);
}

function isDraftLikeResponseToKnownWritingTask(text, conversation = [], currentText = "") {
  const task = recentUserTaskFromConversation(conversation, currentText);
  if (!task || !isWritingTask(task)) return false;
  const normalized = normalizeTranscriptForTurn(text);
  return isWritingTask(text) || /\b(hi|dear|thanks|thank you|appreciate|monday|friday|tuesday|works|available|review|kickoff)\b/.test(normalized);
}

function isBusinessResearchTopic(text) {
  return /\b(pricing|annual|checkout|conversion|retention|onboarding|enterprise|support|security|growth|experiment|benchmark|benchmarks|competitor|industry|market|external|public|web)\b/i.test(String(text || ""));
}

function hasExplicitOutcome(text) {
  return /\b(optimi[sz]e|goal|outcome|target|success|decide|decision|choose|recommend|increase|reduce|lower|raise|improve|grow|protect|avoid|compare|benchmark against|look for)\b/i.test(String(text || ""));
}

function hasDecisionTerm(text) {
  return /\b(pricing|annual|checkout|conversion|retention|onboarding|enterprise|support|security|growth|experiment|productivity|billing|churn|activation)\b/i.test(String(text || ""));
}

function hasBusinessConversationContext(conversation = []) {
  return conversation.some((entry) => isBusinessResearchTopic(entry.content || ""));
}

function hasYesNoOnlyConstraint(text) {
  const normalized = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return /\b(only|just)\b.{0,40}\b(reply|answer|response|say)\b.{0,40}\b(yes|no)\b/.test(normalized) ||
    /\b(only|just)\b.{0,40}\b(reply|answer|response|say)\b.{0,40}\bcan\b.{0,20}\bbe\b.{0,20}\b(yes|no)\b/.test(normalized) ||
    /\bmy\b.{0,20}\bonly\b.{0,40}\b(reply|answer|response)\b.{0,40}\b(yes|no)\b/.test(normalized) ||
    /\b(yes or no|yes no|no or yes)\b/.test(normalized);
}

function isDiscriminatingYesNoQuestion(text) {
  const normalized = String(text || "").toLowerCase().replace(/[^a-z0-9'?]+/g, " ").trim();
  if (!/\?$/.test(String(text || "").trim())) return false;
  if (/\b(hint|detail|achievement|company|share|give|tell me|would you like|do you want)\b/.test(normalized)) return false;
  if (/\bor\b/.test(normalized)) return false;
  return /^(is|are|was|were|did|does|do|has|have|can|could|would)\b/.test(normalized);
}

function hasGuessingGameContext(text) {
  const normalized = normalizeTranscriptForTurn(text);
  return /\b(guess who|guess person|guessing game|guess what|guess what i have|what i have in mind|thinking about|twenty questions|20 questions|yes or no|only reply can be yes or no|ask me questions)\b/.test(normalized);
}

function normalizeTranscriptForTurn(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nonLatinSpans(text) {
  return String(text || "").match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Greek}\p{Script=Cyrillic}][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Greek}\p{Script=Cyrillic}\p{M}\p{N}\s.'-]{0,80}/gu) || [];
}

function sharesNonLatinSpan(left, right) {
  const rightSpans = new Set(nonLatinSpans(right).map((span) => normalizeTranscriptForTurn(span)).filter(Boolean));
  if (!rightSpans.size) return false;
  return nonLatinSpans(left).some((span) => rightSpans.has(normalizeTranscriptForTurn(span)));
}

function requiredCurrentNonLatinSpans(text) {
  const raw = String(text || "").trim();
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Greek}\p{Script=Cyrillic}]/u.test(raw)) return [];
  const normalized = normalizeTranscriptForTurn(raw);
  if (!/\b(answer|name|named|called)\b/.test(normalized)) return [];
  if (/\b(not|without|only)\b.{0,80}\b(answer|name|named|called)\b/.test(normalized)) return [];
  const sentence = raw.split(/[.!?]/).find((part) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Greek}\p{Script=Cyrillic}]/u.test(part) && /\b(answer|name|named|called)\b/i.test(part)) || raw;
  return [...new Set(nonLatinSpans(sentence).map((span) => normalizeTranscriptForTurn(span)).filter(Boolean))];
}

function isBareShortReply(text) {
  const normalized = normalizeTranscriptForTurn(text);
  return /^(yes|yeah|yep|sure|no|nope|oui|maybe|not sure|i don t know|dunno)$/.test(normalized);
}

function isBridgeObviouslyUnhelpful(text, conversation = []) {
  const normalized = normalizeTranscriptForTurn(text);
  if (!normalized) return true;
  if (isBareShortReply(text)) return true;
  if (/^(yo|yo what's up|yo whats up|hey|hi|hello|sup|what's up|whats up|good morning|good afternoon|good evening)$/.test(normalized)) return true;
  if (/^(ok|okay|got it|thanks|thank you|cool|great|nice|right|correct|exactly|sure thing)$/.test(normalized)) return true;
  if (/^(bye|goodbye|see you|that s all|thats all|no thanks|stop|we re done|were done)$/.test(normalized)) return true;
  const recent = conversation.slice(-8).map((entry) => entry.content || "").join(" ");
  if (hasGuessingGameContext(recent) && /^(yes|yeah|yep|no|nope|oui|maybe|not sure|i don t know|dunno)$/.test(normalized)) return true;
  return false;
}

function hasMeaningfulBridgeCue(text, conversation = []) {
  const normalized = normalizeTranscriptForTurn(text);
  if (!normalized || isBridgeObviouslyUnhelpful(text, conversation)) return false;
  if (hasGuessingGameContext(`${conversation.slice(-8).map((entry) => entry.content || "").join(" ")} ${text}`)) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  if (/\b(wait|pause|stop|hold on|hang on|one sec|one second|give me a second)\b/.test(normalized)) return false;
  return /\b(research|look up|check|find|search|compare|benchmark|assess|analy[sz]e|investigate|explain|summari[sz]e|walk me through|help me|write|draft|build|fix|implement|current|latest|pricing|conversion|retention|onboarding|risk|competitor|market|public|web)\b/.test(normalized);
}

function hasPartialUtteranceAcknowledgementCue(text) {
  const raw = String(text || "").trim();
  const normalized = normalizeTranscriptForTurn(text);
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 5 || words.length > 100) return false;
  if (/[?]$/.test(raw)) return false;
  if (/^(yes|yeah|yep|no|nope|ok|okay|thanks|thank you|hi|hello|hey)\b/.test(normalized)) return false;
  if (isExplicitHoldRequest(text) || isExplicitDismissalRequest(text)) return false;
  if (/\b(wait|pause|stop|hold on|hang on|one sec|one second|give me a second)\b/.test(normalized)) return false;
  const explicitCue = /\b(and|because|so|but|which|that|where|when|while|then)\b.{0,80}$/.test(normalized) ||
    /\b(i mean|what i need|the thing is|for context|basically|for example)\b/.test(normalized);
  if (explicitCue) return true;
  const hasNonLatinScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Devanagari}\p{Script=Arabic}\p{Script=Hebrew}]/u.test(raw);
  const sustainedSpeechWordFloor = hasNonLatinScript ? 5 : 7;
  if (words.length < sustainedSpeechWordFloor) return false;
  if (isBareShortReply(text)) return false;
  return !/[.!?]["')\]]?\s*$/.test(raw) || words.length >= 10;
}

function listenerAcknowledgementText(text) {
  const normalized = normalizeTranscriptForTurn(text);
  if (/\b(i mean|what i need|the thing is|for context|basically)\b/.test(normalized)) return "Okay.";
  return "Mm-hm.";
}

function isUnclearFragment(text) {
  const normalized = normalizeTranscriptForTurn(text);
  if (!normalized) return false;
  if (isBareShortReply(text)) return false;
  return /^(wait|what|huh|sorry|again|say again|come again|which one|that one|what thing|what things|things you can do)$/i.test(normalized);
}

function isExplicitHoldRequest(text) {
  const normalized = normalizeTranscriptForTurn(text);
  return /^(wait|hold on|hang on|one second|one sec|pause|stop for a second|give me a second|give me a minute|just a second|just a minute)$/.test(normalized);
}

function isExplicitContinueRequest(text) {
  const normalized = normalizeTranscriptForTurn(text);
  return /^(continue|go on|keep going|carry on|resume|okay continue|ok continue|you can continue|please continue)$/.test(normalized);
}

function isExplicitDismissalRequest(text) {
  const normalized = normalizeTranscriptForTurn(text);
  return /^(no thanks|not interested|stop|stop there|actually stop there|stop please|please stop|leave me|leave me alone|leave it there|don'?t call|do not call|go away)$/.test(normalized) ||
    /^stop (talking|speaking|calling|responding|replying|it|that|now)$/.test(normalized);
}

function isPresenceCheckRequest(text) {
  const normalized = normalizeTranscriptForTurn(text);
  if (!normalized) return false;
  if (/\b(say|said|type|typed|write|wrote|quote|quoted|called|phrase|example)\b.{0,40}\b(are you still here|you still there|still with me)\b/.test(normalized)) return false;
  return /^(are you still here|are you there|you there|you still there|still there|still with me|hello are you there|can you hear me|did you freeze|did you get stuck|are you dead|are you alive)$/.test(normalized);
}

function isPresenceStatusAnswer(text) {
  const normalized = normalizeTranscriptForTurn(text);
  if (!normalized) return false;
  return /\b(i am|i m|still|not)\b.{0,40}\b(dead|alive|here|there)\b/.test(normalized) ||
    /\bnot dead\b/.test(normalized);
}

function isUserCriticismOrMetaRepair(text) {
  const normalized = normalizeTranscriptForTurn(text);
  return /\b(why|you|that)\b.{0,80}\b(suck|bad|wrong|ignored|missed|misheard|not listening|stale|repeated|irrelevant|nonsense)\b/.test(normalized) ||
    /\b(stop asking|already told you|pay attention|listen|that is not what i said)\b/.test(normalized) ||
    /\bkeep\b.{0,40}\brepeat(?:ing)?\b/.test(normalized) ||
    /\brepeat(?:ing)?\b.{0,40}\b(same thing|again)\b/.test(normalized) ||
    /\bworse and worse\b/.test(normalized);
}

function repairClarificationFor(text, conversation = []) {
  const normalized = normalizeTranscriptForTurn(text);
  if (!normalized) return "";
  const priorTask = recentUserTaskFromConversation(conversation, text);
  if (isPresenceCheckRequest(text)) {
    return priorTask
      ? "I'm here. I got stuck for a moment, but I'm back in the same thread."
      : "I'm here. I got stuck for a moment, but I'm back.";
  }
  if (isUserCriticismOrMetaRepair(text)) {
    return priorTask
      ? `You're right, I drifted from "${priorTask}". Should I tighten that answer or change approach?`
      : "You're right, I drifted. What should I focus on now?";
  }
  if (hasUnderspecifiedCorrection(text)) {
    return "Got it. What should I replace that with?";
  }
  if (isUnclearFragment(text)) {
    const recentAssistantQuestion = [...conversation].reverse().find((entry) => entry.role === "assistant" && /\?\s*$/.test(entry.content || ""));
    if (!recentAssistantQuestion && priorTask) {
      return `I may have missed what was unclear about "${priorTask}". Should I clarify the recommendation or the evidence?`;
    }
    return recentAssistantQuestion ? "I may have misheard. Could you say that once more?" : "I may have missed that. What did you want me to do?";
  }
  return "";
}

function recentUserTaskFromConversation(conversation = [], currentText = "") {
  const current = normalizeTranscriptForTurn(currentText);
  for (const entry of [...conversation].reverse()) {
    if (entry.role !== "user") continue;
    const content = String(entry.content || "").trim();
    if (!content) continue;
    const normalized = normalizeTranscriptForTurn(content);
    if (!normalized || normalized === current) continue;
    if (isUnclearFragment(content) || isUserCriticismOrMetaRepair(content) || isExplicitHoldRequest(content) || isExplicitContinueRequest(content)) continue;
    if (terms(content).length < 3) continue;
    return content.length > 90 ? `${content.slice(0, 87).trim()}...` : content;
  }
  return "";
}

function hasUnderspecifiedCorrection(text) {
  const normalized = String(text || "").toLowerCase();
  if (!/\b(actually|instead|rather|not|no longer|switch|change|different|focus)\b/i.test(normalized)) return false;
  const meaningful = terms(normalized).filter((term) => !["actually", "instead", "rather", "longer", "switch", "change", "different", "focus"].includes(term));
  return meaningful.length < 3;
}

function isPlainTechnologyDomainQuestion(normalizedQuestion) {
  if (!/\b(tech|technology|technical|industry|field|sector|startup|startups)\b/.test(normalizedQuestion)) return false;
  if (/\b(founder|cofounder|co founder|engineer|developer|programmer|employee|employed|executive|ceo|cto|manager|investor|designer|inventor|scientist|researcher|professor)\b/.test(normalizedQuestion)) return false;
  return /\b(involved|work|works|worked|working|part|industry|field|sector|startup|startups|tech|technology|technical)\b/.test(normalizedQuestion);
}

function materialCorrectionSpan(text) {
  const normalized = String(text || "").toLowerCase();
  const cue = normalized.match(/(?:^|[.!?]\s+)\s*(actually|correction|correct that|instead|rather|no longer|stop|change|focus on|make it about|forget that|different|switch|wrong|no\b|nope\b|not that\b|not\b)(.{0,180})/i);
  if (!cue) return "";
  const span = cue[0].trim();
  if (/^(no|nope)\b\s*(fixes?|advice|problem\s*solv|reassur)/i.test(span)) return "";
  if (/^not\b\s+(because|sure|really|actually|going|ready|feeling|good|fine|okay|ok)\b/i.test(span)) return "";
  if (/^actually\b\s+(i|we|you|that|this|it|there|because|maybe|kind of|sort of|really)\b/i.test(span)) return "";
  return span;
}

function hasListeningOnlyPreference(text) {
  const normalized = normalizeTranscriptForTurn(text);
  return /\b(just|please|need you to|want you to)?\s*(listen|sit with|hear me|understand)\b/.test(normalized) ||
    /\b(no|not|don t|do not)\b.{0,24}\b(advice|fix|fixes|problem solve|problem solving|reassure|solution|solutions)\b/.test(normalized);
}

function isAdviceLikeSpeech(text, kind = "answer") {
  if (["acknowledgement", "repair", "closure", "silence_check"].includes(kind)) return false;
  const normalized = normalizeTranscriptForTurn(text);
  return /\b(you should|you need to|try to|what i would do|one thing|next step|plan|solution|fix|advice|send|write|make a list|tomorrow|by this weekend)\b/.test(normalized);
}

function bestEvidenceSentence(content, userText) {
  const userTerms = terms(userText);
  const sentences = String(content || "")
    .replace(/^#.*$/gm, " ")
    .replace(/\bThis is synthetic local RAG content for the voice prototype\.\s*/gi, "")
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= 24 && sentence.length <= 220);
  const ranked = sentences
    .map((sentence) => {
      const sentenceTerms = terms(sentence);
      const overlap = userTerms.filter((term) => sentenceTerms.includes(term)).length;
      const actionWeight = /\b(recommend|recommended|prefers?|asked|cited|rose|accepted|track|guardrail|risk|confusion)\b/i.test(sentence) ? 1.5 : 0;
      return { sentence, score: overlap + actionWeight };
    })
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]?.sentence || "";
  if (!best) return "";
  return firstPersonEvidenceSentence(best);
}

function firstPersonEvidenceSentence(sentence) {
  const clean = sentence
    .replace(/^Recommendation:\s*/i, "")
    .replace(/^Recommended experiment:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  const withoutPeriod = clean.replace(/[.?!]\s*$/, "");
  return `Local notes say ${withoutPeriod.charAt(0).toLowerCase()}${withoutPeriod.slice(1)}.`;
}

function contextualEvidenceQuestion(text) {
  return "What constraint matters most next?";
}

function shortFocusPhrase(text) {
  const selected = [...new Set(terms(text))]
    .filter((term) => !["public", "web", "local", "document", "documents", "benchmark", "benchmarks", "before", "after", "first"].includes(term))
    .slice(0, 4);
  if (!selected.length) return "that decision";
  const phrase = selected.join(" ");
  return phrase.length > 44 ? `${phrase.slice(0, 41).trim()}...` : phrase;
}

function canPlanFromPartial(text) {
  const normalized = String(text || "").toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();
  if (!normalized) return false;
  if (/^(yes|yeah|yep|sure|no|nope|maybe|dunno|i don'?t know|not sure|no thanks|stop)\b/.test(normalized)) return true;
  const words = normalized.split(/\s+/).filter(Boolean);
  const meaningful = terms(normalized);
  return words.length >= 4 || meaningful.length >= 3;
}

function fastSpeechTexts() {
  return [
    "Understood. I'll leave it there.",
	    "Still with me?",
	    "I'm checking that.",
	    "Give me a moment.",
	  ];
}

function initialAcknowledgementBank() {
  return ["Mm-hm.", "Okay.", "Got it."];
}

function contextualAcknowledgementBank(text) {
  const normalized = String(text || "").toLowerCase();
  if (!normalized || isExplicitHoldRequest(text) || isExplicitContinueRequest(text)) return [];
  if (isBridgeObviouslyUnhelpful(text)) return [];
  if (/\b(web|search|look up|latest|current|today|tomorrow|benchmark|events?)\b/i.test(normalized)) {
    return ["I'm checking."];
  }
  if (/\b(local|document|notes|pricing|onboarding|retention|conversion|assess|analyze)\b/i.test(normalized)) {
    return ["Got it."];
  }
  return ["Okay.", "Got it."];
}

function speechCacheKey(text) {
  return `${config.ttsModel}:${config.ttsVoice}:pcm-24000:${String(text || "")}`;
}

function conciseQuery(text) {
  const selected = terms(text).slice(0, 10);
  return selected.length ? selected.join(" ") : String(text || "").trim().slice(0, 120);
}

function publicWebQuery(text) {
  const normalized = String(text || "").toLowerCase();
  const selected = terms(text).filter((term) => !["local", "documents", "document", "public", "web", "notes", "note", "assess"].includes(term));
  const additions = [];
  if (/\b(annual|pricing|conversion|billing|checkout)\b/i.test(normalized)) additions.push("saas", "pricing", "annual", "conversion", "benchmarks");
  if (/\b(onboarding|activation|retention|churn)\b/i.test(normalized)) additions.push("saas", "onboarding", "activation", "retention", "benchmarks");
  const expanded = [...new Set([...selected, ...additions])].slice(0, 12);
  return expanded.length ? expanded.join(" ") : conciseQuery(text);
}

function isCompatibleTranscriptRevision(query, current) {
  const queryTerms = new Set(terms(query));
  const currentTerms = new Set(terms(current));
  if (!queryTerms.size || !currentTerms.size) return false;
  const shared = [...queryTerms].filter((term) => currentTerms.has(term));
  if (shared.length >= 2) return true;
  const queryEntities = salientIntentTerms(query);
  const currentEntities = salientIntentTerms(current);
  const sharedEntities = [...queryEntities].filter((term) => currentEntities.has(term));
  if (sharedEntities.length >= 1 && shared.length >= 1) return true;
  if (mentionsSameRelativeTime(query, current) && shared.length >= 1) return true;
  return false;
}

function salientIntentTerms(text) {
  return new Set(terms(text).filter((term) => (
    term.length >= 4 &&
    !["happening", "things", "about", "would", "could", "should", "please", "tomorrow", "today"].includes(term)
  )));
}

function mentionsSameRelativeTime(left, right) {
  const l = normalizeTranscriptForTurn(left);
  const r = normalizeTranscriptForTurn(right);
  return ["today", "tomorrow", "tonight", "weekend"].some((term) => l.includes(term) && r.includes(term));
}

function jaccard(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function normalizeFault(value = {}) {
  return {
    delayMs: Math.max(0, Math.min(30_000, Number(value.delayMs || 0))),
    fail: Boolean(value.fail),
  };
}

function createDurableMemory() {
  return {
    chosenTask: null,
	    facts: [],
	    constraints: [],
	    answered: [],
	    questionsAsked: [],
	    uncertainties: [],
    corrections: [],
    rejectedAlternatives: [],
    strategy: "heuristic compact memory from finalized user turns; no extra blocking model calls; tentative language is stored separately as uncertainty.",
  };
}

function addBoundedMemory(list, item, limit) {
  if (!Array.isArray(list)) return;
  const normalized = normalizeTranscriptForTurn(item.text);
  const existing = list.findIndex((entry) => normalizeTranscriptForTurn(entry.text) === normalized);
  if (existing >= 0) list.splice(existing, 1);
  list.push(item);
  while (list.length > limit) list.shift();
}

function hasUncertainty(text) {
  return /\b(i don'?t know|not sure|maybe|probably|i guess|possibly|tentative|uncertain|unsure)\b/i.test(String(text || ""));
}

function hasCorrection(text) {
  return /\b(actually|correction|correct that|instead|rather|not\b|no longer|wrong|forget that|switch|different)\b/i.test(String(text || ""));
}

function looksLikeSalientFact(text) {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Greek}\p{Script=Cyrillic}]/u.test(text)) return true;
  const normalized = normalizeTranscriptForTurn(text);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3) return false;
  return /\b(is|was|are|were|has|have|my|the person|answer|called|named|born|dead|alive|famous|field|industry|constraint|goal|optimi[sz]e)\b/i.test(text);
}

function isQuestion(text) {
  return /\?\s*$/.test(String(text || "").trim());
}

function shouldStartPublicResearch(normalized) {
  const text = String(normalized || "");
  if (!hasDecisionTerm(text)) return false;
  if (/\b(public|web|benchmark|benchmarks|competitor|industry|market|external|current|latest|compare|comparison|research|sources?)\b/i.test(text)) return true;
  return /\b(pricing|annual|checkout|conversion|retention|onboarding|activation|enterprise|support|security|growth|experiment)\b/i.test(text) &&
    /\b(recommend|decide|assess|should|best|better|norm|typical|baseline|benchmark|market)\b/i.test(text);
}

function researchSkipReason(text, webEnabled) {
  if (!webEnabled && /\b(public|web|benchmark|market|competitor|external|current|latest)\b/i.test(String(text || ""))) return "public web disabled";
  if (!isBusinessResearchTopic(text)) return "no research-shaped business/public topic";
  if (!hasDecisionTerm(text)) return "topic lacks decision term";
  return "search heuristic did not find useful query";
}

function scrubTraceEvent(event) {
  return JSON.parse(JSON.stringify(event, (key, value) => {
    if (/key|token|secret|authorization|password|cookie/i.test(key)) return "[redacted]";
    if (typeof value === "string" && /sk-[A-Za-z0-9_-]{20,}/.test(value)) return value.replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted]");
    return value;
  }));
}
