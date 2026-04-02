#!/usr/bin/env node
'use strict';

const reinforcement = require('./reinforcement');

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERT_FAIL:', msg);
    process.exit(1);
  }
}

const items = [
  '耳洞枕样品补发将在 3 月 9 日前确认',
  '耳洞枕样品补发节点已确定 3 月 9 日检查',
  '耳洞枕补发与 3 月 15 日大货检查相关',
  'hybrid-memory 正式成为记忆 MCP 工作台',
  'hybrid-memory 工作台整合 hindsight 与 memos',
];

const plan = reinforcement.buildConsolidationPlan(items);
assert(plan.length >= 2, 'should produce multiple clusters');
assert(plan.some(x => x.action === 'promote_capsule' || x.action === 'merge_review'), 'should produce non-keep_raw action');
console.log(JSON.stringify({ ok: true, plan }, null, 2));
