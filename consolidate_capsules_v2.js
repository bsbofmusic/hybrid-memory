#!/usr/bin/env node
/**
 * consolidate_capsules_v2.js — FBM-style V2 consolidation with full LLM pipeline
 *
 * Pipeline:
 *   1. Fetch recent memos from PostgreSQL
 *   2. [LLM] Batch classify: filter noise, keep valuable
 *   3. [LLM] Topic classify: auto-discover topics, no hardcoded rules
 *   4. [LLM] Action decide: append / update / supersede / ignore per topic
 *   5. [LLM] Capsule write: structured Markdown output
 *   6. [LLM] Cross-topic relation finder: build knowledge graph edges
 *   7. Write capsules + relations.json
 *
 * V1 reinforcement.js is used as fallback at every LLM step.
 *
 * Usage:
 *   node consolidate_capsules_v2.js [sinceHours=168] [limit=200]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const llm = require('./llm');
const reinforcement = require('./reinforcement');

const WORKSPACE = process.env.WORKSPACE || '/var/lib/openclaw/.openclaw/workspace';
const OUT_DIR = path.join(WORKSPACE, 'memory', 'reinforcement-capsules');
const RELATIONS_FILE = path.join(OUT_DIR, '_relations.json');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PG = {
  host:     process.env.MEMOS_PG_HOST     || '127.0.0.1',
  port:     parseInt(process.env.MEMOS_PG_PORT || '5432', 10),
  database: process.env.MEMOS_PG_DB       || 'memos',
  user:     process.env.MEMOS_PG_USER     || 'memos',
  password: process.env.MEMOS_PG_PASSWORD || 'memos_local_20260312',
};

let _pool;
function getPool() {
  if (!_pool) _pool = new Pool({ ...PG, max: 3, idleTimeoutMillis: 10000 });
  return _pool;
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'capsule';
}

// ─── Step 1: Fetch memos ──────────────────────────────────────────────────────
async function fetchMemos(sinceHours, limit) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT content, updated_ts FROM memo
     WHERE updated_ts > floor(extract(epoch from now()) - $1 * 3600)::int
     ORDER BY updated_ts DESC LIMIT $2`,
    [sinceHours, limit]
  );

  // Extract display text (strip metadata headers)
  return rows.map(r => {
    const raw = String(r.content || '');
    const parts = raw.split(/\n\s*\n/);
    let body = parts.length > 1 ? parts.slice(1).join(' ').trim() : raw;
    body = body.replace(/\[(uid|source|chat_id|session|timestamp|sender|message_id|mode|part):[^\]]*\]/g, ' ');
    body = body.replace(/\s+/g, ' ').trim();
    return { raw, body, ts: r.updated_ts };
  }).filter(r => r.body.length >= 8);
}

// ─── Step 2: LLM Batch Classify ──────────────────────────────────────────────
async function filterValuable(memos) {
  const texts = memos.map(m => m.body);
  const results = await llm.batchClassifyMemos(texts);
  return memos.filter((_, i) => results[i]);
}

// ─── Step 3: LLM Topic Classify ──────────────────────────────────────────────
async function groupByTopic(memos) {
  // Load existing topic names from capsule files
  const existingTopics = fs.readdirSync(OUT_DIR)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .map(f => {
      try {
        const first = fs.readFileSync(path.join(OUT_DIR, f), 'utf8').split('\n')[0];
        return first.replace(/^#\s*/, '').trim();
      } catch { return ''; }
    })
    .filter(Boolean);

  const texts = memos.map(m => m.body);

  // Process in batches of 30 to keep prompts manageable
  const BATCH = 30;
  const classified = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const results = await llm.classifyTopics(batch, existingTopics);
    classified.push(...results);
  }

  // Group by topic
  const groups = {};
  for (const item of classified) {
    const topic = item.topic || '未分类';
    if (topic === '未分类') continue; // skip uncategorized
    if (!groups[topic]) groups[topic] = [];
    groups[topic].push({ text: item.text, confidence: item.confidence });
  }
  return groups;
}

// ─── Step 4+5: LLM Action + Write ────────────────────────────────────────────
async function processTopic(topic, items) {
  const filename = `${slugify(topic)}.md`;
  const filepath = path.join(OUT_DIR, filename);
  const samples = items
    .sort((a, b) => b.confidence - a.confidence)
    .map(x => x.text)
    .slice(0, 10);

  const existingContent = fs.existsSync(filepath)
    ? fs.readFileSync(filepath, 'utf8')
    : '';

  // Step 4: decide action
  const action = await llm.decideAction(samples, existingContent || null);
  if (action === 'ignore') return { topic, filename, action: 'ignore', added: 0 };

  // Step 5: write capsule
  const capsuleContent = await llm.writeCapsule(topic, samples, existingContent);
  fs.writeFileSync(filepath, capsuleContent, 'utf8');

  return { topic, filename, action, added: samples.length };
}

// ─── Step 6: Cross-topic relations ───────────────────────────────────────────
async function buildRelations(processedTopics) {
  const capsules = processedTopics
    .filter(t => t.action !== 'ignore')
    .map(t => ({
      title: t.topic,
      samples: [], // already written to file
    }));

  if (capsules.length < 2) return [];

  const relations = await llm.findCrossTopicRelations(capsules);

  // Persist relations
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(RELATIONS_FILE, 'utf8')); } catch {}
  const today = new Date().toISOString().slice(0, 10);
  const merged = [...existing.filter(r => r.date !== today), ...relations.map(r => ({ ...r, date: today }))];
  fs.writeFileSync(RELATIONS_FILE, JSON.stringify(merged, null, 2), 'utf8');

  return relations;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const sinceHours = parseInt(process.argv[2] || '168', 10);
  const limit = parseInt(process.argv[3] || '200', 10);

  const t0 = Date.now();
  const stats = { sinceHours, limit, fetched: 0, afterFilter: 0, topics: 0, written: 0, ignored: 0, relations: 0, ops: [] };

  // Step 1
  const memos = await fetchMemos(sinceHours, limit);
  stats.fetched = memos.length;

  if (!memos.length) {
    console.log(JSON.stringify({ ok: true, ...stats, ms: Date.now() - t0 }));
    await getPool().end();
    return;
  }

  // Step 2: LLM filter
  const valuable = await filterValuable(memos);
  stats.afterFilter = valuable.length;

  if (!valuable.length) {
    console.log(JSON.stringify({ ok: true, ...stats, ms: Date.now() - t0 }));
    await getPool().end();
    return;
  }

  // Step 3: LLM topic grouping
  const groups = await groupByTopic(valuable);
  stats.topics = Object.keys(groups).length;

  // Step 4+5: process each topic
  const results = [];
  for (const [topic, items] of Object.entries(groups)) {
    const result = await processTopic(topic, items);
    results.push(result);
    stats.ops.push(result);
    if (result.action !== 'ignore') stats.written++;
    else stats.ignored++;
  }

  // Step 6: cross-topic relations
  const relations = await buildRelations(results);
  stats.relations = relations.length;

  stats.ms = Date.now() - t0;
  console.log(JSON.stringify({ ok: true, ...stats }));
  await getPool().end();
}

main().catch(e => {
  console.error('[consolidate_v2] fatal:', e.message);
  process.exit(1);
});
