/**
 * OpenAI-compatible API routes (Enterprise Edition)
 * Proxies requests to Ollama backends with weighted load balancing,
 * channel routing, metrics, token tracking, and structured logging
 */
import { Router } from 'express';
import keyStore from '../core/keyStore.js';
import channelManager from '../core/channelManager.js';
import tokenManager from '../core/tokenManager.js';
import cacheManager, { LRUCache } from '../core/cache.js';
import metrics from '../core/metrics.js';
import logger from '../core/logger.js';
import {
  transformChatRequest, transformCompletionsRequest, transformEmbeddingsRequest,
  transformModelsResponse, transformChatResponse, transformCompletionsResponse,
  transformEmbeddingsResponse, transformStreamChunk, generateChatId
} from '../core/transformer.js';

const router = Router();

const CONNECT_TIMEOUT = parseInt(process.env.CONNECT_TIMEOUT || '30000');
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '300000');
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '2');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// ============================================
// URL rewrite middleware for aliases without /v1 prefix
// ============================================
const URL_ALIASES = {
  '/chat/completions': '/v1/chat/completions',
  '/completions': '/v1/completions',
  '/embeddings': '/v1/embeddings',
  '/models': '/v1/models',
};

router.use((req, res, next) => {
  const alias = URL_ALIASES[req.path];
  if (alias) {
    req.url = alias + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
  }
  next();
});

// ============================================
// Helper: build target URL
// ============================================
function buildTargetUrl(baseUrl, apiPath) {
  if (baseUrl.endsWith('/api')) return `${baseUrl}${apiPath}`;
  return `${baseUrl}/api${apiPath}`;
}

