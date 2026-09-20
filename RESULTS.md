# General Compute brain A/B — voice-agent

Date: 2026-09-19. Measurements taken against the exact code in this repo.
Referenced artifact files (bench JSONs, traces, screenshots) live in the private
working directory and are not part of this repo; the numbers are reproduced here.

## Setup

- **Working GC baseURL: `https://api.generalcompute.com`** (verified with a real chat completion through the OpenAI SDK; `/v1` also serves but the bare domain works with the SDK, so it is the recorded default in `GC_BASE_URL`).
- **Chosen GC brain model: `gpt-oss-120b`** — fastest AND most reliable with the repo's real 1,497-word system prompt + 6 tools (see benches). Also used as bridge model, with `reasoning_effort: "low"` + a 150-token cap (an 18-token cap gets eaten by hidden reasoning and returns empty).
- Two-client split in `src/openaiProvider.js`: the default OpenAI client keeps STT (realtime WS), TTS, embeddings and Responses-API web search; a second client (GC) serves `communicate()` (plan + respond, incl. all 3 retry stages) and `decideBridgeAcknowledgement()`. Toggle: `BRAIN_PROVIDER=openai|gc` (+ `GC_API_KEY`, `GC_BASE_URL`, `GC_BRAIN_MODEL`, `GC_BRIDGE_MODEL`). With `BRAIN_PROVIDER=openai` behavior is byte-identical to upstream.
- Keys are supplied via environment variables only (`OPENAI_API_KEY`, `GC_API_KEY`) — never committed or logged.

## 1. Raw model benchmarks (repo's real system prompt + tool-call turn)

Non-streaming full decision call, exactly like `communicate()` does it — median of 5 (`bench-nonstream.json`):

| model | median | range | tool call ok |
|---|---|---|---|
| **gc / gpt-oss-120b** | **620 ms** | 499–759 | 5/5, clean |
| openai / gpt-4.1-2025-04-14 (baseline) | 1,087 ms | 774–1,499 | 5/5 |
| gc / deepseek-v3.2 | 1,755 ms | 1,635–2,489 | 5/5, leaks prose before the call |
| gc / minimax-m2.7 | 2,776 ms | **675–27,722** | 5/5, catastrophic reasoning-burst tails (18 s, 28 s) |

Streaming (`smoke-results.json`, tok/s is chunk-approximate):

- Big-prompt tool-call TTFT: gpt-oss-120b ~0.9 s; gpt-4.1 0.5–0.9 s; minimax 0.65 s warm / 3.9 s cold; deepseek ~1.3 s (+ content leak).
- "Hello" content: gpt-oss ~571 tok/s, gpt-4.1 ~208 tok/s, deepseek ~44 tok/s (replied in Chinese), minimax returned empty content after 5.6 s of hidden reasoning.

## 2. Bridge-ack race (contextual LLM ack vs 900 ms canned fallback)

10 calls to the repo's real `decideBridgeAcknowledgement()` per provider, 1,200 ms abort (`bridge-race-*.json`):

| provider / model | beat 900 ms | produced a USABLE spoken ack | latencies |
|---|---|---|---|
| openai / gpt-5.4-nano | 10/10 | **0/10** | 411–770 ms |
| gc / gpt-oss-120b (reasoning low) | 10/10 | **10/10** ("Let me pull that up.") | 267–603 ms |

The OpenAI nano model is fast enough but answers `SPEAK: One moment` every time — a phrase the repo's own sanitizer bans as generic, so it parses to silence and the canned fallback always wins. The GC bridge is both faster and actually contextual. **This humanized behavior goes from effectively broken (0/10) to working (10/10).**

## 3. In-app A/B — same scripted 6-turn conversation, both providers

Driver: `ab-driver.mjs` (spawns the real server, simulates progressive STT partials via `/api/interim` in live scheduling mode, finalizes the turn, simulates browser playback acks; full traces in `ab-openai.json` / `ab-gc.json`, metrics in `ab-metrics.json`).

Turn-end → first speech committed / turn-end → first TTS audio byte (ms):

