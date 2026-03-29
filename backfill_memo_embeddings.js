#!/usr/bin/env node
// 批量回填memo的embedding向量字段
'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Config
const PG = {
  host:     process.env.MEMOS_PG_HOST     || '127.0.0.1',
  port:     parseInt(process.env.MEMOS_PG_PORT || '5432', 10),
  database: process.env.MEMOS_PG_DB        || 'memos',
  user:     process.env.MEMOS_PG_USER      || 'memos',
  password: process.env.MEMOS_PG_PASSWORD  || 'memos_local_20260312',
};
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || '/var/lib/openclaw/.openclaw/openclaw.json';
const BATCH_SIZE = 10;
const DELAY_MS = 1000; // 每批间隔1秒，避免API限流

function loadOpenClawMemorySearch() {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG, 'utf8');
    const cfg = JSON.parse(raw);
    return cfg?.agents?.defaults?.memorySearch || {};
  } catch {
    return {};
  }
}
const MEMORY_SEARCH_CFG = loadOpenClawMemorySearch();
const EMBED_MODEL = process.env.LAYER2_EMBED_MODEL || MEMORY_SEARCH_CFG?.model || 'BAAI/bge-m3';
const EMBED_BASE_URL = process.env.LAYER2_EMBED_BASE_URL || MEMORY_SEARCH_CFG?.remote?.baseUrl || 'https://api.siliconflow.cn/v1';
const EMBED_API_KEY = process.env.LAYER2_EMBED_API_KEY || MEMORY_SEARCH_CFG?.remote?.apiKey || '';

let pool = null;
function getPool() {
  if (!pool || pool.ended) {
    pool = new Pool(PG);
    pool.on('error', err => console.error('PG pool error', err.message));
  }
  return pool;
}

async function pgQuery(sql, params = []) {
  const client = await getPool().connect();
  try {
    const result = await client.query(sql, params);
    return { ok: true, rows: result.rows, rowCount: result.rowCount };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }
}

async function getEmbedding(text, model = EMBED_MODEL) {
  const input = text.slice(0, 8000);
  const response = await fetch(`${EMBED_BASE_URL.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${EMBED_API_KEY}`
    },
    body: JSON.stringify({
      model,
      input,
      encoding_format: 'float'
    })
  });
  if (!response.ok) throw new Error(`Embedding API error: ${response.status}`);
  const data = await response.json();
  return data.data[0].embedding;
}

async function backfillEmbeddings() {
  console.log('=== 开始回填memo embedding ===');
  console.log(`模型: ${EMBED_MODEL}`);
  console.log(`接口: ${EMBED_BASE_URL}`);
  
  // 先统计总共有多少条需要回填
  const countRes = await pgQuery(`SELECT COUNT(*) as total FROM memo WHERE embedding IS NULL AND LENGTH(content) > 20`);
  const total = countRes.ok ? parseInt(countRes.rows[0].total, 10) : 0;
  console.log(`待回填总数: ${total}`);
  if (total === 0) {
    console.log('✅ 所有memo已有embedding，无需回填');
    return;
  }

  let processed = 0;
  let success = 0;
  let failed = 0;

  while (processed < total) {
    console.log(`\n处理批次: ${processed + 1}/${Math.ceil(total / BATCH_SIZE)}`);
    // 取一批需要回填的memo
    const batchRes = await pgQuery(
      `SELECT id, content FROM memo WHERE embedding IS NULL AND LENGTH(content) > 20 ORDER BY id LIMIT $1`,
      [BATCH_SIZE]
    );
    if (!batchRes.ok || batchRes.rows.length === 0) break;

    for (const row of batchRes.rows) {
      try {
        console.log(`处理memo id=${row.id}...`);
        const embedding = await getEmbedding(row.content);
        // 写入向量
        const updateRes = await pgQuery(
          `UPDATE memo SET embedding = $1 WHERE id = $2`,
          [JSON.stringify(embedding), row.id]
        );
        if (updateRes.ok) success++;
        else failed++;
        processed++;
      } catch (e) {
        console.error(`memo id=${row.id} 处理失败: ${e.message}`);
        failed++;
        processed++;
      }
    }

    // 每批休眠避免限流
    if (processed < total) {
      console.log(`批次处理完成，休眠${DELAY_MS}ms...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log('\n=== 回填完成 ===');
  console.log(`总处理: ${processed}`);
  console.log(`成功: ${success}`);
  console.log(`失败: ${failed}`);
  process.exit(0);
}

backfillEmbeddings().catch(e => {
  console.error('回填失败:', e.message);
  process.exit(1);
});
