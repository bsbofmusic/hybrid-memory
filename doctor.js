#!/usr/bin/env node
/**
 * Layer2 Doctor — standalone diagnostic for openclaw-memory-layer2
 * Run: node doctor.js
 */
'use strict';
const { Pool } = require('pg');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.WORKSPACE || '/var/lib/openclaw/.openclaw/workspace';
const OPENCLAW_CONFIG      = process.env.OPENCLAW_CONFIG || '/var/lib/openclaw/.openclaw/openclaw.json';
function loadOpenClawMemorySearch() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
    return cfg?.agents?.defaults?.memorySearch || {};
  } catch {
    return {};
  }
}
const MEMORY_SEARCH_CFG    = loadOpenClawMemorySearch();
const EMBED_MODEL          = process.env.LAYER2_EMBED_MODEL || MEMORY_SEARCH_CFG?.model || 'BAAI/bge-m3';
const EMBED_BASE_URL       = process.env.LAYER2_EMBED_BASE_URL || MEMORY_SEARCH_CFG?.remote?.baseUrl || 'https://api.siliconflow.cn/v1';
const EMBED_API_KEY        = process.env.LAYER2_EMBED_API_KEY || MEMORY_SEARCH_CFG?.remote?.apiKey || process.env.SILICONFLOW_API_KEY || '';
const PG = {
  host:     process.env.MEMOS_PG_HOST    || '127.0.0.1',
  port:     parseInt(process.env.MEMOS_PG_PORT || '5432', 10),
  database: process.env.MEMOS_PG_DB       || 'memos',
  user:     process.env.MEMOS_PG_USER    || 'memos',
  password: process.env.MEMOS_PG_PASSWORD || 'memos_local_20260312',
};

async function getEmbedding(text) {
  return new Promise((resolve, reject) => {
    const base = String(EMBED_BASE_URL || '').replace(/\/$/, '');
    const url = new URL(`${base}/embeddings`);
    const isHttps = url.protocol === 'https:';
    const body = JSON.stringify({ input: text.slice(0, 200), model: EMBED_MODEL });
    const opts = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${EMBED_API_KEY}`, 'Content-Type': 'application/json' },
    };
    const lib = isHttps ? https : http;
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve(j.data?.[0]?.embedding); }
        catch { reject(new Error(`embed parse error: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function main() {
  console.log('=== Layer2 Doctor v0.1.0 ===\n');
  const checks = [];

  // 1. PostgreSQL
  let pgOk = false;
  try {
    const pool = new Pool(PG);
    const r = await pool.query('SELECT 1');
    const count = await pool.query('SELECT count(*) as n FROM memo');
    await pool.end();
    pgOk = true;
    checks.push({ name: 'PostgreSQL', ok: true, detail: `connected, memo rows: ${count.rows[0].n}` });
  } catch (e) {
    checks.push({ name: 'PostgreSQL', ok: false, detail: e.message, fix: 'docker ps | grep memos-postgres' });
  }

  // 2. shared embedding config
  if (!EMBED_API_KEY) {
    checks.push({ name: 'embedding', ok: false, detail: 'OpenClaw memorySearch embedding config not found', fix: 'Set agents.defaults.memorySearch.remote.baseUrl/apiKey/model or LAYER2_EMBED_* overrides' });
  } else {
    try {
      await getEmbedding('doctor probe');
      checks.push({ name: 'embedding', ok: true, detail: `embedding endpoint OK (${EMBED_MODEL} via ${EMBED_BASE_URL})` });
    } catch (e) {
      checks.push({ name: 'embedding', ok: false, detail: e.message, fix: 'Check OpenClaw memorySearch config and embedding endpoint reachability' });
    }
  }

  // 3. ingest script
  const script = path.join(WORKSPACE, 'scripts', 'ingest_session_raw_to_memos.py');
  if (fs.existsSync(script)) {
    checks.push({ name: 'ingest_script', ok: true, detail: script });
  } else {
    checks.push({ name: 'ingest_script', ok: false, detail: 'not found', fix: `Create or restore: ${script}` });
  }

  // 4. runtime dir
  const rtDir = path.join(WORKSPACE, '.layer2-runtime');
  try {
    fs.mkdirSync(rtDir, { recursive: true });
    fs.writeFileSync(path.join(rtDir, '.probe'), 'ok');
    checks.push({ name: 'runtime_dir', ok: true, detail: rtDir });
  } catch (e) {
    checks.push({ name: 'runtime_dir', ok: false, detail: e.message });
  }

  // 5. node modules
  try {
    require.resolve('pg');
    checks.push({ name: 'pg_module', ok: true, detail: 'pg package available' });
  } catch {
    checks.push({ name: 'pg_module', ok: false, detail: 'pg not found', fix: 'npm install pg in package dir' });
  }

  // Summary
  console.log('Checks:');
  for (const c of checks) {
    const icon = c.ok ? '✅' : '❌';
    console.log(`  ${icon} ${c.name}: ${c.detail}`);
    if (c.fix) console.log(`     → Fix: ${c.fix}`);
  }
  const allOk = checks.every(c => c.ok);
  console.log(`\n${allOk ? '✅ All checks passed' : '⚠️  Some checks failed — see above'}`);
  process.exit(allOk ? 0 : 1);
}

main().catch(e => { console.error('Doctor error:', e.message); process.exit(1); });
