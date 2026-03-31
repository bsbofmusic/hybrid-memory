#!/usr/bin/env node
/**
 * hybrid-memory MCP Server v0.2.3
 *
 * Hybrid Memory: semantic + structured recall over memos PostgreSQL.
 *
 * Architecture:
 *   Layer 1 (File Brain)  : OpenClaw memorySearch — semantic main-chain (BAAI/bge-m3 + siliconflow + sqlite-vec)
 *   Hybrid Memory (Facts) : memos PostgreSQL — original words, details, temporal context
 *
 * This MCP provides memory tools:
 *   - semantic_search  : reuse OpenClaw memorySearch embedding config → cosine similarity against memos content
 *   - query_memos      : structured SELECT over memos PostgreSQL
 *   - ingest_session   : trigger session → memos ingest (calls ingest script)
 *   - get_memos_stats  : record counts, last ingest time
 *   - memory_layer2_info: architecture doc + Layer1/Layer2 division explanation
 *   - ensure / doctor / version / list_commands (bootstrap interface)
 *
 * Env:
 *   MEMOS_PG_HOST      default 127.0.0.1
 *   MEMOS_PG_PORT      default 5432
 *   MEMOS_PG_DB        default memos
 *   MEMOS_PG_USER      default memos
 *   MEMOS_PG_PASSWORD  default memos_local_20260312
 *   Embedding config defaults to OpenClaw agents.defaults.memorySearch
 *   Override only if needed:
 *   LAYER2_EMBED_API_KEY   explicit API key override
 *   LAYER2_EMBED_BASE_URL  explicit endpoint override
 *   LAYER2_EMBED_MODEL     explicit model override
 *   LOG_LEVEL          default info (error|info|debug)
 */

'use strict';

const { Pool } = require('pg');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const hindsight = require('./hindsight');

// ─── Config ──────────────────────────────────────────────────────────────────
const PG = {
  host:     process.env.MEMOS_PG_HOST     || '127.0.0.1',
  port:     parseInt(process.env.MEMOS_PG_PORT || '5432', 10),
  database: process.env.MEMOS_PG_DB        || 'memos',
  user:     process.env.MEMOS_PG_USER      || 'memos',
  password: process.env.MEMOS_PG_PASSWORD  || 'memos_local_20260312',
};
const LOG_LEVEL             = process.env.LOG_LEVEL            || 'info';
const WORKSPACE             = process.env.WORKSPACE             || '/var/lib/openclaw/.openclaw/workspace';
const OPENCLAW_CONFIG       = process.env.OPENCLAW_CONFIG       || '/var/lib/openclaw/.openclaw/openclaw.json';
const EMBED_CACHE_DIR       = path.join(WORKSPACE, '.layer2-runtime', 'embed-cache');
fs.mkdirSync(EMBED_CACHE_DIR, { recursive: true });

function loadOpenClawMemorySearch() {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG, 'utf8');
    const cfg = JSON.parse(raw);
    return cfg?.agents?.defaults?.memorySearch || {};
  } catch {
    return {};
  }
}

const MEMORY_SEARCH_CFG     = loadOpenClawMemorySearch();
const EMBED_MODEL           = process.env.LAYER2_EMBED_MODEL
  || MEMORY_SEARCH_CFG?.model
  || 'BAAI/bge-m3';
const EMBED_BASE_URL        = process.env.LAYER2_EMBED_BASE_URL
  || MEMORY_SEARCH_CFG?.remote?.baseUrl
  || 'https://api.siliconflow.cn/v1';
const EMBED_API_KEY         = process.env.LAYER2_EMBED_API_KEY
  || MEMORY_SEARCH_CFG?.remote?.apiKey
  || process.env.SILICONFLOW_API_KEY
  || '';

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(level, ...args) {
  if (LOG_LEVEL === 'debug' || (LOG_LEVEL === 'info' && level !== 'debug')) {
    console.error(`[${new Date().toISOString()}] [${level}]`, ...args);
  }
}

function extractDisplayText(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const parts = s.split(/\n\s*\n/);
  let body = parts.length > 1 ? parts.slice(1).join(' ').trim() : s;
  body = body.replace(/\[(uid|source|chat_id|session|timestamp|sender|message_id|mode|part):[^\]]*\]/g, ' ');
  body = body.replace(/\s+/g, ' ').trim();
  return body;
}

