# Voice agent with humanized turn-taking — AGI Hackathon SF

A browser voice assistant that behaves like a human on a call: it plans while you
speak, acknowledges before it answers, holds the floor when you pause mid-thought,
and streams speech back with sub-second turn-taking.

Built at the **AGI Hackathon SF** on top of **General Compute** (sponsor) fast
inference: the conversational brain, the bridge acknowledgements, and the semantic
endpointer all run on `gpt-oss-120b` served by General Compute. OpenAI provides
STT (realtime transcription over WebSocket), TTS, embeddings, and web search.

## Headline results (measured, same prompts, same app)

- Brain decision call (full system prompt + 6 tools, median of 5):
  **620 ms** on GC `gpt-oss-120b` vs **1,087 ms** on `gpt-4.1` baseline (~1.75x faster).
- Contextual bridge acknowledgements ("Let me pull that up."):
  **0/10 usable** on the OpenAI nano baseline → **10/10 usable** on GC, at 267–603 ms.
- Plan-call reliability in the scripted 6-turn A/B: baseline **4/6** plan calls
  completed (2 hard failures) → GC **7/7**, zero failures.
- Semantic endpointer verdicts: **12/12 correct** on an EN+FR eval set,
  classifier latency **median 229 ms** (min 214, max 383) — well inside the race budget.
- First audio on the greeting turn: **2.5 s → 1.1 s**.

Full measurements, methodology, and honest caveats: [RESULTS.md](RESULTS.md).

## Architecture

```
Browser (public/)
  mic capture → 24kHz PCM16 over WS ─────────► OpenAI realtime STT
  live partial transcripts, activity feed,
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
        │     AMBIGUOUS, fail-open) ────────► General Compute gpt-oss-120b
        ├─ web search ──────────────────────► OpenAI Responses API
        ├─ embeddings / local RAG ──────────► OpenAI + local-documents/
        └─ TTS (streaming PCM) ─────────────► OpenAI
```

Key humanized behaviors:

- **Two-client provider split** (`src/openaiProvider.js`): `BRAIN_PROVIDER=gc`
  routes the brain + bridge to General Compute; `BRAIN_PROVIDER=openai` is
  byte-identical to the baseline.
- **Semantic endpointer** (`SEMANTIC_ENDPOINT=on`): voice finals are classified
  COMPLETE/INCOMPLETE before committing the turn, so "So, what I want is…
  [pause]" holds the floor instead of triggering an answer to the fragment.
  Timeouts fail open, with a fragment-aware heuristic fallback and a hard
  dead-air ceiling.
- **Bridge acknowledgements**: a contextual LLM ack races a 900 ms canned
  fallback while slow work (e.g. web search) runs.
- **Plan-ahead**: the brain plans during the user's turn, so many answers are
  committed within ~1–3 ms of turn end.
- **Resilience**: WS auto-reconnect with realtime-STT session resume, and a
  stall reaper that frees the runtime when a browser vanishes mid-playback.
- **Live activity feed**: transcript turns, endpointer verdicts, searches,
  bridge lines, and connection drops streamed into the UI.

## Run it

Requires Node.js 20+, an OpenAI API key, and a General Compute API key.

```sh
npm ci
cp .env.example .env   # fill in OPENAI_API_KEY and GC_API_KEY
node src/server.js
```

Open http://127.0.0.1:4793 (or your `PORT`). Microphone access requires
localhost or HTTPS. The app has a shared in-memory conversation and no built-in
authentication; remote hosting needs an authenticated proxy in front.

Tests: `node --test test/*.test.mjs` and `python3 test/run-python-acceptance.py`.
`qa/` contains browser scenario scripts used during development (some retain
workstation-specific paths).

## Hackathon context

Built for the AGI Hackathon SF. Sponsor track: **General Compute** — the point
of this project is showing what low-latency open-model inference unlocks for
real-time voice UX: the latency budget freed by a 620 ms brain is what makes
contextual acks, semantic endpointing, and plan-ahead feel human instead of
scripted.
