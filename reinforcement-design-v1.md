# Reinforcement Module v1

## 目标
为现有 Layer2 提供一个独立补强模块，不侵入 Hindsight 本体，先落最小可运行版：

1. query normalization / expansion
2. candidate merge / dedup / rerank
3. consolidation hook（先输出计划，不直接改写事实仓）

## 边界
- Layer1 仍是 OpenClaw memorySearch
- Hindsight 仍是开源 recall / reflect 主脑
- memos 仍是事实仓
- Reinforcement Module 只做外挂增强，不重造主脑

## v1 实现
- `reinforcement.js`
  - `expandQuery(query)`：规则型 query expansion
  - `dedupAndRerank(...)`：合并 memos / file / hindsight 候选后重排
  - `buildConsolidationPlan(items)`：根据候选结果给出 consolidation 建议
- `index.js`
  - `layer2_answer` 接入 reinforcement：
    - semantic search 前做 query expansion
    - 候选结果统一走 rerank
    - 返回补强模块工作信息
  - 新增 `reinforcement_preview` 工具：可单独查看补强模块行为

## 下一轮
1. 用轻模型替换规则型 expansion
2. 引入 alias map / person map / project map
3. consolidation 从“计划输出”升级为“定时写 capsule”
4. 将 reinforcement artifacts 独立持久化
