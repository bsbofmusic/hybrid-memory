# @bsbofmusic/openclaw-memory-layer2

[![NPM Version](https://img.shields.io/npm/v/@bsbofmusic/openclaw-memory-layer2.svg)](https://www.npmjs.com/package/@bsbofmusic/openclaw-memory-layer2)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> [English](#english) | [中文](#中文)

---

<a name="english"></a>

## English

### Introduction
**OpenClaw Memory Layer2** is a production-grade Long-term Memory MCP (Model Context Protocol) Server designed for the OpenClaw ecosystem. It bridges the gap between raw conversation logs and high-precision retrieval by combining **Hindsight** (Semantic Recall) and **PostgreSQL Memos** (Hard Evidence Verification).

### Core Features
- **Hindsight-First, Memos-as-Judge**: Uses Hindsight for broad semantic association while enforcing strict entity alignment via Memos to prevent "hallucinated recall".
- **Hybrid Retrieval**: Simultaneous Keyword + Vector (Cosine Similarity) search with weighted boosting for high-recall Chinese matching.
- **Production Readiness**: Built-in PM2 support, bounded timeouts for external services, and automated ingest pipelines.
- **Clean Ingest**: Intelligent filtering of tool logs, system events, and meta-noise to keep the memory bank pure.

### Quick Start
```bash
# Install
npm install @bsbofmusic/openclaw-memory-layer2

# Run Diagnostics
npm run doctor

# Start with PM2
npm run pm2:start
```

---

<a name="中文"></a>

## 中文

### 简介
**OpenClaw Memory Layer2** 是为 OpenClaw 生态设计的生产级长效记忆 MCP 服务。它通过结合 **Hindsight**（语义召回）与 **PostgreSQL Memos**（硬核实锤校验），解决了原始对话记录在召回时的“语义漂移”与“幻觉”问题。

### 核心特性
- **Hindsight 召回，Memos 裁决**：利用 Hindsight 进行广度语义联想，同时通过 Memos 进行严格的实体对齐（关键词校验），防止“张冠李戴”。
- **混合检索框架**：支持关键词 + 向量（余弦相似度）双路融合检索，针对中文场景进行了分词优化，大幅提升召回率。
- **生产级稳定性**：内置 PM2 进程管理，外部服务调用带有硬超时保护，避免阻塞主对话链。
- **净化入库 (Ingest)**：智能过滤工具日志、系统事件及元数据噪音，确保记忆库的纯净度。

### 快速开始
```bash
# 安装
npm install @bsbofmusic/openclaw-memory-layer2

# 运行诊断
npm run doctor

# 使用 PM2 启动
npm run pm2:start
```

### 架构分工
1. **Layer 1 (OpenClaw Native)**: 负责稳定事实、规则、拍板结论。
2. **Layer 2 (This Package)**: 负责原话、细节、时间点、承诺。

---

## License
MIT © [bsbofmusic](https://github.com/bsbofmusic)
