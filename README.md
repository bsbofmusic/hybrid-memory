# @bsbofmusic/hybrid-memory

[![NPM Version](https://img.shields.io/npm/v/@bsbofmusic/hybrid-memory.svg)](https://www.npmjs.com/package/@bsbofmusic/hybrid-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Hybrid Memory MCP Server for OpenClaw — a production-oriented memory verification layer that combines **Hindsight semantic recall** with **memos PostgreSQL evidence lookup**.

---

## 中文简介

**Hybrid Memory** 是一个为 OpenClaw 生态设计的长期记忆 MCP（Model Context Protocol）服务。

它的目标不是取代 OpenClaw 原生记忆，而是补上“**原话 / 细节 / 时间点 / 上下文证据**”这一层能力：

- **OpenClaw memorySearch / File Brain**：适合规则、拍板、阶段总结、长期稳定事实
- **Hybrid Memory**：适合原话、细节、承诺、上下文、历史细颗粒度追溯

所以它本质上是一个 **evidence-first 的混合记忆验证层**：

- 用 **Hindsight** 做语义 recall / reflect
- 用 **memos PostgreSQL** 做原始事实检索与落点校验
- 复用 OpenClaw 的 embedding 配置，尽量减少重复系统和额外漂移

---

## 为什么有这个项目

在真实对话系统里，常见问题不是“没有记忆”，而是：

1. **总结有了，但原话没了**
2. **能想起主题，但找不到证据**
3. **回忆像是对的，但时间点和上下文对不上**
4. **多个记忆层混在一起，正式规则和历史细节打架**

Hybrid Memory 就是为了解决这个问题：

- 不只做“像是记得”
- 而是尽量做到“**能召回、能核对、能解释来源**”

---

## 核心优势

### 1. Hindsight + memos 联合验证
不是单纯的向量搜，也不是只跑 SQL。

它采用两段式思路：

- **Hindsight**：负责语义联想、主题扩展、召回候选
- **memos PostgreSQL**：负责事实落点、原话和上下文证据

这样可以减少“语义像，但不是同一件事”的误召回。

### 2. 与 OpenClaw 现有记忆体系互补
Hybrid Memory 不是另起炉灶，而是明确做分层：

- **Layer 1 / File Brain**：规则、拍板、总结
- **Hybrid Memory / raw-facts layer**：原话、细节、时间点、承诺、上下文

这比把所有东西都塞进一个 recall 入口更稳。

### 3. 生产导向，而不是实验玩具
这个包从设计上就考虑了：

- PM2 常驻运行
- 诊断命令（doctor）
- ingest 触发
- bounded timeout
- stdio MCP 接入
- 对 OpenClaw / mcporter / 本地脚本链更友好

### 4. 保留兼容，不粗暴断旧链
虽然正式名称已经升级为 **Hybrid Memory**，但部分内部 tool 名仍保留 `layer2_*` 前缀，作为兼容层，避免现有调用面直接炸掉。

---

## 适用场景

适合这些问题：

- “之前怎么说的？”
- “哪天答应过什么？”
- “这件事以前有没有讨论过？”
- “把和这个主题相关的历史细节挖出来”
- “给我查原话，不要只给总结”
- “做 Hindsight + memos 的联合归因验证”

尤其适合：

- 长对话系统
- 多 channel / 多 session 协作
- 需要把“总结层”和“原话证据层”拆开的记忆架构
- 需要对历史承诺、事实时间点、上下文链路做精确反查的场景

---

## 演进背景 / 更新历史

### v0.2.3 — hybrid-memory 正式命名收口
- 正式包名切换为 `@bsbofmusic/hybrid-memory`
- GitHub 仓库切换为 `bsbofmusic/hybrid-memory`
- PM2 进程名切换为 `hybrid-memory`
- mcporter 服务名切换为 `hybrid-memory`
- README / skill / 本地目录口径统一到 Hybrid Memory
- 保留 `layer2_*` tool 名兼容层，避免旧调用面断裂

### 早期阶段
该项目最初以 `openclaw-memory-layer2` 的形式存在，承担“原话 / 细节 / 时间点”这一层实验性和过渡性能力。随着结构收敛，正式升级为 **Hybrid Memory**，强调其作为“混合验证记忆层”的定位，而不是简单的“Layer2 名称标签”。

---

## 架构定位

```text
OpenClaw File Brain / memorySearch
  └─ 规则 / 拍板 / 总结 / 稳定事实

Hybrid Memory
  ├─ memos PostgreSQL：原话 / 细节 / 时间点 / 上下文
  └─ Hindsight：recall / reflect / 语义扩展
```

一句话：

> **File Brain 管稳定结论，Hybrid Memory 管历史细节与证据。**

---

## 功能概览

### Semantic Search
- `semantic_search(query, topK, minScore)`
- 对 memos 内容做语义相似检索
- 返回候选结果与分数

### Structured Query
- `query_memos(sql, params, limit)`
- 只允许 SELECT
- 用于精确拉取 memos 原始记录

### Stats
- `get_memos_stats()`
- 查看 memo 总数、活跃状态、最近 ingest 等

### Ingest Trigger
- `trigger_ingest(dry_run=false)`
- 触发 session jsonl → memos 导入链

### Doctor / Self-check
- `layer2_doctor()`
- `layer2_ensure()`
- `layer2_version()`
- `layer2_list_commands()`

---

## 安装

### npm
```bash
npm install -g @bsbofmusic/hybrid-memory
```

### 本地开发
```bash
cd /var/lib/openclaw/.openclaw/workspace/npm-pkgs/hybrid-memory
npm install
npm link
```

---

## MCP / mcporter 接入

### 通用 stdio MCP
```json
{
  "command": "hybrid-memory",
  "type": "stdio"
}
```

### mcporter 示例
```json
{
  "mcpServers": {
    "hybrid-memory": {
      "command": "node",
      "args": [
        "/var/lib/openclaw/.openclaw/workspace/npm-pkgs/hybrid-memory/index.js"
      ]
    }
  }
}
```

---

## 环境变量

```bash
SILICONFLOW_API_KEY=sk-xxx
SILICONFLOW_ENDPOINT=https://api.siliconflow.cn/v1

MEMOS_PG_HOST=127.0.0.1
MEMOS_PG_PORT=5432
MEMOS_PG_DB=memos
MEMOS_PG_USER=memos
MEMOS_PG_PASSWORD=your_password

WORKSPACE=/var/lib/openclaw/.openclaw/workspace
LOG_LEVEL=info
```

---

## 常用命令

```bash
# 运行诊断
npm run doctor

# PM2 启动
npm run pm2:start

# PM2 重启
npm run pm2:restart

# 查看版本
mcporter call hybrid-memory.layer2_version --args '{}'

# 语义搜索
mcporter call hybrid-memory.semantic_search --args '{"query":"之前答应过什么","topK":5}'

# 查最近 memos
mcporter call hybrid-memory.query_memos --args '{"sql":"SELECT id, content, created_ts FROM memo ORDER BY created_ts DESC LIMIT 20"}'
```

---

## 兼容策略

Hybrid Memory 已是正式名称，但为了避免现网调用面断裂，当前仍保留部分内部 tool 名前缀：

- `layer2_version`
- `layer2_doctor`
- `layer2_ensure`
- `layer2_list_commands`

这属于**兼容接口保留**，不代表正式品牌仍然叫 Layer2。

---

## 适合谁

如果你正在做的是：

- OpenClaw 记忆系统增强
- MCP 记忆层设计
- 多层记忆架构拆分
- 原话证据检索
- 历史上下文归因验证

那这个包会很合适。

如果你只需要一个“单纯向量数据库 + embedding 搜索”的极简组件，那 Hybrid Memory 可能比你需要的更偏“系统集成型”。

---

## License

MIT © [bsbofmusic](https://github.com/bsbofmusic)
