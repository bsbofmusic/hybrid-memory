#!/usr/bin/env node
'use strict';

const reinforcement = require('./reinforcement');

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERT_FAIL:', msg);
    process.exit(1);
  }
}

const preview = reinforcement.expandQuery('hindsight 模糊搜索 和 耳洞枕 原话');
assert(preview.expansions.length >= 4, 'expansions should be generated');
assert(preview.expansions.some(x => /fuzzy recall|模糊匹配/.test(x)), 'fuzzy aliases should appear');

const ranked = reinforcement.dedupAndRerank({
  query: '耳洞枕 原话',
  expansions: preview.expansions,
  memoResults: [
    { text: '耳洞枕样品补发在 3 月 9 日前确认', score: 0.81 },
    { text: '耳洞枕样品补发在 3 月 9 日前确认', score: 0.79 },
  ],
  fileBrainHits: [
    { text: '耳洞枕项目是茶老板的重要副业主线', score: 0.73 },
  ],
  hindsightResults: [
    { text: '之前讨论过耳洞枕补发节点', score: 0.66 },
  ],
});
assert(ranked.length >= 2, 'ranked results should remain after dedup');
assert(ranked[0].text.includes('耳洞枕'), 'top ranked should stay relevant');

const plan = reinforcement.buildConsolidationPlan(ranked.map(x => x.text));
assert(Array.isArray(plan), 'consolidation plan should be array');
console.log(JSON.stringify({ ok: true, preview, ranked, plan }, null, 2));
