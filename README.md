# @bsbofmusic/openclaw-memory-layer2

Layer2 Memory MCP Server — semantic + structured recall over memos PostgreSQL.

## 这是什么

在 OpenClaw 双层记忆架构中提供 Layer2 能力：

- **Layer 1** (File Brain): OpenClaw memorySearch — 语义主链，规则/配置/拍板结论
- **Layer 2** (Raw Facts): memos PostgreSQL + 本 MCP — 原话/细节/承诺/上下文

本 MCP 将 memos PostgreSQL 封装为 stdio MCP Server，并复用 OpenClaw `agents.defaults.memorySearch` 的 embedding 配置提供语义搜索能力。

## 一键启用

### npx（无需安装）
```bash
npx @bsbofmusic/openclaw-memory-layer2
```

### npm 本地安装
```bash
npm install -g @bsbofmusic/openclaw-memory-layer2
openclaw-memory-layer2
```

### Docker（TODO v0.2）
```bash
docker run bsbofmusic/openclaw-memory-layer2
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCLAW_CONFIG` | `/var/lib/openclaw/.openclaw/openclaw.json` | 默认从这里读取 OpenClaw memorySearch 配置 |
| `LAYER2_EMBED_API_KEY` | *(可选 override)* | 显式覆盖 embedding API key |
| `LAYER2_EMBED_BASE_URL` | *(可选 override)* | 显式覆盖 embedding endpoint |
| `LAYER2_EMBED_MODEL` | *(可选 override)* | 显式覆盖 embedding model |
| `MEMOS_PG_HOST` | `127.0.0.1` | PostgreSQL 主机 |
| `MEMOS_PG_PORT` | `5432` | PostgreSQL 端口 |
| `MEMOS_PG_DB` | `memos` | 数据库名 |
| `MEMOS_PG_USER` | `memos` | 数据库用户 |
| `MEMOS_PG_PASSWORD` | `memos_local_20260312` | 数据库密码 |
| `LOG_LEVEL` | `info` | error / info / debug |
| `WORKSPACE` | `/var/lib/openclaw/.openclaw/workspace` | 工作区路径 |

## MCP 工具列表

| 工具 | 说明 |
|------|------|
| `semantic_search` | 复用 OpenClaw memorySearch embedding 配置 → cosine similarity 语义搜索 |
| `query_memos` | 结构化 SELECT（只读），支持参数化查询 |
| `get_memos_stats` | 统计：总数、private/public、24h活跃 |
| `trigger_ingest` | 触发 session → memos ingest |
| `memory_layer2_info` | Layer1/Layer2 分工文档 |
| `layer2_ensure` | Bootstrap 自检 |
| `layer2_doctor` | 完整诊断 + 修复建议 |
| `hindsight_health` | 检查 Hindsight 服务是否可达 |
| `layer2_answer` | Hindsight + memos 联合归纳回答入口 |
| `layer2_version` | 版本信息 |
| `layer2_list_commands` | 工具自发现 |

## 验证命令

```bash
# Doctor（独立诊断）
node doctor.js

# MCP 工具测试（默认复用 OpenClaw memorySearch embedding 配置）
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"layer2_ensure","arguments":{}}}' \
  | node index.js

# PostgreSQL 连接验证
PGPASSWORD='memos_local_20260312' psql -h 127.0.0.1 -U memos -d memos -Atqc "SELECT count(*) FROM memo;"
```

## 预期输出样例

### ✅ layer2_ensure 成功
```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"layer2_ensure:\n{\"ok\":true,\"steps\":[...]}\n"}]}}
```

### ❌ layer2_doctor 失败（OpenClaw embedding 配置缺失）
```
=== Layer2 Doctor v0.1.0 ===

Checks:
  ✅ PostgreSQL: connected, memo rows: 11398
  ❌ embedding: OpenClaw memorySearch embedding config not found
     → Fix: 配置 agents.defaults.memorySearch.remote.baseUrl/apiKey/model
  ✅ ingest_script: /var/lib/openclaw/.openclaw/workspace/scripts/ingest_session_raw_to_memos.py
  ✅ runtime_dir: /var/lib/openclaw/.openclaw/workspace/.layer2-runtime
  ✅ pg_module: pg package available

⚠️  Some checks failed — see above
```

## 自动更新策略

- 不做自动更新（v0.1）
- 每次调用前不做 ensureLatest 检查
- 手动升级：npm update 或重新安装包

## 已知限制

- semantic_search 在 v0.1 阶段为全文 embedding 逐条打分散列，未使用 pgvector 索引（v0.2 规划）
- 单次 semantic_search 最多 200 条 memo 初筛
- 若 OpenClaw memorySearch embedding 配置缺失，semantic_search 返回错误，其他功能正常
- trigger_ingest 为同步调用，超时时间 60s

## 合规声明

本项目是独立开发的 MCP Server，不封装任何第三方 GitHub 项目。
Layer2 默认复用 OpenClaw memorySearch 的 embedding 提供者与模型配置。


## Hindsight

- Layer2 已完成 **Hindsight + memos** 联合验证，默认读取：
  - `HINDSIGHT_BASE_URL`（默认 `http://127.0.0.1:8888`）
  - `HINDSIGHT_BANK_ID`（默认 `openclaw-main`）
- 已接入工具：`hindsight_health`、`layer2_answer`
- 当前定位：`memos` 提供原始事实/原话证据，`Hindsight` 提供 recall / reflect / 聚合归纳
- 当前已通过的是**架构级联合验证**；若继续推进，下一阶段才是回答质量调优与常驻化收口。

## 常驻运行

推荐用 PM2 常驻：

```bash
cd /var/lib/openclaw/.openclaw/workspace/npm-pkgs/openclaw-memory-layer2
npm run pm2:start
pm2 logs openclaw-memory-layer2
```