function normalizeTerms(s) {
  const raw = String(s || '').toLowerCase().trim();
  if (!raw) return [];

  const stopwords = new Set([
    '我','你','他','她','它','我们','你们','他们','她们','它们',
    '什么','怎么','为什么','有没有','是不是','哪些','哪个','多少','几点','时候','是谁',
    '最近','最新','上次','一次','一下','一下子','这个','那个','这些','那些',
    '关于','有关','相关','情况','问题','事情','内容','信息','记录','记忆',
    '一下','下','吗','呢','啊','呀','吧','了','的','得','地','和','与','及','并',
    'what','why','how','when','where','who','is','are','the','a','an','of','to','for'
  ]);

  const out = [];
  const parts = raw
    .split(/[^\p{L}\p{N}-]+/u)
    .map(x => x.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (!part || /^\d+$/.test(part) || stopwords.has(part)) continue;
    if (part.length >= 2) out.push(part);

    const hanRuns = part.match(/[\p{Script=Han}]{2,}/gu) || [];
    for (const run of hanRuns) {
      if (run.length >= 2 && !stopwords.has(run)) out.push(run);
      if (run.length >= 4) {
        for (let i = 0; i <= run.length - 2; i++) {
          const bg = run.slice(i, i + 2);
          if (!stopwords.has(bg) && !/什么|怎么|为什么|是谁|最近|最新|一次/.test(bg)) out.push(bg);
        }
      }
    }
  }

  return Array.from(new Set(out)).slice(0, 20);
}

function inferQueryPlan(query) {
  const q = String(query || '').trim();
  const lower = q.toLowerCase();
  const terms = normalizeTerms(q);
  const entityTerms = terms.filter(t => t.length >= 2 && t.length <= 12 && !/什么|怎么|为什么|有没有|最近|最新|一次|情况|问题|事情|是谁/.test(t));
  const wantsRecent = /最近|最新|上次|最近一次|last|latest|recent/i.test(q);
  const wantsCause = /为什么|原因|根因|归因|坑|问题|故障|分析|rca/i.test(q);
  const wantsQuote = /原话|怎么说|具体怎么说|哪句|原文/i.test(q);
  const wantsRelation = /关系|区别|分工|职责|是什么/i.test(q);
  const wantsRule = /规则|要求|口径|机制|模式|架构/i.test(q);
  const abstractLevel = /什么|怎么|为什么|关系|区别|要求|最近/i.test(q) ? 'abstract' : 'concrete';
  return {
    raw: q,
    lower,
    terms,
    entityTerms,
    wantsRecent,
    wantsCause,
    wantsQuote,
    wantsRelation,
    wantsRule,
    abstractLevel,
  };
}

function termHitCount(text, terms) {
  const s = String(text || '').toLowerCase();
  if (!s || !terms?.length) return 0;
  return terms.filter(term => s.includes(term)).length;
}

