#!/bin/bash
# Layer2 MCP Server launcher
# Usage: ./start.sh
# Env vars:
#   SILICONFLOW_API_KEY   (required for semantic_search)
#   SILICONFLOW_ENDPOINT  (default: https://api.siliconflow.cn/v1)
#   MEMOS_PG_HOST         (default: 127.0.0.1)
#   MEMOS_PG_PORT         (default: 5432)
#   MEMOS_PG_PASSWORD     (default: memos_local_20260312)
#   LOG_LEVEL             (default: info)
#   WORKSPACE             (default: /var/lib/openclaw/.openclaw/workspace)

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
exec node index.js
