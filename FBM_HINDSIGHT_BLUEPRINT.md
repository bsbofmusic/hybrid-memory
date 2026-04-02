# FBM + Hindsight 并行补强蓝图 v1

## 目标
在不破坏 Hindsight 上游升级路径的前提下，将 Hybrid Memory 收口为：

- Layer1：memorySearch（文件脑）
- Layer2 主脑：Hindsight（主 recall / reflect / reasoning）
- 并行补强：FBM-style reinforcement（query expansion / consolidation / topic capsule / candidate shaping）
- Raw evidence fallback：memos（原话、时间点、细节、原始事实）

核心目标：智能化、稳定性、高效性、通用性。

---

## 正式调用顺序
默认主链：

1. `memorySearch`：规则 / 总结 / 拍板 / 长期口径
2. `Hindsight`：主 recall / 主 reflect / 主推理候选
3. `FBM-style reinforcement`：
   - query expansion
   - candidate shaping
   - rerank
   - consolidation / capsule planning
4. `memos fallback`：
   - 当前面拿不到足够候选
   - 或需要原话 / 时间点 / 承诺 / 证据实锤时

即：

`memorySearch -> Hindsight -> reinforcement -> memos fallback`

---

## 边界定义

### 1. Hindsight 负责什么
- 主 recall
- 主 reflect
- recall 结果的语义组织
- 主回答链的高层推理

### 2. reinforcement 负责什么
- recall enhancement（扩词、别名、模糊召回增强）
- candidate shaping（去重、来源分层、重排）
- consolidation（闲时/定时整理）
- topic capsule 生成与维护
- append / update / supersede / ignore 决策（后续引入）

### 3. memos 负责什么
- 原话
- 时间点
- 原始事实
- fallback 证据层

### 4. 明确不做什么
- 不把 reinforcement 深焊进 Hindsight 本体
- 不把 memos 当前置主脑
- 不新建平行事实仓
- 不把 FBM 整套粗暴移植成另一套独立脑

---

## 当前代码与目标的差距

### 当前现状（待收口）
`layer2_answer` 仍是：
- 先 `semanticSearch(reinforcedQuery)` 命中 memos
- 再按门控调用 Hindsight
- file brain 只是 fallback

这仍偏向：**memos 主位，Hindsight 增强**。

### 目标状态
`layer2_answer` 改成：
- 先基于 query 生成 reinforcement preview
- 先跑 Hindsight recall / reflect（主脑优先）
- 视 query 类型决定是否同时调用 file brain
- 仅当 Hindsight / file brain 候选不足，或用户明确要原话/时间点/承诺时，再触发 memos fallback
- reinforcement 统一做 candidate shaping / rerank

---

## FBM 源码借鉴落点（必须对源码，不凭印象）

后续蓝图与实现必须对照 FBM 源码以下模块：

1. `keyword-extractor`
   - 借：query expansion / recall enhancement
   - 当前对应：`reinforcement.expandQuery`

2. `memory-consolidator`
   - 借：append / update / supersede / ignore 决策
   - 当前对应：`reinforcement.buildConsolidationPlan`

3. `node-locator` / heading model
   - 借：capsule heading / section 级更新
   - 当前对应：尚未落地

4. retrieval / index 组织
   - 借：topic-oriented memory structuring 思想
   - 当前对应：topicRules + capsule 仅是初版骨架

要求：
- 蓝图里标清参考的是 FBM 哪个源码模块
- 落地前先反查 FBM 现成机制，避免重复造轮子

---

## 代码落地顺序

### Phase A：主链优先级收口
- 将 `layer2_answer` 从“memos 主位”改为“Hindsight 主位 + memos fallback”
- 更新返回文案与 architecture 说明

### Phase B：reinforcement 结构升级
- 将 `expandQuery` 从规则表升级为 FBM 对照版映射
- 将 `buildConsolidationPlan` 从 topic whitelist 升级为 decision engine 雏形

### Phase C：capsule 结构升级
- 生成结构化 topic capsule：
  - 摘要
  - 已确认事实
  - 变更点
  - 时间点
  - 证据片段
- 后续引入 heading / node 级更新

### Phase D：验证与回归
- query case regression
- recall quality regression
- consolidation quality regression
- 对比“旧链路 vs 新链路”样本输出

---

## 验收标准

### 智能化
- 模糊问题不再只能靠 memos 硬搜
- Hindsight 主 recall 能拿到更高质量候选

### 稳定性
- 不改 Hindsight 本体升级链
- reinforcement 独立可迭代

### 高效性
- memos 不再默认前置深搜
- 正常 query 的响应链更轻

### 通用性
- 不把系统写死在 memos schema 上
- reinforcement 逻辑可迁移到其他 raw fact store

---

## 当前一句话口径

正式主链：

**memorySearch + Hindsight（主脑） + FBM-style reinforcement（并行补强） + memos fallback（原文证据层）**