function isNoiseText(text) {
  const s = String(text || '');
  return /\{"jsonrpc":"2\.0"|layer2_answer:start|STDOUT\+STDERR|Internal task completion event|source: subagent|Stats: runtime|Action:|pg 版 memos API 写入测试|发送了一条消息|没有完成|^这是一条 /i.test(s);
}

function buildSemanticGate(plan, item) {
  const content = extractDisplayText(item?.content || '').toLowerCase();
  if (!content || isNoiseText(content)) return { pass: false, reason: 'empty_or_noise', hits: 0, score: item?.score || 0 };
  const terms = plan.entityTerms.length ? plan.entityTerms : plan.terms;
  const hits = termHitCount(content, terms);
  const score = Number(item?.score || 0);
  const hardHit = score >= 0.92;
  const keywordHit = terms.length > 0 && hits >= Math.min(2, terms.length);
  const mixedHit = score >= 0.72 && hits >= 1;
  return {
    pass: hardHit || keywordHit || mixedHit,
    reason: hardHit ? 'hard_score' : keywordHit ? 'keyword_hit' : mixedHit ? 'mixed_hit' : 'rejected',
    hits,
    score,
  };
}

function judgeEvidence(plan, alignedMemos, recallMemories, fileBrainHits = []) {
  const seen = new Set();
  const evidence = [];
  const recall = [];
  const fileEvidence = [];
  const terms = plan.entityTerms.length ? plan.entityTerms : plan.terms;

  const filteredRecall = (Array.isArray(recallMemories) ? recallMemories : []).filter(item => {
    const text = extractDisplayText(item?.text || '').toLowerCase();
    if (!text || isNoiseText(text)) return false;
    const hits = termHitCount(text, terms);
    if (!terms.length) return true;
    return hits >= Math.min(2, Math.max(1, terms.length)) || (plan.abstractLevel === 'abstract' && hits >= 1);
  });

  for (const item of filteredRecall.slice(0, 3)) {
    const text = extractDisplayText(item?.text || '').slice(0, 250);
    if (text && !seen.has(text)) {
      recall.push({ type: 'recall', text, rank: 'B' });
      seen.add(text);
    }
  }

  for (const item of fileBrainHits) {
    const text = extractDisplayText(item?.text || '').slice(0, 250);
    const label = `${text} (Source: ${item.path}#L${item.line})`;
    if (text && !seen.has(label)) {
      fileEvidence.push({ type: 'file', text: label, rank: item.score >= 0.82 ? 'A' : 'B', score: item.score, hits: item.hits });
      seen.add(label);
    }
    if (fileEvidence.length >= 3) break;
  }

  for (const item of alignedMemos) {
    const content = extractDisplayText(item?.content || '').slice(0, 250);
    if (!content || seen.has(content)) continue;
    const gate = buildSemanticGate(plan, item);
    if (!gate.pass) continue;
    const rank = gate.score >= 0.85 || gate.hits >= Math.max(2, terms.length) ? 'A' : 'B';
    evidence.push({ type: 'evidence', text: content, rank, score: gate.score, hits: gate.hits, updated_ts: item?.updated_ts || 0 });
    seen.add(content);
    if (evidence.length >= 5) break;
  }

  evidence.sort((a, b) => {
    const rankScore = { A: 2, B: 1 };
    return (rankScore[b.rank] - rankScore[a.rank]) || ((b.score || 0) - (a.score || 0)) || ((b.updated_ts || 0) - (a.updated_ts || 0));
  });

  return { recall, fileEvidence, evidence, facts: [...fileEvidence, ...recall, ...evidence].slice(0, 5) };
}

function synthesizeJudgment(plan, judged, reflectText, hindsightUsed) {
  const factCount = judged.facts.length;
  const highRankCount = judged.evidence.filter(x => x.rank === 'A').length;
  const hasRecall = judged.recall.length > 0;
  const hasHardEvidence = judged.evidence.length > 0;
  const hasFileEvidence = judged.fileEvidence?.length > 0;

  let judgment = '未查到足够证据';
  if (hasHardEvidence && highRankCount > 0) {
    judgment = '已找到高置信证据，优先按证据回答。';
  } else if (hasHardEvidence || hasRecall || hasFileEvidence) {
    judgment = '已找到候选证据，但仍以实体对齐后的本地证据为准。';
  }

  if (reflectText && (hasHardEvidence || hasFileEvidence)) {
    judgment = `${judgment} Hindsight 仅作为辅助归纳，不覆盖事实层。`;
  } else if (reflectText && !hasHardEvidence && hasRecall) {
    judgment = '已找到回忆候选，但缺少足够硬证据，归纳仅供参考。';
  }

  const uncertainty = [];
  if (!hasHardEvidence && hasRecall) uncertainty.push('有回忆候选，但缺少足够硬证据完成裁决');
  if (!factCount) uncertainty.push('当前 query 与已沉淀记忆之间可能存在表征鸿沟');
  uncertainty.push(hindsightUsed ? 'Hindsight 已作为增强层参与' : 'Hindsight 未参与，本次仅基于本地证据');

  return { judgment, uncertainty };
}

function scoreFileEvidence(plan, text) {
  const clean = extractDisplayText(text || '');
  if (!clean || isNoiseText(clean)) return { pass: false, score: 0, hits: 0 };
  const lower = clean.toLowerCase();
  const terms = plan.entityTerms.length ? plan.entityTerms : plan.terms;
  const hits = termHitCount(lower, terms);
  const wantsRecentBoost = plan.wantsRecent && /2026-|最近|当前|现行|已确认|起|新增|收口/.test(clean) ? 0.12 : 0;
  const wantsCauseBoost = plan.wantsCause && /根因|归因|修复|教训|问题/.test(clean) ? 0.12 : 0;
  const wantsRuleBoost = plan.wantsRule && /规则|口径|机制|架构|固定/.test(clean) ? 0.12 : 0;
  const base = hits >= 2 ? 0.78 : hits >= 1 ? 0.58 : 0;
  const score = Math.min(1, base + wantsRecentBoost + wantsCauseBoost + wantsRuleBoost);
  const pass = score >= 0.7 || (plan.abstractLevel === 'abstract' && score >= 0.58);
  return { pass, score, hits };
}

function readFileBrainCandidates() {
  const candidates = [];
  const fixed = [
    path.join(WORKSPACE, 'MEMORY.md'),
    path.join(WORKSPACE, 'memory', '2026-03-29.md'),
    path.join(WORKSPACE, 'memory', '2026-03-30.md'),
  ];
  for (const fp of fixed) {
    try {
      if (fs.existsSync(fp)) {
        candidates.push({ path: fp, content: fs.readFileSync(fp, 'utf8') });
      }
    } catch {}
  }
  return candidates;
}

function retrieveFileBrain(plan) {
  const out = [];
  for (const file of readFileBrainCandidates()) {
    const lines = String(file.content || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.length < 8) continue;
      const s = scoreFileEvidence(plan, line);
      if (!s.pass) continue;
      out.push({
        type: 'file',
        path: path.relative(WORKSPACE, file.path),
        line: i + 1,
        text: line,
        score: s.score,
        hits: s.hits,
      });
    }
  }
  out.sort((a, b) => (b.score - a.score) || (b.hits - a.hits));
  return out.slice(0, 5);
}