| turn | openai speech | gc speech | openai 1st audio | gc 1st audio |
|---|---|---|---|---|
| T1 greeting | 1,301 | **569** | 2,463 | **1,137** |
| T2 pricing (plan-prepared) | ~3 | ~2 | 521 | 405 |
| T3 focus choice | ~1 | ~1 | **374** | 1,267 |
| T4 churn vs notes | **1,410** | 11,957 * | **1,986** | 12,412 * |
| T5 correction → email | ~1 | ~1 | 363 | 339 |
| T6 close | 951 | **755** | 1,414 | **1,111** |

\* T4-gc decomposed from the trace: the GC respond call itself took **1,271 ms**; the 12 s wall time is an **11.1 s OpenAI Responses-API web search** that the GC brain scheduled (optional evidence) and the runtime chose to wait out before responding. It is an OpenAI-tool + runtime-scheduling artifact, not GC inference. The openai-brain run simply didn't schedule a web search on that turn. (Side finding: during those 11 s the app sat silent — the bridge only arms at turn end, a repo-level gap.)

Turns marked ~1–3 ms are the plan-mode "prepared speech" path landing instantly at turn end — the flagship humanized behavior — and it worked on BOTH providers.

Brain calls inside the app (per full trace):

| metric | openai gpt-4.1 | gc gpt-oss-120b |
|---|---|---|
| respond calls, median latency | 7 calls, 1,261 ms (898–1,815) | 4 calls, 1,012 ms (563–1,508) |
| plan calls completed | 4 of 6 started | **7 of 7 started** |
| plan calls FAILED (no usable tool decision after all 3 retries) | **2** | 0 |
| plan calls aborted for newer input | 0 | 0 |
| plan median latency | 942 ms | 1,185 ms |
| bridge released in-app | 0 (armed 2×, fallback stayed silent / chose silence) | 0 (armed 2×, suppressed-by-fast-decision / chose silence) |

Notes: in-app snapshots are much bigger than the bench prompt (conversation + evidence), hence >620 ms. gpt-4.1's two plan failures ("Communicator returned no supported tool decision") each burned 2 sequential LLM calls and produced nothing; gpt-oss never failed a plan call. The scripted turns resolved fast enough that the in-app bridge race rarely mattered (hence the standalone race in §2).

## 4. Verdict (honest)

**Faster where the brain is the bottleneck.** Raw decision calls are ~1.75× faster (620 vs 1,087 ms median); in-app, turns that waited on a live respond call landed 200–730 ms sooner and first audio ~1.3 s sooner on the greeting. Turns served by prepared speech feel identical (already instant on both).

**Humanized behaviors fixed by GC:** (1) contextual bridge acks 0/10 → 10/10 usable, and faster; (2) plan-call reliability 4/6 → 7/7 — gpt-4.1 twice returned no usable tool decision even with `tool_choice: required` retries.

**What got worse:** (1) phrasing is a notch clunkier — e.g. "For run b2b onboarding product, should I optimize for…" (grammar slip visible in shot 03); gpt-4.1's wording is smoother; (2) gpt-oss is more eager to schedule optional web searches, which surfaced an existing repo weakness (silent 11 s wait on OpenAI's slow web search — T4); (3) T3 first-audio was slower once (1.27 s vs 0.37 s, TTS cache luck). Tool-call format reliability was NOT worse — 5/5 on the bench, 100% parse rate in-app.

**Do not use** minimax-m2.7 (18–65 s reasoning bursts, empty bridge output) or deepseek-v3.2 (slower + leaks prose) for this app.

## Browser QA (GC brain live, localhost:4795, real Chrome via Playwright)

`shots/01-gc-provider-config.png` — provider popover: communicator gpt-oss-120b, key configured.
`shots/02-gc-greeting-answered.png` — greeting answered + audio played.
`shots/03-gc-rag-answer-mid-conversation.png` — mid-conversation, pricing question + assistant reply rendered in transcript.
`shots/04-gc-followup-answer.png` — orb in "Speaking" state (assistant_turn) while answering the churn follow-up.
`shots/05-gc-final-state.png` — end of session.
Session model events: 4× "Communicator respond completed" model=gpt-oss-120b, 543–870 ms (`qa-browser-timeline.txt`).
Typed input is a first-class UI path; live-mic STT (OpenAI realtime WS) was exercised only by the scripted `/api/interim` partials, not a real microphone.

