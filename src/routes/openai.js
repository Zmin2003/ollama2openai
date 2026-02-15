/**
 * OpenAI-compatible API routes
 * Proxies requests to Ollama backends with round-robin key selection
 */
import { Router } from 'express';
import keyStore from '../core/keyStore.js';
import cacheManager, { LRUCache } from '../core/cache.js';
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
// Helper: build target URL from key object
// ============================================

function buildTargetUrl(keyObj, path) {
  const baseUrl = keyObj.baseUrl;
  if (baseUrl.endsWith('/api')) {
    return `${baseUrl}${path}`;
  }
  return `${baseUrl}/api${path}`;
}

// ============================================
// Helper: proxy request to Ollama
// For streaming: timeout only applies to connection phase (getting first byte)
// For non-streaming: timeout applies to the whole request
// ============================================

async function proxyToOllama(keyObj, path, method, body, isStream = false) {
  const targetUrl = buildTargetUrl(keyObj, path);

  const headers = {
    'Content-Type': 'application/json',
  };

  if (keyObj.key) {
    headers['Authorization'] = `Bearer ${keyObj.key}`;
  }

  const controller = new AbortController();
  const timeout = isStream ? CONNECT_TIMEOUT : REQUEST_TIMEOUT;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const fetchOpts = {
      method,
      headers,
      signal: controller.signal,
      redirect: 'follow',
    };

    if (body && method !== 'GET') {
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetch(targetUrl, fetchOpts);

    // BUG FIX (perf opt 4): For streaming, clear the connection timeout immediately
    // after receiving the response headers. The stream itself may take a long time,
    // but the connection has been established.
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
// Helper: proxy with retry (try next key on failure)
// BUG FIX: Returns keyObj alongside response so caller can decide
// when to record success (important for streaming - success should
// only be recorded after stream completes)
// ============================================

async function proxyWithRetry(path, method, body, isStream = false) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const keyObj = keyStore.getNextKey();
    if (!keyObj) {
      throw { status: 503, message: 'No available API keys. Please add keys in the admin panel.' };
    }

    try {
      const res = await proxyToOllama(keyObj, path, method, body, isStream);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        keyStore.recordFailure(keyObj.id, `HTTP ${res.status}: ${errText.substring(0, 200)}`);

        if ((res.status === 401 || res.status === 403) && attempt < MAX_RETRIES) {
          console.warn(`[Retry] Key ${keyObj.name} got ${res.status}, trying next key (${attempt + 1}/${MAX_RETRIES})`);
          lastError = { status: res.status, message: errText || res.statusText };
          continue;
        }

        throw { status: res.status, message: `Ollama error: ${errText || res.statusText}` };
      }

      // BUG FIX: For non-streaming, record success immediately since the full
      // response has been received. For streaming, the caller must handle
      // recording success/failure after stream processing completes.
      if (!isStream) {
        keyStore.recordSuccess(keyObj.id);
      }

      return { res, keyObj };
    } catch (e) {
      if (e.status) throw e;

      keyStore.recordFailure(keyObj.id, e.message);

      if (attempt < MAX_RETRIES) {
        console.warn(`[Retry] Key ${keyObj.name} failed: ${e.message}, trying next key (${attempt + 1}/${MAX_RETRIES})`);
        lastError = e;
        continue;
      }

      throw { status: 504, message: e.message };
    }
  }

  throw { status: 504, message: lastError?.message || 'All retries exhausted' };
}

// ============================================
// Helper: read Web ReadableStream line by line and call handler
// Works on ALL Node.js versions (no Readable.fromWeb needed)
// BUG FIX: Added debug logging for JSON parse errors instead of
// silently swallowing them
// ============================================

