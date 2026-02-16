# Ollama2OpenAI v3.0 Enterprise

将 Ollama API 转换为 OpenAI 兼容接口的**企业级**代理服务。

> Enterprise-grade proxy that converts Ollama API to OpenAI-compatible format with weighted load balancing, channel routing, multi-token auth, rate limiting, Prometheus metrics, and a full admin panel.

## ✨ Features

### Core
- **OpenAI 兼容接口** - `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/v1/embeddings`
- **流式 + 非流式** - 完整支持 SSE 流式传输和标准 JSON 响应
- **多模态支持** - 支持图片识别（Vision）
- **Tool Calling** - 支持工具调用 / Function Calling
- **Thinking 模式** - 支持 DeepSeek-R1 等推理模型
- **结构化输出** - 支持 JSON Mode / JSON Schema

### Enterprise (v3.0 新增)
- **加权负载均衡** - 基于权重和优先级的智能请求分发
- **Channel 系统** - 多后端分组管理，优先级路由，模型映射
- **多用户 Token** - 创建多个 API Token，独立配额、权限、使用跟踪
- **速率限制** - 全局 / Per-IP / Per-Token 三层速率限制
- **IP 访问控制** - 白名单 / 黑名单模式，支持 CIDR
- **Prometheus 指标** - `/metrics` 端点，接入 Grafana 监控
- **结构化日志** - 请求日志、审计日志，支持文件输出
- **并发控制** - Per-Key / Per-Channel 并发限制
- **模型映射** - 跨后端模型名称重映射（如 `gpt-4` → `llama3.2:70b`）
- **企业级管理后台** - 6 个标签页：Dashboard / Keys / Tokens / Channels / Logs / Settings

## Quick Start

### 方式一：直接运行

```bash
git clone https://github.com/Zmin2003/ollama2openai.git
cd ollama2openai
npm install
cp .env.example .env
# 编辑 .env，修改 ADMIN_PASSWORD 等配置
npm start
```

### 方式二：Docker Compose（推荐）

```bash
docker compose up -d
```

### 方式三：Docker

```bash
docker build -t ollama2openai .
docker run -d --name ollama2openai \
  -p 3000:3000 \
  -v ./data:/app/data \
  -e ADMIN_PASSWORD=your_password \
  ollama2openai
```

启动后访问：

| 服务 | 地址 |
|------|------|
| API Base URL | `http://localhost:3000/v1` |
| 管理后台 | `http://localhost:3000/admin` |
| 健康检查 | `http://localhost:3000/health` |
| Prometheus 指标 | `http://localhost:3000/metrics` |

## Configuration

### 基础配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `ADMIN_PASSWORD` | `admin123` | 管理后台密码（**请务必修改**） |
| `API_TOKEN` | _(空)_ | 传统单 Token 认证，留空禁用 |
| `OLLAMA_BASE_URL` | `https://ollama.com/api` | 默认 Ollama API 地址 |
| `TRUST_PROXY` | `false` | 反向代理后设为 `true` |

### 连接与重试

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `CONNECT_TIMEOUT` | `30000` | 连接超时（ms） |
| `REQUEST_TIMEOUT` | `300000` | 请求超时（ms） |
| `MAX_RETRIES` | `2` | 失败自动重试次数 |
| `HEALTH_CHECK_INTERVAL` | `60` | 健康检查间隔（秒） |

### 速率限制

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `RATE_LIMIT_GLOBAL_ENABLED` | `true` | 全局限速开关 |
| `RATE_LIMIT_GLOBAL_MAX` | `500` | 全局限速（次/窗口） |
| `RATE_LIMIT_GLOBAL_WINDOW` | `60000` | 全局窗口（ms） |
| `RATE_LIMIT_IP_ENABLED` | `true` | Per-IP 限速开关 |
| `RATE_LIMIT_IP_MAX` | `60` | Per-IP 限速 |
| `RATE_LIMIT_TOKEN_ENABLED` | `true` | Per-Token 限速开关 |
| `RATE_LIMIT_TOKEN_MAX` | `120` | Per-Token 限速 |

### IP 访问控制

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `IP_ACCESS_MODE` | `disabled` | `disabled` / `whitelist` / `blacklist` |
| `IP_WHITELIST` | _(空)_ | 白名单 IP（逗号分隔，支持 CIDR） |
| `IP_BLACKLIST` | _(空)_ | 黑名单 IP |

### 日志

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_TO_FILE` | `false` | 请求日志写入文件 |
| `LOG_RECENT_MAX` | `500` | 内存中保留的最近日志条数 |

### 缓存

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `CACHE_EMBEDDINGS` | `true` | Embeddings 缓存 |
| `CACHE_EMBEDDINGS_MAX_SIZE` | `1000` | 最大缓存条目 |
| `CACHE_CHAT` | `false` | Chat 缓存（仅非流式） |
| `CACHE_CHAT_MAX_SIZE` | `500` | 最大缓存条目 |

## Key Import Formats

支持以下格式（每行一个，`#` 开头为注释）：

```
sk-xxxxxxxxxxxxxxxxxxxxxxxx
https://api.example.com|sk-xxxxxxxxxxxxxxxx
sk-xxxxxxxxxxxxxxxx|https://api.example.com
https://api.example.com#sk-xxxxxxxxxxxxxxxx
https://api.example.com/sk-xxxxxxxxxxxxxxxx
```

