# FBM 源码模块 → hybrid-memory 补强映射表 v1

## 原则
- 必须按 FBM 源码模块对照，不凭 README 印象改造
- 有现成成熟机制，优先借思路和结构，不重复手搓平行轮子
- 不粗暴移植整套 FBM；只抽补强层所需轮子，保持 Hindsight 主脑不变

---

## 模块映射

| FBM 源码模块 | FBM 作用 | hybrid-memory 当前对应 | 当前状态 | 下一步动作 |
|---|---|---|---|---|
| `keyword-extractor` | query expansion / recall enhancement | `reinforcement.expandQuery()` | 仅规则表 v1 | 按 FBM 提取 query rewrite / alias expansion / intent shaping 思路升级 |
| `memory-consolidator` | consolidation 决策 | `reinforcement.buildConsolidationPlan()` | 仅 topic whitelist + promote/keep_raw | 引入 append / update / supersede / ignore 决策 |
| `node-locator` | heading/node 精确定位 | capsule markdown 输出 | 尚未接入 | 改造 capsule 为 section/heading 可更新结构 |
| topic-oriented memory structuring | 主题组织 | `memory/reinforcement-capsules/*.md` | 仅主题标题 + samples | 升级为摘要 / 已确认事实 / 变更点 / 时间点 / 证据片段 |
| retrieval orchestration | 检索编排 | `layer2_answer` | 已切到 Hindsight 主脑优先 | 继续优化 fallback 门控与候选融合 |

---

## 当前已完成的“借轮子”
1. 已按 FBM 思路引入 query expansion 概念
2. 已按 FBM 思路引入 consolidation / capsule 概念
3. 已将主链调整为 Hindsight 主脑优先、memos fallback

## 当前仍属“手搓骨架”的部分
1. `expandQuery()` 仍偏规则表，不是 FBM 对照版 recall enhancer
2. `buildConsolidationPlan()` 仍缺 append/update/supersede/ignore
3. capsule 仍不是 heading/node 可更新结构

---

## 改造纪律
- 先对照 FBM 源码模块，再改代码
- 每做一块，必须写明“借的是 FBM 哪个机制”
- 若当前实现与 FBM 已有成熟机制重复，优先重构，不继续堆手搓逻辑
