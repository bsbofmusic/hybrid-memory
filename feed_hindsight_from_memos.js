#!/usr/bin/env node
'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const hindsight = require('./hindsight');

const WORKSPACE = process.env.WORKSPACE || '/var/lib/openclaw/.openclaw/workspace';
const RUNTIME_DIR = path.join(WORKSPACE, '.layer2-runtime');
const CHECKPOINT = path.join(RUNTIME_DIR, 'hindsight_feed_checkpoint.json');
const PG = {
  host: process.env.MEMOS_PG_HOST || '127.0.0.1',
  port: Number(process.env.MEMOS_PG_PORT || '5432'),
  database: process.env.MEMOS_PG_DB || 'memos',
  user: process.env.MEMOS_PG_USER || 'memos',
  password: process.env.MEMOS_PG_PASSWORD || 'memos_local_20260312',
};

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')); } catch { return { lastId: 0 }; }
}
function saveCheckpoint(lastId) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ lastId, updatedAt: new Date().toISOString() }, null, 2));
}

async function main() {
  const batchSize = Number(process.argv.includes('--batch-size') ? process.argv[process.argv.indexOf('--batch-size') + 1] : 20);
  const dryRun = process.argv.includes('--dry-run');
  const cp = loadCheckpoint();
  const pool = new Pool(PG);
  const rs = await pool.query(
    `SELECT id, uid, content, creator_id, created_ts, updated_ts, payload
       FROM memo
      WHERE id > $1 AND visibility = 'PRIVATE' AND length(content) > 20
      ORDER BY id ASC
      LIMIT $2`,
    [cp.lastId, batchSize]
  );
  let lastId = cp.lastId;
  const out = [];
  for (const row of rs.rows) {
    lastId = row.id;
    if (dryRun) {
      out.push({ id: row.id, action: 'would_retain' });
      continue;
    }
    const r = await hindsight.retain(row.content.slice(0, 12000), {
      memo_id: String(row.id),
      uid: String(row.uid || ''),
      creator_id: String(row.creator_id || ''),
      created_ts: String(row.created_ts || ''),
      updated_ts: String(row.updated_ts || ''),
      context: 'memos-ingest'
    });
    out.push({ id: row.id, ok: r.ok, endpoint: r.endpoint || null, error: r.error || null });
    if (!r.ok) break;
  }
  await pool.end();
  if (!dryRun && out.length && out[out.length - 1].ok) saveCheckpoint(lastId);
  console.log(JSON.stringify({ checkpointBefore: cp, processed: out.length, lastId, results: out }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