## Live hotfix (2026-09-19 21:xx): real-mic turns stalled at end_candidate

Root cause (from live trace `voice-agent/artifacts/private-traces/wfqlyFuUJTgHIjP_wNvA3.jsonl`): playback confirmations are browser-sent (`/api/played`); when Vincent's browser reloaded mid-playback, speech `sp_CJRDa7` stayed status `"playing"` forever, and `wakeup("respond")` silently drops every turn-end wakeup while ANY current-epoch speech unit is unplayed — no event, no timeout, no retry. Mic turns r4/r7 AND typed r8 ("yoooo") all deadlocked; the session only recovered when an unrelated transcript correction invalidated the unit 9 minutes later.

Fix (`src/sessionRuntime.js`, +55 lines): when a respond wakeup is blocked by unplayed speech, reap stale units — `playing` older than max(15 s, 1.5× estimated audio duration + 5 s) becomes `played`; never-picked-up audio older than 30 s becomes `cancelled` — and arm a 3 s stall-retry timer so recovery is automatic. Events logged: "Respond wakeup blocked ... stall watchdog armed", "Stale playback confirmation reaped".

Proof:
- Unit tests still pass (`node --test test/runtime-speaking-layer.test.mjs`, fail 0).
- Deterministic repro (`repro-stall.mjs`): withheld `/api/played` after turn 1, sent turn 2 → previously stuck forever; with fix, reaped at 17 s and answered.
- LIVE through the tunnel (`live-qa-mic.mjs`, real Chrome + fake-audio-capture wav speaking "what is two plus two?"): STT final → gpt-oss-120b respond 448 ms → spoken reply played. Second session even hit the exact bug live (previous browser vanished mid-playback) and recovered instantly: "Stale playback confirmation reaped (ageMs 37974)". Screenshot: `shots-live/05-mic-turn-completes.png`; timeline: `live-mic-timeline.txt`.
- App restarted on the same port/env; the authenticated proxy in front of the public tunnel was untouched (unauthenticated requests still 403, authenticated entry still works).

## Semantic endpointer (2026-09-19 22:xx): mid-thought pauses no longer steal the turn