// ============================================
// Helper: proxy request to Ollama
// ============================================
async function proxyToOllama(baseUrl, key, apiPath, method, body, isStream = false) {
  const targetUrl = buildTargetUrl(baseUrl, apiPath);
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const controller = new AbortController();
  const timeout = isStream ? CONNECT_TIMEOUT : REQUEST_TIMEOUT;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const fetchOpts = { method, headers, signal: controller.signal, redirect: 'follow' };
    if (body && method !== 'GET') fetchOpts.body = JSON.stringify(body);
    const res = await fetch(targetUrl, fetchOpts);
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout / 1000}s connecting to ${new URL(targetUrl).host}`);
    }
    throw e;
  }
}

// ============================================
// Helper: resolve backend (channel system OR key store)
// Returns { key, baseUrl, keyId, channelId, resolvedModel, source, sourceName }
// ============================================
function resolveBackend(model) {
  // Try channel system first
  if (channelManager.isActive()) {
    const channel = channelManager.selectChannel(model);
    if (channel) {
      const { key, baseUrl } = channelManager.getNextKey(channel.id);
      const resolvedModel = channelManager.resolveModel(channel, model);
      channelManager.acquireConcurrency(channel.id);
      return { key, baseUrl, keyId: null, channelId: channel.id, resolvedModel, source: 'channel', sourceName: channel.name };
    }
  }

  // Fall back to key store
  const keyObj = keyStore.getNextKey(model);
  if (!keyObj) return null;

  const resolvedModel = keyStore.resolveModel(keyObj, model);
  keyStore.acquireConcurrency(keyObj.id);
  return { key: keyObj.key, baseUrl: keyObj.baseUrl, keyId: keyObj.id, channelId: null, resolvedModel, source: 'keystore', sourceName: keyObj.name };
}

function recordBackendSuccess(backend, tokens = 0) {
  if (backend.channelId) channelManager.recordSuccess(backend.channelId, tokens);
  if (backend.keyId) keyStore.recordSuccess(backend.keyId, tokens);
}

function recordBackendFailure(backend, error) {
  if (backend.channelId) channelManager.recordFailure(backend.channelId, error);
  if (backend.keyId) keyStore.recordFailure(backend.keyId, error);
}

// ============================================
// Helper: proxy with retry (resolves backend per attempt)
// ============================================
async function proxyWithRetry(apiPath, method, body, isStream = false, model = null) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const backend = resolveBackend(model);
    if (!backend) {
      throw { status: 503, message: 'No available API keys or channels. Please configure in the admin panel.' };
    }

    // Apply model mapping to body if needed
    let actualBody = body;
    if (body && body.model && backend.resolvedModel !== body.model) {
      actualBody = { ...body, model: backend.resolvedModel };
    }

    try {
      const res = await proxyToOllama(backend.baseUrl, backend.key, apiPath, method, actualBody, isStream);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        recordBackendFailure(backend, `HTTP ${res.status}: ${errText.substring(0, 200)}`);
        metrics.upstreamErrors.inc({ error_type: `http_${res.status}` });

        if ((res.status === 401 || res.status === 403) && attempt < MAX_RETRIES) {
          logger.warn('Proxy', `Key ${backend.sourceName} got ${res.status}, trying next (${attempt + 1}/${MAX_RETRIES})`);
          lastError = { status: res.status, message: errText || res.statusText };
          continue;
        }
        throw { status: res.status, message: `Ollama error: ${errText || res.statusText}` };
      }

      if (!isStream) recordBackendSuccess(backend);
      return { res, backend };
    } catch (e) {
      if (e.status) throw e;
      recordBackendFailure(backend, e.message);
      metrics.upstreamErrors.inc({ error_type: 'connection' });

      if (attempt < MAX_RETRIES) {
        logger.warn('Proxy', `Key ${backend.sourceName} failed: ${e.message}, trying next (${attempt + 1}/${MAX_RETRIES})`);
        lastError = e;
        continue;
      }
      throw { status: 504, message: e.message };
    }
  }

  throw { status: 504, message: lastError?.message || 'All retries exhausted' };
}

// ============================================
// Helper: process stream
// ============================================
async function processStream(webBody, onLine, onEnd, onError) {
  const reader = webBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          try { onLine(buffer); } catch (e) {
            if (LOG_LEVEL === 'debug') logger.debug('Stream', 'Failed to process final buffer', { error: e.message });
          }
        }
        onEnd();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try { onLine(line); } catch (e) {
          if (LOG_LEVEL === 'debug') logger.debug('Stream', 'Failed to process line', { error: e.message });
        }
      }
    }
  } catch (e) {
    onError(e);
  }
}

// ============================================
// GET /v1/models
// ============================================
router.get('/v1/models', async (req, res) => {
  const start = Date.now();
  try {
    const { res: ollamaRes } = await proxyWithRetry('/tags', 'GET', null, false);
    const data = await ollamaRes.json();
    const result = transformModelsResponse(data);

    metrics.requestsTotal.inc({ method: 'GET', endpoint: '/v1/models', status: '200' });
    metrics.requestDuration.observe({ method: 'GET', endpoint: '/v1/models' }, (Date.now() - start) / 1000);

    return res.json(result);
  } catch (e) {
    metrics.requestsTotal.inc({ method: 'GET', endpoint: '/v1/models', status: String(e.status || 500) });
    logger.error('API', `/v1/models error: ${e.message}`);
    return res.status(e.status || 500).json({ error: { message: e.message, type: 'server_error' } });
  }
});

// ============================================
// POST /v1/chat/completions
// ============================================
router.post('/v1/chat/completions', async (req, res) => {
  const start = Date.now();
  try {
    const openaiReq = req.body;
    if (!openaiReq.model) {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }

    // Check model access for multi-token auth
    if (req.tokenObj && tokenManager.isMultiTokenMode()) {
      if (!tokenManager.checkModelAccess(req.tokenObj, openaiReq.model)) {
        return res.status(403).json({ error: { message: `Model '${openaiReq.model}' not allowed for this token`, type: 'permission_error' } });
      }
    }

    const ollamaReq = transformChatRequest(openaiReq);
    const isStream = ollamaReq.stream === true;

    // Check cache for non-streaming requests
    const cache = cacheManager.getChatCache();
    let cacheKey = null;

    if (cache && !isStream) {
      cacheKey = LRUCache.generateChatKey(openaiReq.model, openaiReq.messages, {
        temperature: openaiReq.temperature, top_p: openaiReq.top_p,
        max_tokens: openaiReq.max_tokens, response_format: openaiReq.response_format, tools: openaiReq.tools,
      });
      const cached = cache.get(cacheKey);
      if (cached) {
        metrics.cacheHits.inc({ cache_type: 'chat' });
        return res.json({ ...cached, cached: true });
      }
      metrics.cacheMisses.inc({ cache_type: 'chat' });
    }

    const { res: ollamaRes, backend } = await proxyWithRetry('/chat', 'POST', ollamaReq, isStream, openaiReq.model);

    if (!isStream) {
      const data = await ollamaRes.json();
      const response = transformChatResponse(data, openaiReq.model, openaiReq.messages);
      const totalTokens = response.usage?.total_tokens || 0;

      recordBackendSuccess(backend, totalTokens);

      // Track token usage
      if (req.tokenObj) {
        tokenManager.recordUsage(req.tokenObj.id, response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0);
      }

      metrics.tokensTotal.inc({ type: 'prompt' }, response.usage?.prompt_tokens || 0);
      metrics.tokensTotal.inc({ type: 'completion' }, response.usage?.completion_tokens || 0);
      metrics.requestsTotal.inc({ method: 'POST', endpoint: '/v1/chat/completions', status: '200' });
      metrics.requestDuration.observe({ method: 'POST', endpoint: '/v1/chat/completions' }, (Date.now() - start) / 1000);

      logger.logRequest({
        endpoint: '/v1/chat/completions', model: openaiReq.model, stream: false,
        tokens: totalTokens, duration: Date.now() - start,
        tokenId: req.tokenObj?.id, backend: backend.sourceName,
      });

      if (cache && cacheKey) cache.set(cacheKey, response);
      return res.json(response);
    }

    // Streaming response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    metrics.activeStreams.inc();

    const chatId = generateChatId();
    const created = Math.floor(Date.now() / 1000);
    let isFirstChunk = true;
    let tokenCount = 0;
    let aborted = false;
    let streamSuccess = false;
    let finalUsage = null;

    req.on('close', () => { aborted = true; });

    await processStream(
      ollamaRes.body,
      (line) => {
        if (aborted) return;
        const ollamaChunk = JSON.parse(line);
        if (ollamaChunk.message?.content) tokenCount++;
        const openaiChunk = transformStreamChunk(ollamaChunk, chatId, created, openaiReq.model, isFirstChunk, tokenCount);
        isFirstChunk = false;
        res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);

        if (ollamaChunk.done) {
          streamSuccess = true;
          finalUsage = openaiChunk.usage;
        }
      },
      () => {
        metrics.activeStreams.dec();
        const totalTokens = finalUsage?.total_tokens || 0;

        if (streamSuccess || !aborted) {
          recordBackendSuccess(backend, totalTokens);
        }

        if (req.tokenObj && finalUsage) {
          tokenManager.recordUsage(req.tokenObj.id, finalUsage.prompt_tokens || 0, finalUsage.completion_tokens || 0);
        }

        metrics.tokensTotal.inc({ type: 'prompt' }, finalUsage?.prompt_tokens || 0);
        metrics.tokensTotal.inc({ type: 'completion' }, finalUsage?.completion_tokens || 0);
        metrics.requestsTotal.inc({ method: 'POST', endpoint: '/v1/chat/completions', status: '200' });
        metrics.requestDuration.observe({ method: 'POST', endpoint: '/v1/chat/completions' }, (Date.now() - start) / 1000);

        logger.logRequest({
          endpoint: '/v1/chat/completions', model: openaiReq.model, stream: true,
          tokens: totalTokens, duration: Date.now() - start,
          tokenId: req.tokenObj?.id, backend: backend.sourceName,
        });

        if (!aborted && !res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      },
      (e) => {
        metrics.activeStreams.dec();
        logger.error('Stream', `Error: ${e.message}`);
        recordBackendFailure(backend, `Stream error: ${e.message}`);
        if (!aborted && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'stream_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    );

  } catch (e) {
    metrics.requestsTotal.inc({ method: 'POST', endpoint: '/v1/chat/completions', status: String(e.status || 500) });
    logger.error('API', `/v1/chat/completions error: ${e.message}`);
    if (!res.headersSent) {
      return res.status(e.status || 500).json({ error: { message: e.message, type: 'server_error' } });
    }
    if (!res.writableEnded) res.end();
  }
});

// ============================================
// POST /v1/completions
// ============================================
router.post('/v1/completions', async (req, res) => {
  const start = Date.now();
  try {
    const openaiReq = req.body;
    if (!openaiReq.model) {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }

    const ollamaReq = transformCompletionsRequest(openaiReq);
    const isStream = ollamaReq.stream === true;

    const { res: ollamaRes, backend } = await proxyWithRetry('/generate', 'POST', ollamaReq, isStream, openaiReq.model);

    if (!isStream) {
      const data = await ollamaRes.json();
      const response = transformCompletionsResponse(data, openaiReq.model);
      recordBackendSuccess(backend, response.usage?.total_tokens || 0);

      metrics.requestsTotal.inc({ method: 'POST', endpoint: '/v1/completions', status: '200' });
      metrics.requestDuration.observe({ method: 'POST', endpoint: '/v1/completions' }, (Date.now() - start) / 1000);

      logger.logRequest({
        endpoint: '/v1/completions', model: openaiReq.model, stream: false,
        tokens: response.usage?.total_tokens || 0, duration: Date.now() - start, backend: backend.sourceName,
      });

      return res.json(response);
    }

    // Streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    metrics.activeStreams.inc();

    const chatId = generateChatId();
    const created = Math.floor(Date.now() / 1000);
    let aborted = false;
    let streamSuccess = false;

    req.on('close', () => { aborted = true; });

    await processStream(
      ollamaRes.body,
      (line) => {
        if (aborted) return;
        const ollamaChunk = JSON.parse(line);
        const sseChunk = {
          id: chatId, object: 'text_completion', created, model: openaiReq.model,
          choices: [{ index: 0, text: ollamaChunk.response || '', finish_reason: ollamaChunk.done ? 'stop' : null }],
        };
        if (ollamaChunk.done) {
          sseChunk.usage = {
            prompt_tokens: ollamaChunk.prompt_eval_count || 0,
            completion_tokens: ollamaChunk.eval_count || 0,
            total_tokens: (ollamaChunk.prompt_eval_count || 0) + (ollamaChunk.eval_count || 0),
          };
          streamSuccess = true;
        }
        res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
      },
      () => {
        metrics.activeStreams.dec();
        if (streamSuccess || !aborted) recordBackendSuccess(backend);
        metrics.requestsTotal.inc({ method: 'POST', endpoint: '/v1/completions', status: '200' });
        metrics.requestDuration.observe({ method: 'POST', endpoint: '/v1/completions' }, (Date.now() - start) / 1000);
        if (!aborted && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
      },
      (e) => {
        metrics.activeStreams.dec();
        recordBackendFailure(backend, `Stream error: ${e.message}`);
        if (!aborted && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'stream_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    );

  } catch (e) {
    metrics.requestsTotal.inc({ method: 'POST', endpoint: '/v1/completions', status: String(e.status || 500) });
    logger.error('API', `/v1/completions error: ${e.message}`);
    if (!res.headersSent) return res.status(e.status || 500).json({ error: { message: e.message, type: 'server_error' } });
    if (!res.writableEnded) res.end();
  }
});

// ============================================
// POST /v1/embeddings
// ============================================
router.post('/v1/embeddings', async (req, res) => {
  const start = Date.now();
  try {
    const openaiReq = req.body;
    if (!openaiReq.model) {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }

    const cache = cacheManager.getEmbeddingsCache();
    let cacheKey = null;

    if (cache) {
      cacheKey = LRUCache.generateKey(openaiReq.model, openaiReq.input);
      const cached = cache.get(cacheKey);
      if (cached) {
        metrics.cacheHits.inc({ cache_type: 'embeddings' });
        return res.json({ ...cached, cached: true });
      }
      metrics.cacheMisses.inc({ cache_type: 'embeddings' });
    }

    const ollamaReq = transformEmbeddingsRequest(openaiReq);
    const { res: ollamaRes } = await proxyWithRetry('/embed', 'POST', ollamaReq, false, openaiReq.model);

    const data = await ollamaRes.json();
    const response = transformEmbeddingsResponse(data, openaiReq.model);

    if (cache && cacheKey) cache.set(cacheKey, response);

    metrics.requestsTotal.inc({ method: 'POST', endpoint: '/v1/embeddings', status: '200' });
    metrics.requestDuration.observe({ method: 'POST', endpoint: '/v1/embeddings' }, (Date.now() - start) / 1000);

    return res.json(response);
  } catch (e) {
    metrics.requestsTotal.inc({ method: 'POST', endpoint: '/v1/embeddings', status: String(e.status || 500) });
    logger.error('API', `/v1/embeddings error: ${e.message}`);
    return res.status(e.status || 500).json({ error: { message: e.message, type: 'server_error' } });
  }
});

// ============================================
// Client compatibility routes
// ============================================
router.get('/v1', (req, res) => {
  res.json({ object: 'list', data: [], message: 'Ollama2OpenAI API is running' });
});

router.get('/v1/models/:model', async (req, res) => {
  try {
    const { res: ollamaRes } = await proxyWithRetry('/tags', 'GET', null, false);
    const data = await ollamaRes.json();
    const models = transformModelsResponse(data);
    const model = models.data.find(m => m.id === req.params.model);
    if (model) return res.json(model);
    return res.status(404).json({ error: { message: `Model '${req.params.model}' not found`, type: 'not_found' } });
  } catch (e) {
    return res.status(e.status || 500).json({ error: { message: e.message, type: 'server_error' } });
  }
});

export default router;
