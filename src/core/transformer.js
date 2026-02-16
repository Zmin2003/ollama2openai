/**
 * Transform OpenAI format request/response <-> Ollama format
 */

/**
 * Generate a unique chat completion ID
 */
export function generateChatId() {
  return 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').substring(0, 24);
}

/**
 * Generate a tool call ID
 */
export function generateToolCallId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'call_';
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ============================================
// REQUEST: OpenAI -> Ollama
// ============================================

/**
 * Transform OpenAI chat completion request to Ollama /api/chat format
 */
export function transformChatRequest(openaiReq) {
  const ollamaReq = {
    model: openaiReq.model,
    messages: [],
    stream: openaiReq.stream !== false,
  };

  // Transform messages
  if (openaiReq.messages && Array.isArray(openaiReq.messages)) {
    ollamaReq.messages = openaiReq.messages.map(msg => {
      const ollamaMsg = { role: msg.role, content: '' };

      // Handle content (string or multimodal array)
      if (typeof msg.content === 'string') {
        ollamaMsg.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        const images = [];

        for (const part of msg.content) {
          if (part.type === 'text') {
            textParts.push(part.text);
          } else if (part.type === 'image_url') {
            let imageData = part.image_url?.url || '';
            if (imageData.startsWith('data:image/')) {
              const m = imageData.match(/^data:image\/[^;]+;base64,(.+)$/);
              if (m) imageData = m[1];
            }
            images.push(imageData);
          }
        }

        ollamaMsg.content = textParts.join('\n');
        if (images.length > 0) ollamaMsg.images = images;
      } else if (msg.content !== null && msg.content !== undefined) {
        ollamaMsg.content = String(msg.content);
      }

      // Handle tool_calls (assistant messages)
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        ollamaMsg.tool_calls = msg.tool_calls.map(tc => {
          let args = tc.function?.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
          }
          return {
            function: {
              name: tc.function?.name,
              arguments: args
            }
          };
        });
      }

      // Handle tool response messages
      if (msg.role === 'tool') {
        ollamaMsg.content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (msg.tool_call_id) ollamaMsg.tool_call_id = msg.tool_call_id;
      }

      return ollamaMsg;
    });
  }

  // Transform tools
  if (openaiReq.tools && Array.isArray(openaiReq.tools)) {
    ollamaReq.tools = openaiReq.tools.map(tool => ({
      type: tool.type || 'function',
      function: {
        name: tool.function?.name,
        description: tool.function?.description,
        parameters: tool.function?.parameters
      }
    }));
  }

  // Options mapping
  const options = {};
  if (openaiReq.temperature !== undefined) options.temperature = openaiReq.temperature;
  if (openaiReq.top_p !== undefined) options.top_p = openaiReq.top_p;
  if (openaiReq.max_tokens !== undefined) options.num_predict = openaiReq.max_tokens;
  if (openaiReq.max_completion_tokens !== undefined) options.num_predict = openaiReq.max_completion_tokens;
  if (openaiReq.frequency_penalty !== undefined) options.frequency_penalty = openaiReq.frequency_penalty;
  if (openaiReq.presence_penalty !== undefined) options.presence_penalty = openaiReq.presence_penalty;
  if (openaiReq.seed !== undefined) options.seed = openaiReq.seed;
  if (openaiReq.stop !== undefined) options.stop = openaiReq.stop;
  if (openaiReq.num_ctx !== undefined) options.num_ctx = openaiReq.num_ctx;
  if (openaiReq.top_k !== undefined) options.top_k = openaiReq.top_k;
  if (openaiReq.repeat_penalty !== undefined) options.repeat_penalty = openaiReq.repeat_penalty;

  if (Object.keys(options).length > 0) ollamaReq.options = options;

  // Format (JSON mode / structured outputs)
  if (openaiReq.response_format) {
    if (openaiReq.response_format.type === 'json_object') {
      ollamaReq.format = 'json';
    } else if (openaiReq.response_format.type === 'json_schema' && openaiReq.response_format.json_schema?.schema) {
      ollamaReq.format = openaiReq.response_format.json_schema.schema;
    }
  }

  // Think mode (for reasoning models like deepseek-r1)
  if (openaiReq.think !== undefined) ollamaReq.think = openaiReq.think;

  // Keep alive
  if (openaiReq.keep_alive !== undefined) ollamaReq.keep_alive = openaiReq.keep_alive;

  return ollamaReq;
}

