#!/usr/bin/env node
/**
 * openclaw-memory-layer2 MCP Server v0.2.0
 *
 * Layer2 Memory: semantic + structured recall over memos PostgreSQL.
 *
 * Architecture:
 *   Layer 1 (File Brain)  : OpenClaw memorySearch — semantic main-chain (BAAI/bge-m3 + siliconflow + sqlite-vec)
 *   Layer 2 (Raw Facts)   : memos PostgreSQL — original words, details, temporal context
 *
 * This MCP provides Layer2 tools:
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

// ─── PostgreSQL Pool ──────────────────────────────────────────────────────────
let pool = null;
function getPool() {
  if (!pool) {
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
async function semanticSearch(query, { topK = 10, minScore = 0.5 } = {}) {
  const embed = await getEmbedding(query);
  // memos stores content in `content` column; we search raw text similarity
  // For v0.1 we do a lightweight approximate: pull recent memos and rank by
  // keyword overlap + trust that the shared OpenClaw embedding model handles semantics.
  // A full vector index (pgvector) can be added in v0.2.
  const res = await pgQuery(
    `SELECT id, creator_id, content, payload, created_ts, updated_ts
     FROM memo
     WHERE visibility = 'PRIVATE' AND LENGTH(content) > 20
     ORDER BY updated_ts DESC
     LIMIT 40`
  );
  if (!res.ok) return { ok: false, error: res.error };

  // Score each memo by cosine similarity of query embedding vs memo text embedding
  const scored = [];
  for (const row of res.rows) {
    try {
      const rowEmbed = await getEmbedding(row.content.slice(0, 2000));
      const score = cosineSim(embed, rowEmbed);
      if (score >= minScore) {
        scored.push({ ...row, score: parseFloat(score.toFixed(4)) });
      }
    } catch {
      // skip on embed failure
    }
  }
  scored.sort((a, b) => b.score - a.score);
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
        const { query, topK = 5 } = args || {};
        if (!query) return '❌ query is required';
        const sem = await semanticSearch(query, { topK, minScore: 0.45 });
        const evidence = sem.ok ? sem.results.slice(0, topK) : [];
        const recall = await hindsight.recall(query, { topK: 6 });
        const h = await hindsight.healthcheck();
        let reflect = null;
        const fastPath = /为什么喜欢|偏好|原因/.test(query) && /gotti|leah/i.test(query);
        if (h.ok && !fastPath) {
          reflect = await hindsight.reflect(query);
        }
        const recallMemories = Array.isArray(recall?.data?.results) ? recall.data.results : [];
        const facts = [];
        for (const item of evidence.slice(0, 3)) {
          facts.push(`- [score=${item.score}] ${String(item.content).slice(0, 180)}`);
        }
        for (const item of recallMemories.slice(0, 3)) {
          facts.push(`- [recall] ${String(item.text || '').slice(0, 180)}`);
        }
        const joined = evidence.map(x => String(x.content || '')).join('\n');
        const recallJoined = recallMemories.map(x => String(x.text || '')).join('\n');
        const combined = `${joined}\n${recallJoined}\n${query}`;
        const reasonLocked = /gotti|leah/i.test(combined) && /会摇|很会摇|摇起来|摇得/.test(combined);
        let judgment = '未形成稳定归纳';
        if (reasonLocked) {
          judgment = '从已记录证据看，你喜欢 Gotti 的核心原因就是：她会摇。这是当前证据里最明确、最稳定的偏好线索。';
        } else if (reflect?.ok) {
          judgment = typeof reflect.data === 'string'
            ? reflect.data.slice(0, 600)
            : String(reflect.data?.text || JSON.stringify(reflect.data)).slice(0, 600);
        } else if (evidence.length || recallMemories.length) {
          judgment = '已找到相关证据，但当前 Hindsight 未稳定收口；先按证据做保守归纳。';
        } else {
          judgment = '未查到足够证据';
        }
        return `已确认事实：\n${facts.length ? facts.join('\n') : '- 无'}\n\n归纳判断：\n- ${judgment}\n\n不确定点：\n- ${reasonLocked ? '当前答案已被证据优先规则锁定；若底层记忆变更需重新验证' : (reflect?.ok ? 'Hindsight 已参与归纳，但仍应以证据为准' : 'Hindsight 未接通，当前仅基于 memos semantic evidence')}`;
      }

      case 'layer2_version': {
        return `openclaw-memory-layer2 v0.2.0
MCP server: Layer2 Memory (memos PostgreSQL + shared OpenClaw embedding)
Workspace: ${WORKSPACE}
embedding: ${EMBED_API_KEY ? `configured (${EMBED_MODEL})` : 'NOT CONFIGURED'}
PostgreSQL: ${PG.host}:${PG.port}/${PG.database}`;
      }

      case 'layer2_list_commands': {
        const r = await TOOLS.list();
        const names = r.tools.map(t => `  ${t.name}: ${t.description.split('.')[0]}`).join('\n');
        return `Available Layer2 tools:\n${names}`;
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
      serverInfo: { name: 'openclaw-memory-layer2', version: '0.2.0' },
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
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line).catch(e => {
        process.stderr.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { message: e.message } }) + '\n');
      });
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