// ─── PostgreSQL Pool ──────────────────────────────────────────────────────────
let pool = null;
function getPool() {
  if (!pool || pool.ended) {
    pool = new Pool(PG);
    pool.on('error', err => log('error', 'PG pool error', err.message));
  }
  return pool;
}

// ─── embedding via OpenClaw memorySearch config ──────────────────────────────
async function getEmbedding(text, model = EMBED_MODEL) {
  const input = text.slice(0, 8000);
  const key = crypto.createHash('sha1').update(model + '\n' + input).digest('hex');
  const cacheFile = path.join(EMBED_CACHE_DIR, `${key}.json`);
  try {
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8')).embedding;
    }
  } catch {}

  if (!EMBED_API_KEY) {
    throw new Error('Embedding API key not configured via OpenClaw memorySearch or LAYER2_EMBED_API_KEY');
  }
  const url = `${EMBED_BASE_URL.replace(/\/$/, '')}/embeddings`;
  const body = JSON.stringify({ input, model });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${EMBED_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`embedding ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const embedding = json.data[0].embedding;
  try { fs.writeFileSync(cacheFile, JSON.stringify({ embedding })); } catch {}
  return embedding;
}

// cosine similarity between two vectors
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// ─── SQL helpers ─────────────────────────────────────────────────────────────
async function pgQuery(sql, params = [], timeoutMs = 8000) {
  const client = await getPool().connect();
  try {
    const result = await Promise.race([
      client.query(sql, params),
      new Promise((_, rej) => setTimeout(() => rej(new Error('query timeout')), timeoutMs)),
    ]);
    return { ok: true, rows: result.rows, rowCount: result.rowCount };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300) };
  } finally {
    client.release();
  }
}

// ─── Semantic search over memos ──────────────────────────────────────────────
async function semanticSearch(query, { topK = 10, minScore = 0.2 } = {}) {
  // 混合检索模式：关键词召回 + 向量召回，双路融合提升准确率
  const q = String(query || '').trim();
  if (!q) return { ok: true, results: [] };

  // 1. 关键词召回分支
  const chars = Array.from(new Set(q.toLowerCase().split('').filter(c => c.trim().length > 0 && /[\u4e00-\u9fa5a-z0-9]/i.test(c)))).slice(0, 16);
  const terms = Array.from(new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))).slice(0, 8);
  const allTerms = Array.from(new Set([...chars, ...terms]));
  
  const likeParams = [];
  const clauses = [];
  for (const t of terms) {
    likeParams.push(`%${t}%`);
    clauses.push(`LOWER(content) LIKE $${likeParams.length}`);
  }
  for (const c of chars) {
    likeParams.push(`%${c}%`);
    clauses.push(`LOWER(content) LIKE $${likeParams.length}`);
  }
  const whereLike = clauses.length ? `AND (${clauses.join(' OR ')})` : '';
  const keywordRes = await pgQuery(
    `SELECT id, creator_id, content, payload, created_ts, updated_ts
     FROM memo
     WHERE visibility = 'PRIVATE' AND LENGTH(content) > 20
       ${whereLike}
     ORDER BY updated_ts DESC
     LIMIT 30`,
    likeParams
  );

  // 2. 向量召回分支（如果有embedding字段存在）
  const embedRes = { rows: [] };
  try {
    const queryEmbedding = await getEmbedding(q);
    const vecRes = await pgQuery(
      `SELECT id, creator_id, content, payload, created_ts, updated_ts, 1 - (embedding <=> $1::vector) as score
       FROM memo
       WHERE visibility = 'PRIVATE' AND LENGTH(content) > 20
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 30`,
      [JSON.stringify(queryEmbedding)]
    );
    if (vecRes.ok) embedRes.rows = vecRes.rows;
  } catch {}

  // 3. 结果去重合并
  const merged = new Map();
  // 关键词结果加权
  keywordRes.rows?.forEach(row => {
    if (!merged.has(row.id)) {
      let score = 0;
      const content = String(row.content || '').toLowerCase();
      let hits = 0;
      for (const t of terms) if (content.includes(t)) hits += 2;
      for (const c of chars) if (content.includes(c)) hits += 0.5;
      const totalPossible = terms.length * 2 + chars.length * 0.5;
      const ratio = totalPossible > 0 ? hits / totalPossible : 0;
      const recencyBoost = row.updated_ts ? 0.1 : 0;
      score = parseFloat((ratio + recencyBoost).toFixed(4));
      merged.set(row.id, { ...row, score, source: 'keyword' });
    }
  });
  // 向量结果加权
  embedRes.rows?.forEach(row => {
    if (!merged.has(row.id)) {
      merged.set(row.id, { ...row, score: parseFloat((row.score || 0).toFixed(4)), source: 'vector' });
    } else {
      // 双命中加权
      const existing = merged.get(row.id);
      existing.score = parseFloat((Math.max(existing.score, row.score) * 1.2).toFixed(4));
      existing.source = 'hybrid';
      merged.set(row.id, existing);
    }
  });

  // 4. 排序取topK
  const noisyContent = (content) => {
    const s = String(content || '');
    return /\{\"jsonrpc\":\"2\.0\"|layer2_answer:start|STDOUT\+STDERR|Internal task completion event|source: subagent|Stats: runtime|Action:/i.test(s);
  };

  const scored = Array.from(merged.values())
    .filter(row => row.score >= Math.min(minScore, 0.1))
    .filter(row => !noisyContent(row.content))
    .sort((a, b) => b.score - a.score || (b.updated_ts || 0) - (a.updated_ts || 0));

  return { ok: true, results: scored.slice(0, topK) };
}

// ─── Bootstrap / ensure ───────────────────────────────────────────────────────
const RUNTIME_DIR = path.join(WORKSPACE, '.layer2-runtime');

async function bootstrapEnsure() {
  const steps = [];
  let allOk = true;

  // 1. PostgreSQL connectivity
  try {
    const r = await pgQuery('SELECT 1 as ok');
    if (!r.ok) throw new Error(r.error);
    steps.push({ step: 'postgresql_connect', ok: true, detail: 'memos-postgres reachable' });
  } catch (e) {
    steps.push({ step: 'postgresql_connect', ok: false, detail: e.message });
    allOk = false;
  }

  // 2. memos schema check
  try {
    const r = await pgQuery(`SELECT count(*) as n FROM memo`);
    steps.push({ step: 'memos_schema', ok: true, detail: `memo table accessible, rows: ${r.rows[0].n}` });
  } catch (e) {
    steps.push({ step: 'memos_schema', ok: false, detail: e.message });
    allOk = false;
  }

  // 3. shared embedding config from OpenClaw memorySearch
  if (EMBED_API_KEY) {
    try {
      await getEmbedding('healthcheck probe');
      steps.push({ step: 'embedding_api', ok: true, detail: `embedding endpoint reachable (${EMBED_MODEL} via ${EMBED_BASE_URL})` });
    } catch (e) {
      steps.push({ step: 'embedding_api', ok: false, detail: e.message });
      allOk = false;
    }
  } else {
    steps.push({ step: 'embedding_api', ok: false, detail: 'Embedding config not found in OpenClaw memorySearch and no LAYER2_EMBED_API_KEY override' });
    allOk = false;
  }

  // 4. Ingest script exists
  const ingestScript = path.join(WORKSPACE, 'scripts', 'ingest_session_raw_to_memos.py');
  if (fs.existsSync(ingestScript)) {
    steps.push({ step: 'ingest_script', ok: true, detail: ingestScript });
  } else {
    steps.push({ step: 'ingest_script', ok: false, detail: `not found: ${ingestScript}` });
  }

  // 5. Runtime dir writable
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(path.join(RUNTIME_DIR, '.probe'), 'ok');
    steps.push({ step: 'runtime_dir', ok: true, detail: RUNTIME_DIR });
  } catch (e) {
    steps.push({ step: 'runtime_dir', ok: false, detail: e.message });
  }

  return { ok: allOk, steps };
}

// ─── Doctor ───────────────────────────────────────────────────────────────────
async function doctor() {
  const r = await bootstrapEnsure();
  const nextSteps = [];
  for (const s of r.steps) {
    if (!s.ok) {
      const fix = {
        postgresql_connect: 'Ensure memos-postgres container is running: docker ps | grep memos-postgres',
        memos_schema: 'Ensure memos service has created tables — check memos logs',
        embedding_api: 'Check OpenClaw agents.defaults.memorySearch remote.baseUrl/apiKey/model or set LAYER2_EMBED_* overrides',
        ingest_script: 'Ensure scripts/ingest_session_raw_to_memos.py exists in workspace',
        runtime_dir: 'Check disk space and permissions on workspace',
      }[s.step] || 'Manual check required';
      nextSteps.push({ step: s.step, fix });
    }
  }
  return { checks: r.steps, nextSteps };
}

// ─── MCP JSON-RPC transport ───────────────────────────────────────────────────
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

// ─── Tool handlers ────────────────────────────────────────────────────────────
const TOOLS = {
  list: async () => ({
    tools: [
      {
        name: 'semantic_search',
        description: 'Layer2 semantic search over memos. Reuses OpenClaw memorySearch embedding config, scores memos content by cosine similarity, returns top-K results.',
        inputSchema: {
          type: 'object',
          properties: {
            query:       { type: 'string', description: 'Natural language memory query' },
            topK:        { type: 'integer', default: 10, description: 'Max results to return' },
            minScore:    { type: 'number',  default: 0.5, description: 'Minimum cosine similarity threshold' },
          },
          required: ['query'],
        },
      },
      {
        name: 'query_memos',
        description: 'Structured SELECT over memos PostgreSQL. Returns raw memo rows with full context.',
        inputSchema: {
          type: 'object',
          properties: {
            sql:    { type: 'string', description: 'SELECT SQL (INSERT/UPDATE/DELETE rejected)' },
            params: { type: 'object', description: 'Named params for $1, $2 …' },
            limit:  { type: 'integer', default: 50 },
          },
          required: ['sql'],
        },
      },
      {
        name: 'get_memos_stats',
        description: 'Layer2 storage statistics: total memos, by visibility, by creator, recent activity.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'trigger_ingest',
        description: 'Trigger session → memos ingest by spawning ingest_session_raw_to_memos.py. Returns script output.',
        inputSchema: {
          type: 'object',
          properties: {
            dry_run: { type: 'boolean', default: false, description: 'Simulate without writing' },
          },
        },
      },
      {
        name: 'memory_layer2_info',
        description: 'Returns Layer1/Layer2 architecture documentation and division of responsibilities.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'layer2_ensure',
        description: 'Bootstrap ensure: verifies PostgreSQL, shared embedding config/API, ingest script, runtime dir.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'layer2_doctor',
        description: 'Full diagnostic + fix suggestions for Layer2 components.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'hindsight_health',
        description: 'Check whether Hindsight service is reachable and ready for Layer2 integration.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'layer2_answer',
        description: 'Unified Layer2 answer: semantic search over memos, then if available ask Hindsight to reflect, finally return evidence-backed answer.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language question for Layer2' },
            topK: { type: 'integer', default: 5 }
          },
          required: ['query']
        },
      },
      {
        name: 'layer2_version',
        description: 'Version info: MCP server version, package version, git commit, last update.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'layer2_list_commands',
        description: 'Capability self-discovery: lists all available tools.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }),

  call: async (name, args) => {
    switch (name) {

      case 'semantic_search': {
        const { query, topK = 10, minScore = 0.5 } = args || {};
        if (!query) return '❌ query is required';
        try {
          const r = await semanticSearch(query, { topK, minScore });
          if (!r.ok) return `❌ ${r.error}`;
          if (!r.results.length) return '🔍 No results above threshold';
          const lines = r.results.map(m =>
            `[score=${m.score}] (${new Date(m.updated_ts * 1000).toLocaleDateString('zh-CN')}) ${m.content.slice(0, 300)}`
          );
          return `✅ ${r.results.length} results:\n\n${lines.join('\n\n')}`;
        } catch (e) {
          return `❌ semantic_search failed: ${e.message}`;
        }
      }

      case 'query_memos': {
        const { sql = '', params = {}, limit = 50 } = args || {};
        if (!sql.trim()) return '❌ sql is required';
        const trimmed = sql.trim().toLowerCase();
        if (trimmed.startsWith('insert') || trimmed.startsWith('update') || trimmed.startsWith('delete') || trimmed.startsWith('drop') || trimmed.startsWith('truncate')) {
          return '❌ Only SELECT allowed';
        }
        const q = trimmed.includes('limit') ? sql : `${sql} LIMIT ${limit}`;
        const res = await pgQuery(q, Object.values(params));
        if (!res.ok) return `❌ ${res.error}`;
        return `✅ ${res.rowCount} rows:\n\n${JSON.stringify(res.rows, null, 2)}`;
      }

      case 'get_memos_stats': {
        const totalR = await pgQuery('SELECT count(*) as n FROM memo');
        const privR  = await pgQuery("SELECT count(*) as n FROM memo WHERE visibility = 'PRIVATE'");
        const pubR   = await pgQuery("SELECT count(*) as n FROM memo WHERE visibility = 'PUBLIC'");
        const recentR = await pgQuery(
          'SELECT count(*) as n FROM memo WHERE updated_ts > floor(extract(epoch from now()) - 86400)::int'
        );
        const ingestR = await pgQuery(
          "SELECT value FROM system_settings WHERE key = 'last_ingest_ts' LIMIT 1"
        );
        const out = {
          total_memos:    parseInt(totalR.rows?.[0]?.n || 0),
          private:         parseInt(privR.rows?.[0]?.n || 0),
          public:          parseInt(pubR.rows?.[0]?.n || 0),
          last_24h:        parseInt(recentR.rows?.[0]?.n || 0),
          last_ingest_ts: ingestR.rows?.[0]?.value || 'unknown',
        };
        return `✅ Stats:\n${JSON.stringify(out, null, 2)}`;
      }

      case 'trigger_ingest': {
        const dry = args?.dry_run ? ['--dry-run'] : [];
        const script = path.join(WORKSPACE, 'scripts', 'ingest_session_raw_to_memos.py');
        if (!fs.existsSync(script)) return `❌ ingest script not found: ${script}`;
        return new Promise(resolve => {
          const child = spawn('python3', [script, ...dry], { cwd: WORKSPACE });
          let out = '', err = '';
          child.stdout.on('data', d => { out += d; });
          child.stderr.on('data', d => { err += d; });
          child.on('close', code => {
            resolve(`ingest exited ${code}\nstdout: ${out.slice(0, 1000)}\nstderr: ${err.slice(0, 500)}`);
          });
          child.on('error', e => resolve(`❌ spawn error: ${e.message}`));
        });
      }

      case 'memory_layer2_info': {
        return `✅ Layer2 Memory System — Architecture

## 双层记忆架构

### Layer 1 — File Brain (OpenClaw Memory)
- 索引: MEMORY.md + memory/YYYY-MM-DD.md
- 引擎: OpenClaw memorySearch
- Embedding: shared OpenClaw memorySearch config (BAAI/bge-m3 + configured endpoint)
- 检索: Hybrid (Vector + BM25), MMR, temporal decay
- 负责: 规则、拍板结论、阶段总结、系统配置

### Layer 2 — Raw Facts (memos PostgreSQL + this MCP)
- 数据: memos PostgreSQL (ghcr.io/usememos/memos:stable)
- Embedding: reuses OpenClaw memorySearch provider/model/endpoint (semantic search via this MCP)
- 负责: 原话、细节、时间点、承诺、上下文
- 路由: 总结/规则 → Layer1;  原话/细节 → Layer2

## Layer2 MCP 工具
- semantic_search   : 语义搜索 (复用 OpenClaw embedding 配置)
- query_memos       : 结构化 SQL 查询
- get_memos_stats   : 存储统计
- trigger_ingest    : 触发 session → memos ingest
- memory_layer2_info: 本文档
- layer2_ensure     : bootstrap 自愈
- layer2_doctor     : 诊断 + 修复建议
- layer2_version    : 版本信息
- layer2_list_commands: 工具列表

## 灾备
- pg_dump 每日 02:30 执行 (灾备手段，不是数据源)
- GitHub = 最终灾备与迁移恢复层`;
      }

      case 'layer2_ensure': {
        const r = await bootstrapEnsure();
        return `layer2_ensure:\n${JSON.stringify(r, null, 2)}`;
      }

      case 'layer2_doctor': {
        const r = await doctor();
        return `layer2_doctor:\n${JSON.stringify(r, null, 2)}`;
      }

      case 'hindsight_health': {
        const r = await hindsight.healthcheck();
        return `hindsight_health:\n${JSON.stringify({ config: hindsight.loadHindsightConfig(), result: r }, null, 2)}`;
      }

      case 'layer2_answer': {
        log('info', 'layer2_answer:start', JSON.stringify(args || {}));
        const { query } = args || {};
        if (!query) return '❌ query is required';

        const plan = inferQueryPlan(query);
        log('info', 'layer2_answer:plan', JSON.stringify({
          terms: plan.terms,
          entityTerms: plan.entityTerms,
          wantsRecent: plan.wantsRecent,
          wantsCause: plan.wantsCause,
          wantsQuote: plan.wantsQuote,
          wantsRelation: plan.wantsRelation,
          wantsRule: plan.wantsRule,
          abstractLevel: plan.abstractLevel,
        }));

        // 轻脚本供料：memos 主位，file brain fallback，Hindsight recall 增强
        log('info', 'layer2_answer:semantic_search');
        const sem = await semanticSearch(query, { topK: 8, minScore: 0.28 });
        const rawMemos = sem.ok ? sem.results : [];
        const topScore = rawMemos[0]?.score || 0;
        const alignedMemos = rawMemos.filter(item => !isNoiseText(item?.content || '')).slice(0, 5);
        const fileBrainHits = (plan.wantsRule || plan.wantsRelation || plan.wantsRecent || topScore < 0.72)
          ? retrieveFileBrain(plan)
          : [];

        let recallMemories = [];
        let hindsightUsed = false;
        const shouldUseHindsight = rawMemos.length > 0 || plan.abstractLevel === 'abstract';
        log('info', 'layer2_answer:hindsight_gate', JSON.stringify({ shouldUseHindsight, topScore, raw: rawMemos.length, fileBrainHits: fileBrainHits.length }));
        if (shouldUseHindsight) {
          try {
            const h = await Promise.race([
              hindsight.healthcheck(),
              new Promise(resolve => setTimeout(() => resolve({ ok: false, detail: 'health timeout' }), 1200))
            ]);
            if (h?.ok) {
              const recall = await Promise.race([
                hindsight.recall(query, { topK: 4 }),
                new Promise(resolve => setTimeout(() => resolve({ ok: false, detail: 'recall timeout' }), 2200))
              ]);
              recallMemories = Array.isArray(recall?.data?.results) ? recall.data.results : [];
              hindsightUsed = recallMemories.length > 0;
            }
          } catch (_) {}
        }

        // 轻裁决：脚本不过度理解，只做去噪、来源分层、基础排序
        const memoFacts = alignedMemos.map(item => ({
          type: 'evidence',
          text: extractDisplayText(item.content || '').slice(0, 250),
          score: Number(item.score || 0),
          updated_ts: item.updated_ts || 0,
        })).filter(x => x.text);

        const recallFacts = recallMemories.map(item => ({
          type: 'recall',
          text: extractDisplayText(item?.text || '').slice(0, 250),
        })).filter(x => x.text && !isNoiseText(x.text)).slice(0, 3);

        const fileFacts = fileBrainHits.map(item => ({
          type: 'file',
          text: `${extractDisplayText(item.text || '').slice(0, 220)} (Source: ${item.path}#L${item.line})`,
          score: Number(item.score || 0),
        })).filter(x => x.text).slice(0, 2);

        const rankedFacts = [];
        const seen = new Set();
        for (const item of [...memoFacts, ...recallFacts, ...fileFacts]) {
          if (!item.text || seen.has(item.text)) continue;
          seen.add(item.text);
          rankedFacts.push(item);
          if (rankedFacts.length >= 5) break;
        }

        let reflectText = null;
        if (hindsightUsed && rankedFacts.length > 0 && rankedFacts.length <= 3) {
          log('info', 'layer2_answer:hindsight_reflect');
          const reflect = await Promise.race([
            hindsight.reflect(query),
            new Promise(resolve => setTimeout(() => resolve(null), 2200))
          ]).catch(() => null);
          if (reflect?.ok) {
            reflectText = typeof reflect.data === 'string'
              ? reflect.data.slice(0, 600)
              : String(reflect.data?.text || JSON.stringify(reflect.data)).slice(0, 600);
          }
        }

        const factLines = rankedFacts.map(f => `- [${f.type}] ${f.text}`);
        const uncertainty = [];
        if (!memoFacts.length && recallFacts.length) uncertainty.push('本次主要依赖 Hindsight recall，缺少足够 memos 硬证据');
        if (!memoFacts.length && !fileFacts.length && !recallFacts.length) uncertainty.push('当前 query 与现有记忆之间可能存在表征鸿沟');
        uncertainty.push(hindsightUsed ? 'Hindsight 已作为 recall 增强层参与' : 'Hindsight 未参与或未返回有效 recall');
        if (fileFacts.length > 0 && memoFacts.length === 0) uncertainty.push('本次有文件脑 fallback 参与，但 file brain 不是原话证据层');

        const judgment = memoFacts.length > 0
          ? '已取回 memos 主证据，最终理解与取舍应由 agent 主导。'
          : fileFacts.length > 0 || recallFacts.length > 0
            ? '已取回候选记忆，但仍建议由 agent 进一步做语义裁决。'
            : '未查到足够证据。';

        log('info', 'layer2_answer:return', `facts=${rankedFacts.length}`);
        return `已确认事实：\n${factLines.length ? factLines.join('\n') : '- 无'}\n\n归纳判断：\n- ${judgment}${reflectText ? `\n- Hindsight候选归纳：${reflectText}` : ''}\n\n不确定点：\n${uncertainty.map(x => `- ${x}`).join('\n')}\n\n[PRO-TIP] 当前 Layer2 已收口为“轻脚本供料 + agent 主导裁决”：memos 主位，file brain fallback，Hindsight 仅做 recall/reflect 增强。`;
      }

      case 'layer2_version': {
        return `hybrid-memory v0.2.3
MCP server: Hybrid Memory (memos PostgreSQL + shared OpenClaw embedding)
Workspace: ${WORKSPACE}
embedding: ${EMBED_API_KEY ? `configured (${EMBED_MODEL})` : 'NOT CONFIGURED'}
PostgreSQL: ${PG.host}:${PG.port}/${PG.database}`;
      }

      case 'layer2_list_commands': {
        const r = await TOOLS.list();
        const names = r.tools.map(t => `  ${t.name}: ${t.description.split('.')[0]}`).join('\n');
        return `Available Hybrid Memory tools:\n${names}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  },
};

// ─── Main dispatch ────────────────────────────────────────────────────────────
async function handleLine(line) {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }

  const { id, method, params } = req;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'hybrid-memory', version: '0.2.3' },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    const r = await TOOLS.list();
    respond(id, r);
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    try {
      const text = await TOOLS.call(toolName, toolArgs);
      respond(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      respondError(id, -32603, `Tool error: ${e.message}`);
    }
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

async function main() {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', async chunk => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      try {
        await handleLine(line);
      } catch (e) {
        process.stderr.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { message: e.message } }) + '\n');
      }
    }
  });

  process.stdin.on('end', async () => {
    const tail = buffer.trim();
    if (tail) {
      await handleLine(tail).catch(() => {});
    }
    if (pool) {
      try { await pool.end(); } catch {}
    }
    process.exit(0);
  });
}

main().catch(e => {
  process.stderr.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { message: e.message } }) + '\n');
  process.exit(1);
});