/**
 * Transform OpenAI completions request to Ollama /api/generate format
 */
export function transformCompletionsRequest(openaiReq) {
  const ollamaReq = {
    model: openaiReq.model,
    prompt: openaiReq.prompt || '',
    stream: openaiReq.stream !== false,
  };

  if (openaiReq.suffix) ollamaReq.suffix = openaiReq.suffix;

  const options = {};
  if (openaiReq.temperature !== undefined) options.temperature = openaiReq.temperature;
  if (openaiReq.top_p !== undefined) options.top_p = openaiReq.top_p;
  if (openaiReq.max_tokens !== undefined) options.num_predict = openaiReq.max_tokens;
  if (openaiReq.frequency_penalty !== undefined) options.frequency_penalty = openaiReq.frequency_penalty;
  if (openaiReq.presence_penalty !== undefined) options.presence_penalty = openaiReq.presence_penalty;
  if (openaiReq.seed !== undefined) options.seed = openaiReq.seed;
  if (openaiReq.stop !== undefined) options.stop = openaiReq.stop;

  if (Object.keys(options).length > 0) ollamaReq.options = options;

  return ollamaReq;
}

/**
 * Transform OpenAI embeddings request to Ollama /api/embed format
 */
export function transformEmbeddingsRequest(openaiReq) {
  let input = openaiReq.input;
  if (typeof input === 'string') input = [input];

  return {
    model: openaiReq.model,
    input: input
  };
}

// ============================================
// RESPONSE: Ollama -> OpenAI
// ============================================

/**
 * Transform Ollama models list to OpenAI format
 */
export function transformModelsResponse(ollamaData) {
  if (!ollamaData?.models || !Array.isArray(ollamaData.models)) {
    return { object: 'list', data: [] };
  }

  return {
    object: 'list',
    data: ollamaData.models.map(m => ({
      id: m.name || m.model,
      object: 'model',
      created: m.modified_at ? Math.floor(new Date(m.modified_at).getTime() / 1000) : Math.floor(Date.now() / 1000),
      owned_by: 'ollama',
      permission: [],
      root: m.name || m.model,
      parent: null,
    }))
  };
}

/**
 * Estimate token count from text
 * Uses a heuristic that accounts for mixed CJK/English content:
 * - CJK characters: ~1-2 chars per token (we use 1.5)
 * - English/Latin: ~4 chars per token
 */
function estimateTokens(text) {
  if (!text) return 0;

  // Count CJK characters (Chinese, Japanese, Korean)
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherCount = text.length - cjkCount;

  // CJK: ~1.5 chars/token, Other: ~4 chars/token
  return Math.ceil(cjkCount / 1.5 + otherCount / 4);
}

/**
 * Transform Ollama non-streaming chat response to OpenAI format
 */
export function transformChatResponse(ollamaRes, model, requestMessages) {
  const chatId = generateChatId();
  const message = ollamaRes.message || {};
  const content = message.content || '';

  // Estimate tokens if not provided by Ollama (cloud API doesn't return these)
  const promptTokens = ollamaRes.prompt_eval_count || estimateTokens(
    requestMessages ? requestMessages.map(m => typeof m.content === 'string' ? m.content : '').join(' ') : ''
  );
  const completionTokens = ollamaRes.eval_count || estimateTokens(content);

  const openaiRes = {
    id: chatId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: ollamaRes.model || model,
    choices: [{
      index: 0,
      message: {
        role: message.role || 'assistant',
        content,
      },
      finish_reason: mapFinishReason(ollamaRes.done_reason, message.tool_calls),
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    system_fingerprint: `fp_ollama_${(ollamaRes.model || '').replace(/[^a-z0-9]/g, '')}`,
  };

  // Tool calls
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    openaiRes.choices[0].message.tool_calls = message.tool_calls.map((tc, idx) => ({
      id: generateToolCallId(),
      type: 'function',
      index: idx,
      function: {
        name: tc.function?.name || '',
        arguments: typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments || {})
      }
    }));
    openaiRes.choices[0].finish_reason = 'tool_calls';
  }

  // Thinking content
  if (message.thinking) {
    openaiRes.choices[0].message.reasoning_content = message.thinking;
  }

  return openaiRes;
}

