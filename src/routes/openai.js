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

const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '120000');

// ============================================
// Helper: proxy request to Ollama
// ============================================

async function proxyToOllama(keyObj, path, method, body, timeout) {
  let baseUrl = keyObj.baseUrl;

  // Build target URL
  let targetUrl;
  if (baseUrl.endsWith('/api')) {
    targetUrl = `${baseUrl}${path}`;
  } else if (baseUrl.includes('ollama.com')) {
    targetUrl = `${baseUrl}/api${path}`;
  } else {
    // Self-hosted: assume /api prefix
    targetUrl = `${baseUrl}/api${path}`;
  }

  const headers = {
    'Content-Type': 'application/json',
    'Host': new URL(targetUrl).host,
    'Origin': new URL(targetUrl).origin,
  };

  if (keyObj.key) {
    headers['Authorization'] = `Bearer ${keyObj.key}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || REQUEST_TIMEOUT);

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
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ============================================
// GET /v1/models
// ============================================
router.get('/v1/models', async (req, res) => {
  try {
    const keyObj = keyStore.getNextKey();
    if (!keyObj) {
      return res.status(503).json({ error: { message: 'No available API keys. Please add keys in the admin panel.', type: 'server_error' } });
    }

    const ollamaRes = await proxyToOllama(keyObj, '/tags', 'GET');

    if (!ollamaRes.ok) {
      keyStore.recordFailure(keyObj.id, `HTTP ${ollamaRes.status}`);
      const errText = await ollamaRes.text().catch(() => '');
      return res.status(ollamaRes.status).json({ error: { message: `Ollama API error: ${errText || ollamaRes.statusText}`, type: 'upstream_error' } });
    }

    keyStore.recordSuccess(keyObj.id);
    const data = await ollamaRes.json();
    return res.json(transformModelsResponse(data));
  } catch (e) {
    console.error('[/v1/models] Error:', e.message);
    return res.status(500).json({ error: { message: e.message, type: 'server_error' } });
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

    const keyObj = keyStore.getNextKey();
    if (!keyObj) {
      return res.status(503).json({ error: { message: 'No available API keys', type: 'server_error' } });
    }

    const ollamaReq = transformChatRequest(openaiReq);
    const isStream = ollamaReq.stream !== false;

    const ollamaRes = await proxyToOllama(keyObj, '/chat', 'POST', ollamaReq);

    if (!ollamaRes.ok) {
      keyStore.recordFailure(keyObj.id, `HTTP ${ollamaRes.status}`);
      const errText = await ollamaRes.text().catch(() => '');
      return res.status(ollamaRes.status).json({ error: { message: `Ollama error: ${errText || ollamaRes.statusText}`, type: 'upstream_error' } });
    }

    keyStore.recordSuccess(keyObj.id);

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
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    });

    // Handle client disconnect
    req.on('close', () => {
      reader.destroy();
    });

  } catch (e) {
    console.error('[/v1/chat/completions] Error:', e.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: { message: e.message, type: 'server_error' } });
    }
    res.end();
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

    const keyObj = keyStore.getNextKey();
    if (!keyObj) {
      return res.status(503).json({ error: { message: 'No available API keys', type: 'server_error' } });
    }

    const ollamaReq = transformCompletionsRequest(openaiReq);
    const isStream = ollamaReq.stream !== false;

    const ollamaRes = await proxyToOllama(keyObj, '/generate', 'POST', ollamaReq);

    if (!ollamaRes.ok) {
      keyStore.recordFailure(keyObj.id, `HTTP ${ollamaRes.status}`);
      const errText = await ollamaRes.text().catch(() => '');
      return res.status(ollamaRes.status).json({ error: { message: `Ollama error: ${errText}`, type: 'upstream_error' } });
    }

    keyStore.recordSuccess(keyObj.id);

    if (!isStream) {
      const data = await ollamaRes.json();
      return res.json(transformCompletionsResponse(data, openaiReq.model));
    }

    // Streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

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
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    });

    req.on('close', () => { reader.destroy(); });

  } catch (e) {
    console.error('[/v1/completions] Error:', e.message);
    if (!res.headersSent) return res.status(500).json({ error: { message: e.message, type: 'server_error' } });
    res.end();
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

    const keyObj = keyStore.getNextKey();
    if (!keyObj) {
      return res.status(503).json({ error: { message: 'No available API keys', type: 'server_error' } });
    }

    const ollamaReq = transformEmbeddingsRequest(openaiReq);
    const ollamaRes = await proxyToOllama(keyObj, '/embed', 'POST', ollamaReq);

    if (!ollamaRes.ok) {
      keyStore.recordFailure(keyObj.id, `HTTP ${ollamaRes.status}`);
      const errText = await ollamaRes.text().catch(() => '');
      return res.status(ollamaRes.status).json({ error: { message: `Ollama error: ${errText}`, type: 'upstream_error' } });
    }

    keyStore.recordSuccess(keyObj.id);
    const data = await ollamaRes.json();
    return res.json(transformEmbeddingsResponse(data, openaiReq.model));
  } catch (e) {
    console.error('[/v1/embeddings] Error:', e.message);
    return res.status(500).json({ error: { message: e.message, type: 'server_error' } });
  }
});

export default router;
