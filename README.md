# Voice agent with humanized turn-taking — AGI Hackathon SF

A browser voice assistant that behaves like a human on a call: it plans while you
speak, acknowledges before it answers, holds the floor when you pause mid-thought,
streams speech back with sub-second turn-taking — and when you ask it to *build*
something, it delegates the work to a Claude Code CLI worker and keeps talking
while the build runs.

Built at the **AGI Hackathon SF** on top of **General Compute** (sponsor) fast
inference: the conversational brain, the bridge acknowledgements, and the semantic
endpointer all run on `gpt-oss-120b` served by General Compute. **Gradium**
(sponsor) provides the streaming TTS voice and a candidate STT path; OpenAI
provides realtime STT (kept as the deployed ears), embeddings, and web search.

## Headline results (measured, same prompts, same app)

- Brain decision call (full system prompt + tools, median of 5):
  **620 ms** on GC `gpt-oss-120b` vs **1,087 ms** on `gpt-4.1` baseline (~1.75x faster).
- Contextual bridge acknowledgements ("Let me pull that up."):
  **0/10 usable** on the OpenAI nano baseline → **10/10 usable** on GC, at 267–603 ms.
- Plan-call reliability in the scripted 6-turn A/B: baseline **4/6** plan calls
  completed (2 hard failures) → GC **7/7**, zero failures.
- Semantic endpointer verdicts: **12/12 correct** on an EN+FR eval set,
  classifier latency **median 229 ms** — well inside the race budget.
- TTS first audio: **~280 ms** on Gradium (270–320 ms measured) vs
  **454–975 ms** on OpenAI `gpt-4o-mini-tts` across the same day's traces —
  roughly 400 ms shaved off every spoken reply, including bridge acks.
- STT A/B: Gradium ASR hit **100%** word accuracy on the clean bench with zero
  hints (OpenAI 100% with a domain prompt); OpenAI kept as deployed ears because
  its word-level partial deltas feed plan-ahead tighter than Gradium's ~1.3 s
  segment cadence. Gradium ears are one env flip away (`STT_PROVIDER=gradium`).
- First audio on the greeting turn: **2.5 s → 1.1 s**.

Full measurements, methodology, and honest caveats: [RESULTS.md](RESULTS.md).

## Architecture

Gradium mouth → OpenAI ears → General Compute brain → Claude CLI hands.

```
Browser (public/)
  mic capture → 24kHz PCM16 over WS ─────────► STT: OpenAI realtime (deployed)
  live partial transcripts, activity feed,        or Gradium ASR (STT_PROVIDER)
  PCM streaming playback, WS auto-reconnect
        │
        ▼
Node server (src/server.js)
  SessionRuntime (src/sessionRuntime.js)
    turn control, interruption, speech ledger,
    plan-ahead ("prepared speech"), stall reaper
        │
        ├─ brain: plan + respond ───────────► General Compute gpt-oss-120b
        ├─ bridge acks (beat 900ms canned) ─► General Compute gpt-oss-120b
        ├─ semantic endpointer
        │    (COMPLETE / INCOMPLETE /
        │     AMBIGUOUS, fail-open +
        │     heuristic fallback) ──────────► General Compute gpt-oss-120b
        ├─ ask_claude: delegated builds ────► Claude Code CLI (src/claudeEngine.js)
        │    task ledger, single-flight,        results published under /files/
        │    correction absorption
        ├─ web search ──────────────────────► OpenAI Responses API
        ├─ embeddings / local RAG ──────────► OpenAI + local-documents/
        └─ TTS (streaming PCM) ─────────────► Gradium (48kHz, ~280ms first audio)
                                                or OpenAI (TTS_PROVIDER)
```

Key humanized behaviors:

- **Two-client provider split** (`src/openaiProvider.js`): `BRAIN_PROVIDER=gc`
  routes the brain + bridge to General Compute; `BRAIN_PROVIDER=openai` is
  byte-identical to the baseline. `TTS_PROVIDER` / `STT_PROVIDER` toggle the
  Gradium voice and ears the same way.
- **Semantic endpointer** (`SEMANTIC_ENDPOINT=on`): voice finals are classified
  COMPLETE/INCOMPLETE before committing the turn, so "So, what I want is…
  [pause]" holds the floor instead of triggering an answer to the fragment.
  Hardened: one single-flight classification per utterance (re-deliveries reuse
  it, late results stay usable), a fragment-aware heuristic fallback on
  timeout (trailing conjunctions/articles hold, complete sentences commit),
  late-COMPLETE promotion, and a hard dead-air ceiling.
- **ask_claude — delegated work** (`src/claudeEngine.js`): "build me a landing
  page" gets an instant spoken ack while a detached Claude Code CLI worker
  builds it; the conversation stays live. A task ledger keeps it sane:
  single-flight per topic (duplicate requests suppressed), corrections spoken
  mid-build are absorbed and land as exactly ONE enriched follow-up edit
  (session-continued, edit-in-place), and the finished page is served under
  `/files/` and announced out loud with the link.
- **Gradium streaming TTS**: 48 kHz PCM over WebSocket, ~280 ms to first audio;
  sample-rate plumbing flows end-to-end so the browser plays it natively.
- **Bridge acknowledgements**: a contextual LLM ack races a 900 ms canned
  fallback while slow work (e.g. web search or a Claude build) runs.
- **Plan-ahead**: the brain plans during the user's turn, so many answers are
  committed within ~1–3 ms of turn end.
- **Resilience**: WS auto-reconnect with realtime-STT session resume, and a
  stall reaper that frees the runtime when a browser vanishes mid-playback.
- **STT hints**: a domain prompt on the realtime session (fixes "SAS"→"SaaS"
  class errors) with language auto-detect kept so French still works.
- **Live activity feed**: transcript turns, endpointer verdicts, searches,
  bridge lines, Claude build lifecycle ("building… / done (77s) / noted — will
  fold into the running build"), and connection drops streamed into the UI.

## Run it

Requires Node.js 20+, an OpenAI API key, and a General Compute API key.
Optional: a Gradium API key for the low-latency voice (`TTS_PROVIDER=gradium`),
and a local `claude` CLI for the ask_claude delegated-build tool.

```sh
npm ci
cp .env.example .env   # fill in OPENAI_API_KEY, GC_API_KEY (and GRADIUM_API_KEY for the Gradium voice)
node src/server.js
```

Open http://127.0.0.1:4793 (or your `PORT`). Microphone access requires
localhost or HTTPS. The app has a shared in-memory conversation and no built-in
authentication; remote hosting needs an authenticated proxy in front — note
that `/files/` serves whatever ask_claude builds, so never expose it unauthenticated.

Tests: `node --test test/*.test.mjs` and `python3 test/run-python-acceptance.py`.
`qa/` contains browser scenario scripts used during development (some retain
workstation-specific paths).

## Hackathon context

Built for the AGI Hackathon SF. Sponsor tracks: **General Compute** — the point
is showing what low-latency open-model inference unlocks for real-time voice UX:
the latency budget freed by a 620 ms brain is what makes contextual acks,
semantic endpointing, and plan-ahead feel human instead of scripted — and
**Gradium**, whose ~280 ms first-audio streaming TTS gives the agent its voice.