/**
 * Transform a single Ollama streaming chunk to OpenAI SSE chunk
 * tokenCount: accumulated token count for estimation when Ollama doesn't provide counts
 */
export function transformStreamChunk(ollamaChunk, chatId, created, model, isFirstChunk, tokenCount = 0) {
  const message = ollamaChunk.message || {};
  const content = message.content || '';
  const thinking = message.thinking || '';
  const toolCalls = message.tool_calls || null;
  const isDone = ollamaChunk.done || false;
  const doneReason = ollamaChunk.done_reason || null;

  const chunk = {
    id: chatId,
    object: 'chat.completion.chunk',
    created,
    model: ollamaChunk.model || model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: null,
    }],
  };

  // First chunk: send role
  if (isFirstChunk) {
    chunk.choices[0].delta.role = 'assistant';
  }

  // Text content
  if (content) {
    chunk.choices[0].delta.content = content;
  }

  // Thinking content (for reasoning models)
  if (thinking) {
    chunk.choices[0].delta.reasoning_content = thinking;
  }

  // Tool calls
  if (toolCalls && Array.isArray(toolCalls)) {
    chunk.choices[0].delta.tool_calls = toolCalls.map((tc, idx) => ({
      index: idx,
      id: generateToolCallId(),
      type: 'function',
      function: {
        name: tc.function?.name || '',
        arguments: typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments || {})
      }
    }));
  }

  // Done
  if (isDone) {
    chunk.choices[0].finish_reason = mapFinishReason(doneReason, toolCalls);

    // Include usage in final chunk
    // BUG FIX: tokenCount tracks content chunks (completion side only),
    // so it should NOT be used as fallback for prompt_tokens
    const promptTokens = ollamaChunk.prompt_eval_count || 0;
    const completionTokens = ollamaChunk.eval_count || tokenCount;
    chunk.usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  }

  return chunk;
}

/**
 * Transform Ollama generate (non-streaming) response to OpenAI completions format
 */
export function transformCompletionsResponse(ollamaRes, model) {
  return {
    id: generateChatId(),
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: ollamaRes.model || model,
    choices: [{
      index: 0,
      text: ollamaRes.response || '',
      finish_reason: ollamaRes.done ? 'stop' : 'length',
    }],
    usage: {
      prompt_tokens: ollamaRes.prompt_eval_count || 0,
      completion_tokens: ollamaRes.eval_count || 0,
      total_tokens: (ollamaRes.prompt_eval_count || 0) + (ollamaRes.eval_count || 0),
    }
  };
}

/**
 * Transform Ollama embed response to OpenAI embeddings format
 */
export function transformEmbeddingsResponse(ollamaRes, model) {
  // BUG FIX: The original `ollamaRes.embeddings || [ollamaRes.embedding] || []`
  // would create [undefined] when both are missing, because [undefined] is truthy.
  // Correct logic: use embeddings array if present, otherwise wrap single embedding if present.
  let embeddings;
  if (Array.isArray(ollamaRes.embeddings) && ollamaRes.embeddings.length > 0) {
    embeddings = ollamaRes.embeddings;
  } else if (ollamaRes.embedding) {
    embeddings = [ollamaRes.embedding];
  } else {
    embeddings = [];
  }

  return {
    object: 'list',
    data: embeddings.map((emb, idx) => ({
      object: 'embedding',
      index: idx,
      embedding: emb || [],
    })),
    model: ollamaRes.model || model,
    usage: {
      prompt_tokens: ollamaRes.prompt_eval_count || 0,
      total_tokens: ollamaRes.prompt_eval_count || 0,
    }
  };
}

/**
 * Map Ollama done_reason to OpenAI finish_reason
 */
function mapFinishReason(doneReason, toolCalls) {
  if (toolCalls && toolCalls.length > 0) return 'tool_calls';
  switch (doneReason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'load': return 'stop';
    case 'unload': return 'stop';
    default: return 'stop';
  }
}