## Channel System

Channel（渠道）是 v3.0 的核心功能，允许将多个后端分组管理：

```
Channel "Cloud GPU" (priority=10, weight=50)
  ├── key1 → https://gpu-cloud.example.com/api
  ├── key2 → https://gpu-cloud.example.com/api
  └── models: llama3.2:70b, deepseek-r1

Channel "Self-hosted" (priority=0, weight=10)
  ├── key3 → http://localhost:11434/api
  └── models: * (all)
```

- **优先级路由** - 高优先级 Channel 优先使用
- **加权负载均衡** - 同优先级内按权重分配
- **模型映射** - `{"gpt-4": "llama3.2:70b"}` 自动转换模型名称
- **并发控制** - 每个 Channel 可设最大并发数
- **自动降级** - 故障率 >80% 自动标记不健康

## Multi-Token Auth

创建多个 API Token 分配给不同用户/应用：

- **独立配额** - 每月 Token 用量限制
- **模型限制** - 限制可用模型（支持通配符 `llama*`）
- **IP 限制** - 限制 Token 可访问的 IP
- **过期时间** - 自动过期
- **用量追踪** - 按天统计请求数、Token 消耗

在管理后台 **Tokens** 标签页创建和管理。

## API Endpoints

### OpenAI 兼容

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1` | 连接测试 |
| `GET` | `/v1/models` | 模型列表 |
| `POST` | `/v1/chat/completions` | 对话补全 |
| `POST` | `/v1/completions` | 文本补全 |
| `POST` | `/v1/embeddings` | 文本嵌入 |

### 监控

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查（JSON） |
| `GET` | `/metrics` | Prometheus 指标 |

### 管理接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/admin` | 管理后台 Web UI |
| `POST` | `/admin/login` | 登录 |
| `GET/POST/DELETE` | `/admin/api/keys` | Key 管理 |
| `GET/POST/PUT/DELETE` | `/admin/api/tokens` | Token 管理 |
| `GET/POST/PUT/DELETE` | `/admin/api/channels` | Channel 管理 |
| `GET/DELETE` | `/admin/api/logs` | 日志查看 |
| `GET/POST` | `/admin/api/settings` | 设置管理 |
| `GET` | `/admin/api/dashboard` | 仪表盘数据 |

### 调用示例

```bash
# Chat Completions
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-o2o-your-token" \
  -d '{"model": "llama3.2", "messages": [{"role": "user", "content": "Hello!"}]}'

# Embeddings
curl http://localhost:3000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model": "nomic-embed-text", "input": "Hello world"}'

# Prometheus Metrics
curl http://localhost:3000/metrics
```

## Prometheus Metrics

可用指标：

| 指标 | 类型 | 说明 |
|------|------|------|
| `ollama2openai_requests_total` | Counter | 请求总数 |
| `ollama2openai_request_duration_seconds` | Histogram | 请求延迟 |
| `ollama2openai_tokens_total` | Counter | Token 消耗 |
| `ollama2openai_active_connections` | Gauge | 活跃连接 |
| `ollama2openai_active_streams` | Gauge | 活跃流 |
| `ollama2openai_keys_healthy` | Gauge | 健康 Key 数 |
| `ollama2openai_cache_hits_total` | Counter | 缓存命中 |
| `ollama2openai_rate_limit_hits_total` | Counter | 限速触发 |
| `ollama2openai_upstream_errors_total` | Counter | 上游错误 |
| `ollama2openai_uptime_seconds` | Gauge | 运行时间 |
| `ollama2openai_memory_bytes` | Gauge | 内存用量 |

## Usage with AI Clients

| 配置项 | 值 |
|--------|-----|
| API Base URL | `http://your-server:3000/v1` |
| API Key | 管理后台创建的 Token 或 `API_TOKEN` |
| Model | Ollama 可用模型名 |

兼容客户端：ChatGPT Next Web, Open WebUI, LobeChat, Cherry Studio, ChatBox, LibreChat

## Project Structure

```
ollama2openai/
├── src/
│   ├── app.js                  # 主入口，中间件注册
│   ├── core/
│   │   ├── keyStore.js          # Key 存储、加权 LB、健康检查
│   │   ├── channelManager.js    # Channel 路由管理
│   │   ├── tokenManager.js      # 多用户 Token 管理
│   │   ├── rateLimiter.js       # 三层速率限制
│   │   ├── accessControl.js     # IP 白/黑名单
│   │   ├── metrics.js           # Prometheus 指标
│   │   ├── logger.js            # 结构化日志
│   │   ├── cache.js             # LRU 缓存
│   │   └── transformer.js       # OpenAI ↔ Ollama 格式转换
│   └── routes/
│       ├── openai.js            # OpenAI 兼容路由
│       └── admin.js             # 管理后台路由 + Web UI
├── data/                        # 持久化数据（自动创建）
│   ├── keys.json
│   ├── tokens.json
│   ├── channels.json
│   ├── access.json
│   └── logs/
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Development

```bash
npm run dev       # 开发模式（自动重启）
npm test          # 单元测试
npm run bench     # 性能基准测试
```

## Requirements

- Node.js >= 18.0.0
- Ollama API 端点

## License

MIT
