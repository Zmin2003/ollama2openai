# Ollama2OpenAI v2.0

将 Ollama API 转换为 OpenAI 标准接口的代理服务，支持**批量 Key 管理**、**Round-Robin 轮询**、**自动健康检查**、**Web 管理后台**。

> Proxy service that converts Ollama API to OpenAI-compatible format with batch key management, round-robin load balancing, health checks, and admin panel.

## Features

- **OpenAI 兼容接口** - 支持 `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/v1/embeddings`
- **批量 Key 管理** - 一次性导入大量 Ollama Key，支持多种格式
- **Round-Robin 轮询** - 自动在多个 Key 之间轮询分发请求
- **自动健康检查** - 定期检测 Key 可用性，自动标记故障 Key
- **New API 格式支持** - 支持 `URL|Key`、`URL#Key`、`URL/Key` 等多种导入格式
- **流式 + 非流式** - 完整支持 SSE 流式和标准 JSON 响应
- **多模态支持** - 支持图片识别（Vision）
- **Tool Calling** - 支持工具调用/Function Calling
- **Thinking 模式** - 支持 DeepSeek-R1 等推理模型的 thinking 输出
- **结构化输出** - 支持 JSON Mode 和 JSON Schema
- **Web 管理后台** - 可视化管理 Key、监控状态、批量导入
- **Docker 部署** - 一键 Docker 部署
- **API Token 认证** - 可选的 API 访问认证

## Quick Start

### 方式一：直接运行

```bash
# 安装依赖
npm install

# 复制配置文件
cp .env.example .env

# 编辑配置（修改 ADMIN_PASSWORD）
# nano .env

# 启动服务
npm start
```

### 方式二：Docker

```bash
docker compose up -d
```

### 方式三：Docker 手动构建

```bash
docker build -t ollama2openai .
docker run -d --name ollama2openai \
  -p 3000:3000 \
  -v ./data:/app/data \
  -e ADMIN_PASSWORD=your_password \
  ollama2openai
```

启动后访问：
- **API 地址**: `http://localhost:3000/v1`
- **管理后台**: `http://localhost:3000/admin`

## Configuration

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `ADMIN_PASSWORD` | `admin123` | 管理后台密码 |
| `API_TOKEN` | (空) | API 访问令牌，留空则不启用认证 |
| `OLLAMA_BASE_URL` | `https://ollama.com/api` | 默认 Ollama API 地址 |
| `HEALTH_CHECK_INTERVAL` | `60` | 健康检查间隔（秒） |
| `REQUEST_TIMEOUT` | `120000` | 请求超时（毫秒） |
| `LOG_LEVEL` | `info` | 日志级别: debug, info, warn, error |

## Key Import Formats

支持以下格式导入 Key（每行一个）：

```
# 裸 Key（使用默认 Base URL）
sk-xxxxxxxxxxxxxxxxxxxxxxxx

# URL|Key 格式
https://api.example.com|sk-xxxxxxxxxxxxxxxx

# Key|URL 格式
sk-xxxxxxxxxxxxxxxx|https://api.example.com

# URL#Key 格式
https://api.example.com#sk-xxxxxxxxxxxxxxxx

# New API 格式（URL/Key）
https://api.example.com/sk-xxxxxxxxxxxxxxxx
```

## API Endpoints

### OpenAI 兼容接口

```bash
# Chat Completions（流式）
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# Chat Completions（非流式）
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# Models 列表
curl http://localhost:3000/v1/models

# Embeddings
curl http://localhost:3000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model": "nomic-embed-text", "input": "Hello world"}'

# Text Completions
curl http://localhost:3000/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3.2", "prompt": "Once upon a time", "stream": false}'
```

如果设置了 `API_TOKEN`，需要加 Header：

```bash
curl -H "Authorization: Bearer your_api_token" http://localhost:3000/v1/models
```

### 管理接口

```bash
# 批量导入 Key
curl -X POST http://localhost:3000/admin/api/keys/batch \
  -H "Authorization: Bearer admin123" \
  -H "Content-Type: application/json" \
  -d '{"keys": "key1\nkey2\nkey3"}'

# 查看所有 Key
curl http://localhost:3000/admin/api/keys \
  -H "Authorization: Bearer admin123"

# 健康检查所有 Key
curl -X POST http://localhost:3000/admin/api/keys/check \
  -H "Authorization: Bearer admin123"
```

## Usage with AI Clients

在各种 AI 客户端中配置：

| 配置项 | 值 |
|--------|-----|
| API Base URL | `http://your-server:3000/v1` |
| API Key | 你设置的 `API_TOKEN`（如果启用了认证），否则随便填 |
| Model | 你的 Ollama 可用模型名，如 `llama3.2`, `deepseek-r1` 等 |

兼容的客户端：ChatGPT Next Web, Open WebUI, LobeChat, Cherry Studio, Chatbox, LibreChat 等。

## Project Structure

```
ollama2openai/
├── src/
│   ├── app.js              # 主入口
│   ├── core/
│   │   ├── keyStore.js      # Key 存储与管理
│   │   └── transformer.js   # 请求/响应格式转换
│   └── routes/
│       ├── openai.js        # OpenAI 兼容 API 路由
│       └── admin.js         # 管理后台路由 + Web UI
├── data/                    # Key 持久化存储（自动创建）
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## License

MIT
