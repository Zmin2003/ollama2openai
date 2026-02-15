/**
 * OpenAI-compatible API routes
 * Proxies requests to Ollama backends with round-robin key selection
 */
import { Router } from 'express';
import keyStore from '../core/keyStore.js';
import {
  transformChatRequest, transformCompletionsRequest, transformEmbeddingsRequest,
  transformModelsResponse, transformChatResponse, transformCompletionsResponse,
  transformEmbeddingsResponse, transformStreamChunk, generateChatId
} from '../core/transformer.js';

const router = Router();

const CONNECT_TIMEOUT = parseInt(process.env.CONNECT_TIMEOUT || '30000');
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '300000');
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '2');

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
// isStream: if true, only apply connect timeout (not total timeout)
// ============================================

async function proxyToOllama(keyObj, path, method, body, isStream = false) {
  const targetUrl = buildTargetUrl(keyObj, path);

  const headers = {
    'Content-Type': 'application/json',
    'Host': new URL(targetUrl).host,
    'Origin': new URL(targetUrl).origin,
  };

  if (keyObj.key) {
    headers['Authorization'] = `Bearer ${keyObj.key}`;
  }

  const controller = new AbortController();
  // For streaming: only set a connect timeout, clear it once response headers arrive
  // For non-streaming: set a full request timeout
  const timeout = isStream ? CONNECT_TIMEOUT : REQUEST_TIMEOUT;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const fetchOpts = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body && method !== 'GET') {
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetch(targetUrl, fetchOpts);
    // Response headers received - connection established
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
        keyStore.recordFailure(keyObj.id, `HTTP ${res.status}: ${errText.substring(0, 100)}`);

        // 401/403 = key invalid, retry with next key
        if ((res.status === 401 || res.status === 403) && attempt < MAX_RETRIES) {
          console.warn(`[Retry] Key ${keyObj.name} got ${res.status}, trying next key (${attempt + 1}/${MAX_RETRIES})`);
          lastError = { status: res.status, message: errText || res.statusText };
          continue;
        }

        throw { status: res.status, message: `Ollama error: ${errText || res.statusText}` };
      }

      keyStore.recordSuccess(keyObj.id);
      return { res, keyObj };
    } catch (e) {
      if (e.status) throw e; // Already formatted error

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

// Also support /models
router.get('/models', async (req, res) => {
  req.url = '/v1/models';
  return router.handle(req, res);
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

    const { res: ollamaRes } = await proxyWithRetry('/chat', 'POST', ollamaReq, isStream);

    if (!isStream) {
      // Non-streaming response
      const data = await ollamaRes.json();
      return res.json(transformChatResponse(data, openaiReq.model));
    }

    // Streaming response - SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Flush headers immediately so client knows connection is alive
    res.flushHeaders();

    const chatId = generateChatId();
    const created = Math.floor(Date.now() / 1000);
    let isFirstChunk = true;
    let buffer = '';

    const reader = ollamaRes.body;
    reader.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ollamaChunk = JSON.parse(line);
          const openaiChunk = transformStreamChunk(
            ollamaChunk, chatId, created, openaiReq.model, isFirstChunk
          );
          isFirstChunk = false;
          res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
        } catch (e) {
          // Skip malformed lines
        }
      }
    });

    reader.on('end', () => {
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const ollamaChunk = JSON.parse(buffer);
          const openaiChunk = transformStreamChunk(
            ollamaChunk, chatId, created, openaiReq.model, isFirstChunk
          );
          res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
        } catch (e) { /* skip */ }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });

    reader.on('error', (e) => {
      console.error('[stream] Error:', e.message);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'stream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    // Handle client disconnect
    req.on('close', () => {
      if (!reader.destroyed) reader.destroy();
    });

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

    const { res: ollamaRes } = await proxyWithRetry('/generate', 'POST', ollamaReq, isStream);

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
    let buffer = '';

    const reader = ollamaRes.body;
    reader.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
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
          }
          res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
        } catch (e) { /* skip */ }
      }
    });

    reader.on('end', () => {
      if (buffer.trim()) {
        try {
          const ollamaChunk = JSON.parse(buffer);
          const sseChunk = {
            id: chatId, object: 'text_completion', created, model: openaiReq.model,
            choices: [{ index: 0, text: ollamaChunk.response || '', finish_reason: ollamaChunk.done ? 'stop' : null }],
          };
          res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
        } catch (e) { /* skip */ }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });

    reader.on('error', (e) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'stream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    req.on('close', () => { if (!reader.destroyed) reader.destroy(); });

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

    const ollamaReq = transformEmbeddingsRequest(openaiReq);
    const { res: ollamaRes } = await proxyWithRetry('/embed', 'POST', ollamaReq, false);

    const data = await ollamaRes.json();
    return res.json(transformEmbeddingsResponse(data, openaiReq.model));
  } catch (e) {
    console.error('[/v1/embeddings] Error:', e.message);
    return res.status(e.status || 500).json({ error: { message: e.message, type: 'server_error' } });
  }
});

export default router;