Design as built (env-gated `SEMANTIC_ENDPOINT=on`; off = byte-identical baseline):
- `src/config.js:34-37` — `semanticEndpoint`, `SEMANTIC_ENDPOINT_MODEL` (default gpt-oss-120b), `SEMANTIC_ENDPOINT_TIMEOUT_MS` (700), `SEMANTIC_ENDPOINT_MAX_HOLD_MS` (8000).
- `src/openaiProvider.js:41` — `classifyTurnCompletion()` on the GC client: temperature 0, `reasoning_effort: low`, 160-token cap (headroom for hidden reasoning), EN+FR prompt, output word COMPLETE / INCOMPLETE / AMBIGUOUS (word-boundary parse, defaults to AMBIGUOUS).
- `src/sessionRuntime.js` — voice finals route through `evaluateSemanticEndpoint()` (`receiveTranscript` → `shouldSemanticHold`, voice sources only; typed unaffected): INCOMPLETE holds the floor and keeps the fragment; the next utterance merges via `mergeHeldTranscript()` (overlap-aware so provider-final re-deliveries replace instead of duplicate); COMPLETE commits immediately; AMBIGUOUS / timeout / error / no-GC-key fail OPEN to `finalizeUserTurn()` (the extracted baseline path). Anti-hang: hard ceiling timer (8 s of dead air; budget resets when the user audibly resumes so long continuations and multi-pause sentences still classify), plus the `wakeup("respond")` guard holds only respond — plan-mode wakeups still fire during the pause, so plan-ahead keeps working. Interacts safely with the stall reaper (its retry wakeups are respond-mode, so they're held too).

Deterministic eval (`endpoint-eval.mjs`, `endpoint-eval.log`): **12/12 correct** on EN+FR transcripts (complete questions, "yes"/"oui parfait" one-worders, trailing-conjunction fragments like "so what I want is" / "et donc ce que je voudrais c'est"). Classifier latency **median 229 ms, min 214, max 383** — comfortably inside the 700 ms race.

Live A/B through the tunnel (fake-mic wavs; `mic-pause-question.wav` = "So, what I want is…" + 3.5 s silence + "…a simple page that lists our top three churn reasons."):
- **OFF** (`shots-live/06-endpointer-off-barge-in.png`, `06-*-timeline.txt`): the agent commits "So what I want is" during the pause and REPLIES to the fragment (playback 1.2 s into the pause); the sentence splits into two turns.
- **ON** (`shots-live/07-endpointer-on-waits.png`, `07-*-timeline.txt`): fragment classified INCOMPLETE in 222–431 ms → floor held, only a listener "Mm-hm." backchannel; continuation merges into ONE user turn ("So what I want is A simple page that lists our top three churn reasons.") → verdict COMPLETE (444 ms) → single full-sentence answer. One classifier abort in the run failed open and committed baseline-style — fail-open proven live.
- **ON, complete sentence** (`shots-live/08-complete-sentence-still-fast.png`, `08-*-timeline.txt`): "Hey, quick question: what is two plus two?" → COMPLETE in **251–258 ms** → respond 511–579 ms → spoken reply. Added turn-end cost for complete sentences ≈ 255 ms, hard-capped at 700 ms.

All 66 unit tests still pass. Live classifier latencies in the run: 219–520 ms.

## Live activity feed + STT accuracy (2026-09-19 23:xx)

### Activity feed (frontend-only; server already broadcast timeline events over WS)
- `public/index.html:63-74` — "Live activity" panel on the main voice screen, visible by default, collapse state persisted (localStorage).
- `public/styles.css` ("Live activity feed" section) — desktop: fixed right rail; phone (<980px): in-flow sheet above the dock, 32dvh, dock clearance via screen padding; existing OKLCH tokens only, 160ms ease-out entries with reduced-motion fallback.
- `public/app.js` (feed section + 3 hook lines at the WS handler/renderConfig/renderState) — merged stream: transcript turns (You/Agent, colored speaker tags), humanized one-liner events with tabular timestamps ("Endpointer: mid-thought (231 ms) — holding the floor", "Thinking (gpt-oss-120b)…", "Searching the web: …", "Search done — 4 results (9111 ms)", "Bridge: …", "Reply ready: …", "Speaking…"), errors in red, endpointer/recovery warnings in amber, live italic "Hearing: …" line from partial transcripts; capped at 120 entries.
- Impeccable gate: `detect.mjs` on index.html + styles.css → **0 anti-patterns** (run before and after the change).
- Live proof (tunnel, real Chrome, accented fake-mic wav triggering a real web search): `shots-live/09-activity-feed-live.png`, `10-activity-feed-during-work.png` (desktop rail streaming during work incl. "Searching the web" and a red error line), `09b/10b-activity-feed-phone*.png` (390×844). Known nit: on short phones the page scrolls slightly; the feed tail sits behind the fixed dock but scrolls within the panel.

### STT accuracy (Vincent: "always understands wrong")
Audio path checked: browser captures at device rate → downsamples to 24kHz PCM16 → WS → OpenAI realtime; no quality loss found in the pipeline itself. Realtime session config had NO language/prompt hints — added them.

Bench (8 wavs: EN with strong French accent via TTS `instructions`, short "yo yo yo"/"yes exactly" utterances, 1 real French sentence; word-accuracy vs reference; `stt-bench/results*.json`):

| config | clean audio | degraded (noise+8k) |
|---|---|---|
| A current: gpt-live-transcribe, no hints | 99% | 95% |
| B gpt-live-transcribe + language=en + prompt | 100% | — |
| **C WINNER: gpt-live-transcribe + domain prompt, no language lock (EN/FR auto)** | **100%** | **96%** |
| D gpt-4o-transcribe + prompt | 100% | **18% — hallucinates fluent French ("Entendu, je vais suivre", "Non merci")** |
| E gpt-4o-mini-transcribe + prompt | 95% | — |

Verdict: the model was never the problem on clean audio; on degraded (phone/tunnel-like) audio the "stronger" gpt-4o-transcribe collapses into hallucinations — the exact garbage-transcript symptom Vincent hit — while gpt-live-transcribe stays at 95-96%. Deployed config C: keep `gpt-live-transcribe`, add the domain prompt (fixes "SAS"→"SaaS"-class vocab errors), leave language unset so French still works. Changes: `src/config.js:24-27` (`realtimeTranscribePrompt`, `realtimeTranscribeLanguage`, env-overridable `OPENAI_TRANSCRIBE_PROMPT`/`OPENAI_TRANSCRIBE_LANGUAGE`), `src/server.js:205-206` session.update.
Live before/after: this table is the A/B; live confirmation in shots 09/10 — the strongly French-accented "Can you check the web for SaaS churn benchmarks?" is heard verbatim (Heard chip + You-turn in the feed), "SaaS" spelled correctly.

## Regression investigation (2026-09-19 ~23:50): "nothing works anymore"

Evidence gathered before touching anything (his real session trace `voice-agent/artifacts/private-traces/IOxpR_WxdOWH9vIsaWboh.jsonl`, 22:29–22:46 UTC, 1,084 events):
- NOT a frontend crash: his own browser kept sending playback acks and interims all session (deltas, EN+FR finals all correct), and 9 real answers PLAYED (22:30, 22:32, 22:40:59 web-backed churn answer, 22:45:42, 22:46:11). Clean-profile tunnel tests confirm: Chrome desktop and Chrome iPhone-viewport both ZERO console/page errors, typed + mic turns reply, feed renders. NOT the STT hints either — transcription flowed perfectly on the new config.
- The actual failure mode, visible at 22:41:29→22:44+: his browser went silent for ~3 min (phone lock / app switch); two generated answers (incl. the churn answer sp_EeIBZ4) were broadcast into the void and never played; on return the stall-reaper freed the runtime (1 reap + 5 watchdog events — it worked), but any real WS drop in this situation would have been FATAL: `public/app.js` created ONE WebSocket with **no onclose/onerror/reconnect** — a drop (phone lock, cloudflared blip) silently killed state, audio, and feed forever. Plus a painful race: his "you hear me?" reply took 4.4 s (cold call) and was discarded when he spoke again.

Fix (minimal, `public/app.js:50-91`): WS auto-reconnect (1 s → capped 5 s backoff), guarded `wsSend()` for the realtime mic messages, realtime-STT session resume on reconnect when the mic is open, and the drop/recovery is now VISIBLE in the activity feed ("Connection lost — reconnecting…" in red, "Reconnected — session restored").

Reproduce-then-fixed cycle, live through the tunnel (`live-qa-reconnect.mjs`): typed turn answered → app process killed mid-session (real WS drop) → feed shows Connection lost → auto-reconnect → typed turn answered → mic turn transcribed+committed → 0 console errors. Screenshot with the full arc in-frame: `shots-live/12-regression-fixed.png` (plus `12-regression-chrome-desktop.png`, `12-regression-chrome-iphone-viewport.png` clean-console runs).

Limits stated plainly: Playwright WebKit cannot launch on this macOS (90 s launch timeout even dequarantined), so the Safari engine itself is untested here — but the server traces prove HIS device executed the new frontend fine, so no Safari-specific breakage is in evidence. Known remaining gap: an answer generated while the browser is away is freed (reaper) but not replayed on return — the user must re-ask.

## Endpointer "cutting" fix (2026-09-20 ~00:15): fragments no longer commit on classifier timeout

Evidence from Vincent's session (`private-traces/8r6xjRCIwJukPnjVqhmD2.jsonl`): completed classifier calls ran 266/315/455/452 ms, but three calls hit the hard 700 ms abort (heldMs 702-703) under live GC tail latency — each timeout blind-committed a fragment ("Yeah, I, I want" answered with a clarification). The double "timed out" lines were STACKED classifications (optimistic final "Yeah," + provider final "Yeah, I, I want" fired separate GC calls). The red "Model respond failed — Request was aborted" was the runtime correctly aborting an obsolete respond when he spoke again — same storm, not a separate bug. Bonus finding: the 8 s dead-air ceiling also cut him once mid-think at 23:09:42.

Fix (`src/sessionRuntime.js`, `src/config.js`, `public/app.js`):
- `classifyCached()` — ONE in-flight classification per utterance text (15 s TTL); the GC call is no longer aborted at the deadline, so re-deliveries reuse it and a late result stays usable.
- `heuristicTurnVerdict()` — timeout/error fallback is now fail-SAFE for fragments: trailing comma/connector, trailing conjunction/verb/article (EN+FR list), or <4 words without terminal punctuation (with a yes/oui/ok short-answer allowlist) → HOLD (bounded by the existing ceiling); otherwise commit. 10/10 on the unit cases incl. "Yeah, I, I want" / "et donc je voudrais" / "Why is it cutting?" / "yes".
- Late-COMPLETE promotion: if the slow classifier lands COMPLETE while a heuristic hold is active, the fragment commits immediately instead of waiting for the ceiling.
- Race budget 700 → 850 ms default (browser VAD already gives 1.2 s); GC connection warm-up on session start (cold TLS no longer eats the budget).
- Feed lines now tell the truth: "Endpointer: classifier slow — holding (heuristic: trailing \"want\")" vs "— committing (no fragment signal)" vs "late complete (…ms) — committing".

Proof, live through the tunnel with a French-accented "Yeah, I, I want [3.5 s pause] a page for collecting emails." wav:
- Forced worst case (`SEMANTIC_ENDPOINT_TIMEOUT_MS=1`, every call times out): fragment HELD by heuristic, merged with the continuation — no bare-fragment answer (`13a-forced-timeout-heuristic-timeline.txt`).
- Normal config: "I I want" → INCOMPLETE 411 ms → held; merged partial → INCOMPLETE 456 ms; one real >850 ms slow call caught by the heuristic hold; merged final → COMPLETE 361 ms → ONE turn, ONE answer. `shots-live/13-cutting-fixed.png`.
- Complete sentences still fast: COMPLETE in 495/543 ms (`13b-complete-still-fast.png`).
- Live classifier latencies before/after: before-fix session had 3 hard timeouts committing fragments; post-fix runs measured 361-543 ms (median 456) with the one slow call absorbed by the heuristic hold. Unit tests 66/66 (also fixed a `localStorage` guard the feed toggle needed for the test harness/Safari private mode).

## Gradium integration (2026-09-20 ~00:55): sponsor voice (TTS) + candidate ears (STT)

Key supplied via env var (`GRADIUM_API_KEY`), never committed or logged. Protocol per Gradium's docs. Working base: `wss://us.api.gradium.ai`, auth `x-api-key`, JSON WS wire (setup → ready → text/audio → flush/eos).

### Smoke (this Mac, `smoke-gradium.mjs` / `smoke-gradium-results.json`)
- TTS: **time-to-first-audio 270-287 ms warm** (509 ms cold), 48 kHz s16le PCM out, full sentence in ~2.5 s.
- STT (language `any`, delay_in_frames 16): **100% word accuracy on all 8 bench wavs** — French-accented English AND the French sentence, "SaaS" correct with zero prompt hints; finalize 810-1643 ms after audio end.

### What was swapped
- TTS behind `TTS_PROVIDER=gradium|openai` (default openai): dispatcher + `gradiumStreamSpeech()` WS client in `src/openaiProvider.js` (~:500, same handler contract + `sampleRate` in payloads); runtime sample-rate plumbing so 48 kHz flows to the browser player (`src/sessionRuntime.js`: cache entries store `sampleRate`, `populatePreparedFromCache`/`emitCachedAudio`/`streamUnitAudioAttempt` set `audioSampleRate`/`audioMime` from the provider; client already honored `event.sampleRate`). No resampling needed anywhere.
- STT behind `STT_PROVIDER=gradium|openai` (default openai): Gradium ASR branch in `src/server.js` `startRealtime`/`appendRealtimeAudio`/`commitRealtimeAudio`/`handleRealtimeEvent` — browser 24 kHz PCM passes straight through; `text` segments → interim pipeline; browser-VAD commit → trailing silence + `flush` + `end_of_stream` → final. Our semantic endpointer stays the turn decider (Gradium `step` VAD left informational — no double-classifying).
- Config: `src/config.js` gradium block; feed shows "Speaking (gradium)…" / "Mic link ready (gradium)".

### STT A/B verdict (data)
| config | clean 8-wav accuracy | degraded (noise+8k) |
|---|---|---|
| OpenAI gpt-live-transcribe + domain prompt (deployed) | 100% | 96% |
| Gradium ASR, language=any, NO hints | **100%** | 91% raw (≈96% normalized: "2 plus 2" vs "two plus two" digit-scoring, "users"/"prices" word slips) |

Effectively a tie on accuracy. **Kept OpenAI as deployed STT** because its word-level partial deltas feed plan-mode and optimistic-finalize tighter than Gradium's ~1.3 s segment cadence (delay_in_frames 16), which would weaken plan-ahead; Gradium ears remain one env flip away (`STT_PROVIDER=gradium`) and its clean-set showing (100% with zero hints, native FR) makes it the candidate if OpenAI realtime degrades.

### Live (tunnel, mic, GC brain + endpointer on, `TTS_PROVIDER=gradium`)
- Fresh uncached turn: turn-end → first TTS audio **1,271 ms**, browser playback at **1,307 ms** — decomposed: endpointer classify 304 ms + GC respond 850 ms + Gradium first chunk ≈ 250-300 ms. Warm-cached answers play at ~135 ms.
- TTS engine like-for-like: OpenAI gpt-4o-mini-tts first chunk across today's traces 454-975 ms (median ≈ 700 ms) → Gradium ≈ **280 ms** (−400 ms on every spoken reply, incl. bridge acks and backchannels).
- Browser plays the 48 kHz stream cleanly (0 console errors); feed shows "Speaking (gradium)…". Screenshot: `shots-live/14-gradium-tts-live.png` (full arc: You → Endpointer 304 ms → Thinking → Decision 850 ms → Speaking (gradium) → moonquake answer). STT A/B table above = shot 15 equivalent.
- Deployed config on 4795: BRAIN=gc(gpt-oss-120b) + SEMANTIC_ENDPOINT=on + TTS_PROVIDER=gradium + STT=openai. GC brain untouched; unit tests 66/66.

### TTS smoke re-verified with on-disk artifacts (phase-2 leg, 2026-09-20 ~01:15)
The original TTS smoke numbers were console-only (the json kept just the STT rows). Re-run, same sentence both providers, saved to `tts-compare.json` + `smoke-gradium-rerun.log`:
- Gradium WS (48 kHz PCM): time-to-first-audio **270 / 305 / 320 ms** after text send (connect+ready ≈ 330 ms, once per utterance).
- OpenAI gpt-4o-mini-tts raw fetch (24 kHz PCM): TTFB **377 / 489 / 889 ms**.
- Gradium STT smoke also re-run: **MEAN accuracy 100%** on the 8 bench wavs again.

## ask_claude — yesterday's Boson-bridge demo, ported into this agent (2026-09-20 ~01:15)

Voice-request a build → instant spoken ack + the agent keeps chatting → Claude Code builds it detached → the result is spoken with a `/files/` link and the page is served through the tunnel; corrections spoken mid-build are absorbed and land as ONE follow-up edit.

### What was built (reusing battle-tested bridge logic from an earlier Claude-bridge project)
- `src/claudeEngine.js` (new, 91 lines) — `runClaudeTask()`: `claude -p --model claude-sonnet-4-6 --dangerously-skip-permissions --append-system-prompt <audio-mode + /files/ contract>` (binary via `CLAUDE_BIN`), cwd = `claude-tasks/scratch/`, `--continue` first (edit-in-place session continuity, the bridge trick) with plain-run fallback, 240 s timeout, CLAUDE*/ANTHROPIC* env stripped from the child, never throws — failures come back as speakable text. Log: `claude-tasks/engine.log`.
- `src/openaiProvider.js:132` — new brain tool `ask_claude` in `communicate()`'s toolset; `:204-208` system-prompt doctrine (delegate builds immediately + ack with ONE detail question, never duplicate a running build, consolidate corrections); `:368-369` maps the tool call to a `start_search` action with `source: "claude_task"`.
- `src/sessionRuntime.js` — ledger semantics ported intact: `:1040-1055` single-flight per topic (a second ask_claude while one runs → Jaccard ≥ 0.8 = "Duplicate work request suppressed", else absorbed into `pendingClaudeTask` with `"; also:"`), `:1201-1205` exactly ONE enriched follow-up fired on completion, `:1251` claude_task jobs exempt from obsolete-job cancellation. Delivery rides the existing async-job → evidence → `wakeup("respond")` flow, so the agent speaks the result naturally.
- `src/server.js:24-27` — `/files/` static route on the scratch dir (bridge publishing convention; the deployment's auth proxy covers it through the tunnel).
- `public/app.js:803-807` — feed lifecycle: "Claude: building — …", "Claude: done (77s)", "Claude: noted — will fold into the running build", "Claude: already building that", errors red.

### Live proof (tunnel, real Chrome, fake-mic wavs `mic-coffee-request.wav` / `mic-coffee-correction.wav`; run log `askclaude-run.log`, timeline `askclaude-timeline.txt`, `claude-tasks/engine.log`)
1. Voice: "Hey, can you build me a landing page for a coffee tasting club? It needs a signup form that collects email addresses." → heard verbatim, ack + detail question spoken ~4 s later ("Sure thing—what would you like to build?" … "Got it—building a coffee-tasting club landing page. Which email service should I connect the sign-up form to?"), feed shows "Claude: building — …". `shots-live/16-ask-claude-launched.png`.
2. Build ran detached 77 s (engine.log 00:11:28 → 00:12:46 "Done. /files/coffeeclub.html") while the conversation stayed live.
3. Mid-build voice correction: "Actually, make the background dark green and call the club the Roast Club." → feed "Claude: noted — will fold into the running build" (no second build started). `shots-live/18-correction-absorbed.png`. (The looping fake-mic wav re-spoke the correction ~14×; every re-hearing was absorbed into the same buffer — zero duplicate builds, exactly as designed.)
4. On completion the runtime fired ONE consolidated follow-up (engine.log 00:12:46 "Update the coffee tasting club landing page: set the background color to dark green and change the club name to Roast Club…") — an edit-in-place via `--continue`, done in 19 s.
5. Delivery spoken with the link (session trace 00:13:06): "Done—background is dark green and the name is now the Roast Club (see /files/coffeeclub.html)…" — Gradium TTS, first audio 485 ms. Feed delivery line captured live in a follow-on session: `shots-live/19-delivery-spoken-in-feed.png`.
6. The page itself through the tunnel: `shots-live/17-ask-claude-page-live.png` — dark forest green (rgb 10,31,14), "The Roast Club" branding, email signup form: BOTH spoken corrections applied. `/files/` sits behind the deployment's auth proxy (403 without).

### Known gap (honest)
Twice during QA, a longer-lived tunneled session's app WS silently stopped receiving events (~75-110 s after connect, both times right at/after a Gradium audio broadcast burst: 00:12:47 and 00:16:41). No close frame ever reached the page, so the WS-reconnect logic (which fires on onclose) never triggered, and the proxy log shows no re-upgrade attempt. The server kept working perfectly each time — builds, the follow-up, and the spoken delivery all completed (trace + engine.log) — but the frozen page missed them. Delivery WAS captured in-browser in a fresh session (`19-delivery-spoken-in-feed.png`: Claude done (23s) → Reply ready "…/files/coffeebrewtips.html" → Speaking (gradium)). Fix direction: WS keepalive ping/pong + staleness watchdog in `public/app.js`/`src/server.js`; not applied now to avoid destabilizing the proven stack right at delivery.

- Benches: `smoke-gc.mjs`, `bench-nonstream.mjs`, `bridge-race.mjs` (+ `*.json` outputs) — private working dir
- A/B: `ab-driver.mjs`, `ab-analyze.mjs`, `ab-openai.json`, `ab-gc.json`, `ab-metrics.json` — private working dir
- QA: `qa-browser.mjs`, `qa-browser-timeline.txt`, `shots/`, `shots-live/` — private working dir
- Run it: `BRAIN_PROVIDER=gc TTS_PROVIDER=gradium SEMANTIC_ENDPOINT=on node src/server.js` with `OPENAI_API_KEY`, `GC_API_KEY`, `GRADIUM_API_KEY` set as env vars
