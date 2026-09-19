import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { embedTexts } from "./openaiProvider.js";

const DOCS_DIR = path.resolve(process.cwd(), "local-documents");
const STORE_DIR = path.resolve(process.cwd(), "artifacts/rag");
const INDEX_PATH = path.join(STORE_DIR, "index.json");
const CHUNK_SIZE = 720;
const CHUNK_OVERLAP = 120;

const seedDocs = [
  {
    name: "synthetic-pricing-feedback.md",
    text: `# Synthetic AcmeFlow Pricing Feedback

This is synthetic local RAG content for the voice prototype.

In Q3 interviews, forty-two trial users said the annual discount appeared too late in checkout. Sixteen preferred the monthly plan because it was easier to understand. Eleven said annual pricing felt more credible when savings were shown before payment.

Recommended experiment: show annual savings earlier, but keep monthly plan clarity. Track support tickets about billing confusion as a guardrail.`,
  },
  {
    name: "synthetic-retention-interviews.md",
    text: `# Synthetic Retention Interviews

This is synthetic local RAG content for the voice prototype.

Churned accounts most often cited onboarding confusion and missing team templates. Pricing appeared as a secondary reason when teams had fewer than three active projects after week one.

Recommended experiment: add team templates before stronger annual-plan nudges. A pricing push alone is unlikely to fix activation problems.`,
  },
  {
    name: "synthetic-enterprise-objections.md",
    text: `# Synthetic Enterprise Objections

This is synthetic local RAG content for the voice prototype.

Enterprise prospects repeatedly asked for SSO, audit logs, and clearer admin controls before price discussions. Procurement teams accepted annual commitments when security review was complete.

Recommendation: for enterprise conversations, unblock security proof first and only then package annual commitments.`,
  },
  {
    name: "synthetic-support-load.md",
    text: `# Synthetic Support Load Notes

This is synthetic local RAG content for the voice prototype.

Support load rose when experiments changed billing labels without updating onboarding copy. Users asked whether annual seats could be downgraded mid-cycle. The team prefers experiments that increase conversion without creating ambiguous billing language.`,
  },
];

export async function ensureSeedDocs() {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.mkdir(STORE_DIR, { recursive: true });
  for (const doc of seedDocs) {
    const file = path.join(DOCS_DIR, doc.name);
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, doc.text, "utf8");
    }
  }
}

export async function refreshIndex() {
  await ensureSeedDocs();
  const files = (await fs.readdir(DOCS_DIR)).filter((name) => /\.(md|txt)$/i.test(name)).sort();
  const existing = await readIndex();
  const byHash = new Map((existing.chunks || []).map((chunk) => [chunk.hash, chunk.embedding]));
  const chunks = [];
  for (const fileName of files) {
    const fullPath = path.join(DOCS_DIR, fileName);
    const text = await fs.readFile(fullPath, "utf8");
    const documentHash = hash(text);
    const parts = chunkText(text);
    parts.forEach((content, index) => {
      const chunkHash = hash(`${documentHash}:${index}:${content}`);
      chunks.push({
        id: `${fileName}#chunk-${index + 1}`,
        fileName,
        chunkIndex: index + 1,
        documentHash,
        hash: chunkHash,
        content,
        embedding: byHash.get(chunkHash) || null,
      });
    });
  }
  const missing = chunks.filter((chunk) => !chunk.embedding);
  if (missing.length) {
    const embeddings = await embedTexts(missing.map((chunk) => chunk.content));
    missing.forEach((chunk, index) => {
      chunk.embedding = embeddings[index];
    });
  }
  const index = {
    embeddingModel: "text-embedding-3-small",
    docsDir: DOCS_DIR,
    refreshedAt: new Date().toISOString(),
    chunks,
  };
  await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
  return summarizeIndex(index);
}

export async function searchRag(query, { limit = 4 } = {}) {
  await ensureSeedDocs();
  let index = await readIndex();
  if (!index.chunks?.length || index.chunks.some((chunk) => !chunk.embedding)) {
    await refreshIndex();
    index = await readIndex();
  }
  const [queryEmbedding] = await embedTexts([query]);
  return (index.chunks || [])
    .map((chunk) => ({
      id: chunk.id,
      source: "local_rag",
      title: chunk.fileName,
      content: chunk.content,
      sourceId: chunk.id,
      fileName: chunk.fileName,
      chunkIndex: chunk.chunkIndex,
      score: cosine(queryEmbedding, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function listDocuments() {
  await ensureSeedDocs();
  const files = (await fs.readdir(DOCS_DIR)).filter((name) => /\.(md|txt)$/i.test(name)).sort();
  const stats = await Promise.all(files.map(async (name) => {
    const stat = await fs.stat(path.join(DOCS_DIR, name));
    return { name, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
  }));
  const index = await readIndex();
  return { docsDir: DOCS_DIR, files: stats, index: summarizeIndex(index) };
}

async function readIndex() {
  try {
    return JSON.parse(await fs.readFile(INDEX_PATH, "utf8"));
  } catch {
    return { chunks: [] };
  }
}

function summarizeIndex(index) {
  return {
    docsDir: DOCS_DIR,
    indexPath: INDEX_PATH,
    refreshedAt: index.refreshedAt || null,
    chunks: index.chunks?.length || 0,
    files: [...new Set((index.chunks || []).map((chunk) => chunk.fileName))].length,
    embeddingModel: index.embeddingModel || "text-embedding-3-small",
    disclosure: "Local document text is embedded via OpenAI and cached by content hash in a local JSON index.",
  };
}

function chunkText(text) {
  const normalized = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const chunks = [];
  for (let start = 0; start < normalized.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
    chunks.push(normalized.slice(start, start + CHUNK_SIZE).trim());
    if (start + CHUNK_SIZE >= normalized.length) break;
  }
  return chunks.filter(Boolean);
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  return dot / (Math.sqrt(an) * Math.sqrt(bn) || 1);
}