async function processStream(webBody, onLine, onEnd, onError) {
  const reader = webBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Process remaining buffer
        if (buffer.trim()) {
          try {
            onLine(buffer);
          } catch (e) {
            if (LOG_LEVEL === 'debug') {
              console.warn('[Stream] Failed to process final buffer:', e.message, '| Data:', buffer.substring(0, 100));
            }
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
        try {
          onLine(line);
        } catch (e) {
          if (LOG_LEVEL === 'debug') {
            console.warn('[Stream] Failed to process line:', e.message, '| Data:', line.substring(0, 100));
          }
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
  try {
    const { res: ollamaRes } = await proxyWithRetry('/tags', 'GET', null, false);
    const data = await ollamaRes.json();
    return res.json(transformModelsResponse(data));
  } catch (e) {
    console.error('[/v1/models] Error:', e.message);
    return res.status(e.status || 500).json({ error: { message: e.message, type: 'server_error' } });
  }
});

// ============================================
// POST /v1/chat/completions
// ============================================
router.post('/v1/chat/completions', async (req, res) => {
  try {
    const openaiReq = req.body;
    if (!openaiReq.model) {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }

    const ollamaReq = transformChatRequest(openaiReq);
    const isStream = ollamaReq.stream !== false;

    // Check cache for non-streaming chat requests
    const cache = cacheManager.getChatCache();
    let cacheKey = null;
    
    if (cache && !isStream) {
      cacheKey = LRUCache.generateChatKey(openaiReq.model, openaiReq.messages, {
        temperature: openaiReq.temperature,
        top_p: openaiReq.top_p,
        max_tokens: openaiReq.max_tokens,
        response_format: openaiReq.response_format,
        tools: openaiReq.tools,
      });
      
      const cached = cache.get(cacheKey);
      if (cached) {
        if (LOG_LEVEL === 'debug') {
          console.log('[/v1/chat/completions] Cache HIT for model:', openaiReq.model);
        }
        return res.json({ ...cached, cached: true });
      }
      if (LOG_LEVEL === 'debug') {
        console.log('[/v1/chat/completions] Cache MISS for model:', openaiReq.model);
      }
    }

    const { res: ollamaRes, keyObj } = await proxyWithRetry('/chat', 'POST', ollamaReq, isStream);

    if (!isStream) {
      const data = await ollamaRes.json();
      const response = transformChatResponse(data, openaiReq.model, openaiReq.messages);
      
      // Cache the response
      if (cache && cacheKey) {
        cache.set(cacheKey, response);
      }
      
      return res.json(response);
    }

    // Streaming response - SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const chatId = generateChatId();
    const created = Math.floor(Date.now() / 1000);
    let isFirstChunk = true;
    let tokenCount = 0;
    let aborted = false;
    let streamSuccess = false;

    req.on('close', () => { aborted = true; });

    await processStream(
      ollamaRes.body,
      (line) => {
        if (aborted) return;
        const ollamaChunk = JSON.parse(line);
        if (ollamaChunk.message?.content) tokenCount++;
        const openaiChunk = transformStreamChunk(
          ollamaChunk, chatId, created, openaiReq.model, isFirstChunk, tokenCount
        );
        isFirstChunk = false;
        res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);

        // Mark stream as successfully completed when done signal is received
        if (ollamaChunk.done) {
          streamSuccess = true;
        }
      },
      () => {
        // BUG FIX: Record success only after stream fully completes
        if (streamSuccess) {
          keyStore.recordSuccess(keyObj.id);
        } else if (!aborted) {
          // Stream ended without done signal - ambiguous, but count as success
          // since we received data without errors
          keyStore.recordSuccess(keyObj.id);
        }

        if (!aborted && !res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      },
      (e) => {
        console.error('[stream] Error:', e.message);
        // BUG FIX: Record failure when stream errors
        keyStore.recordFailure(keyObj.id, `Stream error: ${e.message}`);

        if (!aborted && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'stream_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    );

  } catch (e) {
    console.error('[/v1/chat/completions] Error:', e.message);
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
  try {
    const openaiReq = req.body;
    if (!openaiReq.model) {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }

    const ollamaReq = transformCompletionsRequest(openaiReq);
    const isStream = ollamaReq.stream !== false;

    const { res: ollamaRes, keyObj } = await proxyWithRetry('/generate', 'POST', ollamaReq, isStream);

    if (!isStream) {
      const data = await ollamaRes.json();
      return res.json(transformCompletionsResponse(data, openaiReq.model));
    }

    // Streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

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
          id: chatId,
          object: 'text_completion',
          created,
          model: openaiReq.model,
          choices: [{
            index: 0,
            text: ollamaChunk.response || '',
            finish_reason: ollamaChunk.done ? 'stop' : null,
          }],
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
        if (streamSuccess || !aborted) {
          keyStore.recordSuccess(keyObj.id);
        }
        if (!aborted && !res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      },
      (e) => {
        keyStore.recordFailure(keyObj.id, `Stream error: ${e.message}`);
        if (!aborted && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'stream_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    );

  } catch (e) {
    console.error('[/v1/completions] Error:', e.message);
    if (!res.headersSent) return res.status(e.status || 500).json({ error: { message: e.message, type: 'server_error' } });
    if (!res.writableEnded) res.end();
  }
});

// ============================================
// POST /v1/embeddings
// ============================================
router.post('/v1/embeddings', async (req, res) => {
  try {
    const openaiReq = req.body;
    if (!openaiReq.model) {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }

    // Check cache first
    const cache = cacheManager.getEmbeddingsCache();
    const cacheKey = LRUCache.generateKey(openaiReq.model, openaiReq.input);
    
    if (cache) {
      const cached = cache.get(cacheKey);
      if (cached) {
        if (LOG_LEVEL === 'debug') {
          console.log('[/v1/embeddings] Cache HIT for model:', openaiReq.model);
        }
        // Return cached response with cache indicator
        return res.json({ ...cached, cached: true });
      }
      if (LOG_LEVEL === 'debug') {
        console.log('[/v1/embeddings] Cache MISS for model:', openaiReq.model);
      }
    }

    const ollamaReq = transformEmbeddingsRequest(openaiReq);
    const { res: ollamaRes } = await proxyWithRetry('/embed', 'POST', ollamaReq, false);

    const data = await ollamaRes.json();
    const response = transformEmbeddingsResponse(data, openaiReq.model);

    // Store in cache
    if (cache) {
      cache.set(cacheKey, response);
    }

    return res.json(response);
  } catch (e) {
    console.error('[/v1/embeddings] Error:', e.message);
    return res.status(e.status || 500).json({ error: { message: e.message, type: 'server_error' } });
  }
});

// ============================================
// Client compatibility routes
// ============================================

// GET /v1 - connection test endpoint (ChatBox, OpenCat, etc.)
router.get('/v1', (req, res) => {
  res.json({
    object: 'list',
    data: [],
    message: 'Ollama2OpenAI API is running',
  });
});

// GET /v1/models/:model - single model info (ChatBox, OpenCat)
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

// BUG FIX: Aliases without /v1 prefix - use proper next() middleware chaining
// instead of router.handle() which doesn't exist in Express Router
router.post('/chat/completions', (req, res, next) => { req.url = '/v1/chat/completions'; next(); });
router.post('/completions', (req, res, next) => { req.url = '/v1/completions'; next(); });
router.post('/embeddings', (req, res, next) => { req.url = '/v1/embeddings'; next(); });
router.get('/models', (req, res, next) => { req.url = '/v1/models'; next(); });

export default router;
