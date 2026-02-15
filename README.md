# Ollama2OpenAI v2.0

将 Ollama API 转换为 OpenAI 兼容接口的代理服务，支持**批量 Key 管理**、**Round-Robin 轮询**、**自动健康检查**、**Web 管理后台**。

> Proxy service that converts Ollama API to OpenAI-compatible format with batch key management, round-robin load balancing, automatic health checks, and web admin panel.

## Features

- **OpenAI 兼容接口** - `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/v1/embeddings`
- **批量 Key 管理** - 一次性导入大量 Ollama Key，支持多种格式
- **Round-Robin 轮询** - 自动在多个 Key 之间轮询分发请求，负载均衡
- **自动健康检查** - 定期检测 Key 可用性，自动跳过故障 Key
- **自动重试** - 请求失败时自动切换到下一个可用 Key
- **流式 + 非流式** - 完整支持 SSE 流式传输和标准 JSON 响应
- **多模态支持** - 支持图片识别（Vision）
- **Tool Calling** - 支持工具调用 / Function Calling
- **Thinking 模式** - 支持 DeepSeek-R1 等推理模型的 thinking 输出
- **结构化输出** - 支持 JSON Mode 和 JSON Schema
- **连接测试兼容** - 支持 `GET /v1` 连接测试（兼容 ChatBox、OpenCat 等客户端）
- **Web 管理后台** - 可视化管理 Key、监控状态、批量导入
- **Docker 部署** - 一键 Docker Compose 部署
- **API Token 认证** - 可选的 API 访问认证

## Quick Start

### 方式一：直接运行

```bash
# 克隆仓库
git clone https://github.com/Zmin2003/ollama2openai.git
cd ollama2openai

# 安装依赖
npm install

# 复制配置文件并修改
cp .env.example .env
# 编辑 .env，修改 ADMIN_PASSWORD 等配置

# 启动服务
npm start

# 开发模式（文件变更自动重启）
npm run dev
```

### 方式二：Docker Compose（推荐）

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

| 服务 | 地址 |
|------|------|
| API Base URL | `http://localhost:3000/v1` |
| 管理后台 | `http://localhost:3000/admin` |
| 健康检查 | `http://localhost:3000/health` |

## Configuration

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `ADMIN_PASSWORD` | `admin123` | 管理后台密码（请务必修改） |
| `API_TOKEN` | _(空)_ | API 访问令牌，留空则不启用认证 |
| `OLLAMA_BASE_URL` | `https://ollama.com/api` | 默认 Ollama API 地址 |
| `HEALTH_CHECK_INTERVAL` | `60` | 健康检查间隔（秒），设为 `0` 禁用 |
| `CONNECT_TIMEOUT` | `30000` | 连接超时（毫秒），仅用于建立连接 |
| `REQUEST_TIMEOUT` | `300000` | 请求超时（毫秒），用于非流式请求 |
| `MAX_RETRIES` | `2` | 失败自动重试次数（自动切换 Key） |
| `LOG_LEVEL` | `info` | 日志级别：`debug`, `info`, `warn`, `error` |

## Key Import Formats

支持以下格式导入 Key（每行一个，支持批量导入）：

```
# 裸 Key（使用默认 OLLAMA_BASE_URL）
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

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1` | 连接测试 |
| `GET` | `/v1/models` | 获取模型列表 |
| `GET` | `/v1/models/:model` | 获取单个模型信息 |
| `POST` | `/v1/chat/completions` | 对话补全（支持流式） |
| `POST` | `/v1/completions` | 文本补全（支持流式） |
| `POST` | `/v1/embeddings` | 文本嵌入 |

### 调用示例

```bash
# 连接测试
curl http://localhost:3000/v1

# 模型列表
curl http://localhost:3000/v1/models

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

# Embeddings
curl http://localhost:3000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model": "nomic-embed-text", "input": "Hello world"}'

# Text Completions
curl http://localhost:3000/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3.2", "prompt": "Once upon a time", "stream": false}'
```

如果设置了 `API_TOKEN`，需要添加认证头：

```bash
curl -H "Authorization: Bearer your_api_token" http://localhost:3000/v1/models
```

### 管理接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/admin` | 管理后台 Web UI |
| `POST` | `/admin/login` | 登录 |
| `GET` | `/admin/api/keys` | 查看所有 Key |
| `POST` | `/admin/api/keys` | 添加单个 Key |
| `POST` | `/admin/api/keys/batch` | 批量导入 Key |
| `DELETE` | `/admin/api/keys/:id` | 删除 Key |
| `DELETE` | `/admin/api/keys` | 清空所有 Key |
| `POST` | `/admin/api/keys/:id/toggle` | 启用/禁用 Key |
| `POST` | `/admin/api/keys/check` | 检查所有 Key 健康状态 |
| `POST` | `/admin/api/keys/:id/check` | 检查单个 Key 健康状态 |
| `POST` | `/admin/api/keys/reset-health` | 重置所有 Key 健康状态 |
| `GET` | `/admin/api/stats` | 查看使用统计 |

```bash
# 批量导入 Key
curl -X POST http://localhost:3000/admin/api/keys/batch \
  -H "Authorization: Bearer admin123" \
  -H "Content-Type: application/json" \
  -d '{"keys": "key1\nkey2\nkey3"}'

# 查看所有 Key
curl http://localhost:3000/admin/api/keys \
  -H "Authorization: Bearer admin123"

# 健康检查
curl -X POST http://localhost:3000/admin/api/keys/check \
  -H "Authorization: Bearer admin123"
```

## Usage with AI Clients

在各种 AI 客户端中配置：

| 配置项 | 值 |
|--------|-----|
| API Base URL | `http://your-server:3000/v1` |
| API Key | 你设置的 `API_TOKEN`（未启用认证则随意填写） |
| Model | Ollama 可用模型名，如 `llama3.2`, `deepseek-r1` 等 |

已测试兼容的客户端：

- [ChatGPT Next Web](https://github.com/ChatGPTNextWeb/ChatGPT-Next-Web)
- [Open WebUI](https://github.com/open-webui/open-webui)
- [LobeChat](https://github.com/lobehub/lobe-chat)
- [Cherry Studio](https://github.com/kangfenmao/cherry-studio)
- [ChatBox](https://github.com/Bin-Huang/chatbox)
- [LibreChat](https://github.com/danny-avila/LibreChat)

## Project Structure

```
ollama2openai/
├── src/
│   ├── app.js                # 主入口，Express 服务器
│   ├── core/
│   │   ├── keyStore.js       # Key 存储、轮询、健康检查
│   │   └── transformer.js    # OpenAI <-> Ollama 格式转换
│   └── routes/
│       ├── openai.js         # OpenAI 兼容 API 路由
│       └── admin.js          # 管理后台路由 + Web UI
├── test/
│   ├── unit.test.js          # 单元测试
│   └── benchmark.js          # 性能基准测试
├── data/                     # Key 持久化存储（自动创建）
├── .env.example              # 配置模板
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

## Development

```bash
# 开发模式（文件变更自动重启）
npm run dev

# 运行单元测试
npm test

# 运行性能基准测试
npm run bench
```

## Requirements

- Node.js >= 18.0.0
- Ollama API 端点（自建或云端）

## License

MIT
