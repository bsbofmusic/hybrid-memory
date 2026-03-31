module.exports = {
  apps: [
    {
      name: 'hybrid-memory',
      script: './index.js',
      cwd: '/var/lib/openclaw/.openclaw/workspace/npm-pkgs/hybrid-memory',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        WORKSPACE: '/var/lib/openclaw/.openclaw/workspace',
        OPENCLAW_CONFIG: '/var/lib/openclaw/.openclaw/openclaw.json',
        MEMOS_PG_HOST: '127.0.0.1',
        MEMOS_PG_PORT: '5432',
        MEMOS_PG_DB: 'memos',
        MEMOS_PG_USER: 'memos',
        MEMOS_PG_PASSWORD: 'memos_local_20260312',
        HINDSIGHT_BASE_URL: 'http://127.0.0.1:8888',
        HINDSIGHT_BANK_ID: 'openclaw-main',
        LOG_LEVEL: 'info'
      }
    }
  ]
};
