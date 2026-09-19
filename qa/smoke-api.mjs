import { publicProviderConfig } from "../src/config.js";
import { searchCorpus } from "../src/corpus.js";

const cfg = publicProviderConfig();
console.log(JSON.stringify({
  provider: cfg.provider,
  communicatorModel: cfg.communicatorModel,
  transcribeModel: cfg.transcribeModel,
  ttsModel: cfg.ttsModel,
  hasApiKey: cfg.hasApiKey,
  corpusHitCount: searchCorpus("pricing annual conversion feedback", "knowledge").length,
}, null, 2));

if (!searchCorpus("pricing annual conversion feedback", "knowledge").length) {
  throw new Error("Synthetic corpus search returned no results");
}
