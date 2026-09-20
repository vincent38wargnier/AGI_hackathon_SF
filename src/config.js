import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

const candidateEnvFiles = [
  path.resolve(process.cwd(), ".env"),
];

for (const file of candidateEnvFiles) {
  if (fs.existsSync(file)) dotenv.config({ path: file, override: false, quiet: true });
}

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 4793),
  openaiApiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_PLATFORM_API_KEY || "",
  communicatorModel: process.env.OPENAI_COMMUNICATOR_MODEL || "gpt-4.1-2025-04-14",
  bridgeModel: process.env.OPENAI_BRIDGE_MODEL || "gpt-5.4-nano",
  bridgeTimeoutMs: Number(process.env.OPENAI_BRIDGE_TIMEOUT_MS || 1200),
  webSearchModel: process.env.OPENAI_WEB_SEARCH_MODEL || process.env.OPENAI_COMMUNICATOR_MODEL || "gpt-4.1-2025-04-14",
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-transcribe",
  realtimeTranscribeModel: process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-live-transcribe",
  // STT hints (benchmarked 2026-09-19: domain prompt fixes vocab like "SaaS",
  // language left unset = EN/FR auto; see gc-voice-leg/stt-bench/)
  realtimeTranscribePrompt: process.env.OPENAI_TRANSCRIBE_PROMPT || "Business voice assistant conversation, English or French. Vocabulary: churn, pricing, enterprise, SaaS, onboarding, page, tunnel, benchmarks.",
  realtimeTranscribeLanguage: process.env.OPENAI_TRANSCRIBE_LANGUAGE || "",
  ttsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
  ttsVoice: process.env.OPENAI_TTS_VOICE || "alloy",
  // Brain provider A/B: "openai" (default, unchanged behavior) or "gc" (General Compute)
  brainProvider: (process.env.BRAIN_PROVIDER || "openai").toLowerCase(),
  gcBaseUrl: process.env.GC_BASE_URL || "https://api.generalcompute.com",
  gcApiKey: process.env.GC_API_KEY || "",
  gcBrainModel: process.env.GC_BRAIN_MODEL || "gpt-oss-120b",
  gcBridgeModel: process.env.GC_BRIDGE_MODEL || "gpt-oss-120b",
  // Gradium (voice AI sponsor): TTS voice + optional STT ears
  ttsProvider: (process.env.TTS_PROVIDER || "openai").toLowerCase(),
  sttProvider: (process.env.STT_PROVIDER || "openai").toLowerCase(),
  gradiumApiKey: process.env.GRADIUM_API_KEY || "",
  gradiumBase: process.env.GRADIUM_BASE || "wss://us.api.gradium.ai",
  gradiumVoiceId: process.env.GRADIUM_VOICE_ID || "",
  gradiumSttLanguage: process.env.GRADIUM_STT_LANGUAGE || "any",
  gradiumSttDelayFrames: Number(process.env.GRADIUM_STT_DELAY_FRAMES || 16),
  // ask_claude delegated-work engine (ported from the Boson bridge)
  claudeBin: process.env.CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude"),
  claudeModel: process.env.CLAUDE_TASK_MODEL || "claude-sonnet-4-6",
  claudeTaskDir: process.env.CLAUDE_TASK_DIR || path.resolve(process.cwd(), "claude-tasks"),
  claudeScratchDir: path.join(process.env.CLAUDE_TASK_DIR || path.resolve(process.cwd(), "claude-tasks"), "scratch"),
  claudeTimeoutMs: Number(process.env.CLAUDE_TASK_TIMEOUT_MS || 240000),
  // Semantic endpointer: classify end_candidates as COMPLETE/INCOMPLETE so
  // mid-thought pauses do not steal the turn. off = identical behavior.
  semanticEndpoint: (process.env.SEMANTIC_ENDPOINT || "off").toLowerCase() === "on",
  endpointModel: process.env.SEMANTIC_ENDPOINT_MODEL || "gpt-oss-120b",
  endpointTimeoutMs: Number(process.env.SEMANTIC_ENDPOINT_TIMEOUT_MS || 850),
  endpointMaxHoldMs: Number(process.env.SEMANTIC_ENDPOINT_MAX_HOLD_MS || 8000),
};

export function publicProviderConfig() {
  const gcBrain = config.brainProvider === "gc";
  return {
    provider: "openai",
    brainProvider: config.brainProvider,
    communicatorModel: gcBrain ? config.gcBrainModel : config.communicatorModel,
    bridgeModel: gcBrain ? config.gcBridgeModel : config.bridgeModel,
    webSearchModel: config.webSearchModel,
    embeddingModel: config.embeddingModel,
    transcribeModel: config.transcribeModel,
    realtimeTranscribeModel: config.realtimeTranscribeModel,
    ttsModel: config.ttsProvider === "gradium" ? "gradium-default" : config.ttsModel,
    ttsVoice: config.ttsProvider === "gradium" ? (config.gradiumVoiceId || "default") : config.ttsVoice,
    ttsProvider: config.ttsProvider,
    sttProvider: config.sttProvider,
    hasApiKey: Boolean(config.openaiApiKey),
  };
}
