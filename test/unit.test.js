/**
 * Unit tests for Ollama2OpenAI
 * Run with: node test/unit.test.js
 * No external test framework required - uses Node.js built-in assert
 */
import { strict as assert } from 'assert';
import {
  generateChatId,
  generateToolCallId,
  transformChatRequest,
  transformCompletionsRequest,
  transformEmbeddingsRequest,
  transformModelsResponse,
  transformChatResponse,
  transformCompletionsResponse,
  transformEmbeddingsResponse,
  transformStreamChunk,
} from '../src/core/transformer.js';

let passed = 0;
let failed = 0;
const errors = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    errors.push({ name, error: e });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

// ============================================
// ID Generation
// ============================================
section('ID Generation');

test('generateChatId returns chatcmpl- prefix', () => {
  const id = generateChatId();
  assert.ok(id.startsWith('chatcmpl-'));
  assert.ok(id.length > 10);
});

test('generateChatId generates unique IDs', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(generateChatId());
  assert.equal(ids.size, 100);
});

test('generateToolCallId returns call_ prefix', () => {
  const id = generateToolCallId();
  assert.ok(id.startsWith('call_'));
  assert.equal(id.length, 29); // 'call_' + 24 chars
});

// ============================================
// transformChatRequest
// ============================================
section('transformChatRequest');

test('basic chat request transformation', () => {
  const req = {
    model: 'llama3',
    messages: [{ role: 'user', content: 'Hello' }],
  };
  const result = transformChatRequest(req);
  assert.equal(result.model, 'llama3');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[0].content, 'Hello');
  assert.equal(result.stream, true); // default to stream
});

test('stream=false is preserved', () => {
  const req = { model: 'llama3', messages: [], stream: false };
  const result = transformChatRequest(req);
  assert.equal(result.stream, false);
});

test('multimodal content with images', () => {
  const req = {
    model: 'llava',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ]
    }],
  };
  const result = transformChatRequest(req);
  assert.equal(result.messages[0].content, 'What is this?');
  assert.deepEqual(result.messages[0].images, ['iVBORw0KGgo=']);
});

test('options mapping - temperature, top_p, max_tokens', () => {
  const req = {
    model: 'llama3',
    messages: [],
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 100,
    seed: 42,
  };
  const result = transformChatRequest(req);
  assert.equal(result.options.temperature, 0.7);
  assert.equal(result.options.top_p, 0.9);
  assert.equal(result.options.num_predict, 100);
  assert.equal(result.options.seed, 42);
});

test('max_completion_tokens overrides max_tokens', () => {
  const req = { model: 'llama3', messages: [], max_tokens: 100, max_completion_tokens: 200 };
  const result = transformChatRequest(req);
  assert.equal(result.options.num_predict, 200);
});

test('response_format json_object', () => {
  const req = { model: 'llama3', messages: [], response_format: { type: 'json_object' } };
  const result = transformChatRequest(req);
  assert.equal(result.format, 'json');
});

test('response_format json_schema', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } } };
  const req = {
    model: 'llama3', messages: [],
    response_format: { type: 'json_schema', json_schema: { schema } }
  };
  const result = transformChatRequest(req);
  assert.deepEqual(result.format, schema);
});

test('think mode pass-through', () => {
  const req = { model: 'deepseek-r1', messages: [], think: true };
  const result = transformChatRequest(req);
  assert.equal(result.think, true);
});

test('tool_calls in assistant messages', () => {
  const req = {
    model: 'llama3', messages: [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_123',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city": "NYC"}' }
      }]
    }]
  };
  const result = transformChatRequest(req);
  assert.equal(result.messages[0].tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(result.messages[0].tool_calls[0].function.arguments, { city: 'NYC' });
});

test('tool response messages', () => {
  const req = {
    model: 'llama3', messages: [{
      role: 'tool',
      content: '{"temp": 72}',
      tool_call_id: 'call_123'
    }]
  };
  const result = transformChatRequest(req);
  assert.equal(result.messages[0].role, 'tool');
  assert.equal(result.messages[0].content, '{"temp": 72}');
  assert.equal(result.messages[0].tool_call_id, 'call_123');
});

test('tools definitions are passed through', () => {
  const req = {
    model: 'llama3', messages: [],
    tools: [{
      type: 'function',
      function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }
    }]
  };
  const result = transformChatRequest(req);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].function.name, 'get_weather');
});

test('null/undefined content handled gracefully', () => {
  const req = { model: 'llama3', messages: [{ role: 'assistant', content: null }] };
  const result = transformChatRequest(req);
  assert.equal(result.messages[0].content, '');
});

test('non-string content is converted to string', () => {
  const req = { model: 'llama3', messages: [{ role: 'user', content: 42 }] };
  const result = transformChatRequest(req);
  assert.equal(result.messages[0].content, '42');
});

// ============================================
// transformCompletionsRequest
// ============================================
section('transformCompletionsRequest');

test('basic completions request', () => {
  const req = { model: 'llama3', prompt: 'Once upon a time' };
  const result = transformCompletionsRequest(req);
  assert.equal(result.model, 'llama3');
  assert.equal(result.prompt, 'Once upon a time');
  assert.equal(result.stream, true);
});

test('completions with suffix', () => {
  const req = { model: 'llama3', prompt: 'Hello', suffix: 'world' };
  const result = transformCompletionsRequest(req);
  assert.equal(result.suffix, 'world');
});

// ============================================
// transformEmbeddingsRequest
// ============================================
section('transformEmbeddingsRequest');

test('string input is wrapped in array', () => {
  const req = { model: 'nomic-embed', input: 'hello' };
  const result = transformEmbeddingsRequest(req);
  assert.deepEqual(result.input, ['hello']);
});

test('array input is preserved', () => {
  const req = { model: 'nomic-embed', input: ['hello', 'world'] };
  const result = transformEmbeddingsRequest(req);
  assert.deepEqual(result.input, ['hello', 'world']);
});

// ============================================
// transformModelsResponse
// ============================================
section('transformModelsResponse');

test('basic models response', () => {
  const ollamaData = {
    models: [{ name: 'llama3:latest', modified_at: '2024-01-01T00:00:00Z' }]
  };
  const result = transformModelsResponse(ollamaData);
  assert.equal(result.object, 'list');
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].id, 'llama3:latest');
  assert.equal(result.data[0].object, 'model');
  assert.equal(result.data[0].owned_by, 'ollama');
});

test('empty/null models handled', () => {
  assert.deepEqual(transformModelsResponse(null), { object: 'list', data: [] });
  assert.deepEqual(transformModelsResponse({}), { object: 'list', data: [] });
  assert.deepEqual(transformModelsResponse({ models: [] }), { object: 'list', data: [] });
});

// ============================================
// transformChatResponse
// ============================================
section('transformChatResponse');

test('basic chat response', () => {
  const ollamaRes = {
    model: 'llama3',
    message: { role: 'assistant', content: 'Hello!' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 10,
    eval_count: 5,
  };
  const result = transformChatResponse(ollamaRes, 'llama3', []);
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.choices[0].message.content, 'Hello!');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(result.usage.completion_tokens, 5);
  assert.equal(result.usage.total_tokens, 15);
});

test('chat response with tool calls', () => {
  const ollamaRes = {
    model: 'llama3',
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        function: { name: 'get_weather', arguments: { city: 'NYC' } }
      }]
    },
    done: true,
  };
  const result = transformChatResponse(ollamaRes, 'llama3', []);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'get_weather');
  assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"city":"NYC"}');
});

test('chat response with thinking content', () => {
  const ollamaRes = {
    model: 'deepseek-r1',
    message: { role: 'assistant', content: 'Answer', thinking: 'Let me think...' },
    done: true,
  };
  const result = transformChatResponse(ollamaRes, 'deepseek-r1', []);
  assert.equal(result.choices[0].message.reasoning_content, 'Let me think...');
});

test('token estimation when counts not provided', () => {
  const ollamaRes = {
    model: 'llama3',
    message: { role: 'assistant', content: 'Short reply' },
    done: true,
  };
  const msgs = [{ role: 'user', content: 'Hello world test prompt' }];
  const result = transformChatResponse(ollamaRes, 'llama3', msgs);
  assert.ok(result.usage.prompt_tokens > 0);
  assert.ok(result.usage.completion_tokens > 0);
});

// ============================================
// transformStreamChunk
// ============================================
section('transformStreamChunk');

test('first chunk includes role', () => {
  const chunk = { message: { content: 'Hi' }, done: false };
  const result = transformStreamChunk(chunk, 'chatcmpl-123', 1700000000, 'llama3', true);
  assert.equal(result.choices[0].delta.role, 'assistant');
  assert.equal(result.choices[0].delta.content, 'Hi');
  assert.equal(result.choices[0].finish_reason, null);
});

test('non-first chunk excludes role', () => {
  const chunk = { message: { content: ' world' }, done: false };
  const result = transformStreamChunk(chunk, 'chatcmpl-123', 1700000000, 'llama3', false);
  assert.equal(result.choices[0].delta.role, undefined);
  assert.equal(result.choices[0].delta.content, ' world');
});

test('done chunk includes finish_reason and usage', () => {
  const chunk = {
    message: { content: '' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 10,
    eval_count: 20,
  };
  const result = transformStreamChunk(chunk, 'chatcmpl-123', 1700000000, 'llama3', false);
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(result.usage.completion_tokens, 20);
  assert.equal(result.usage.total_tokens, 30);
});

test('thinking content in stream', () => {
  const chunk = { message: { content: '', thinking: 'reasoning...' }, done: false };
  const result = transformStreamChunk(chunk, 'chatcmpl-123', 1700000000, 'deepseek-r1', false);
  assert.equal(result.choices[0].delta.reasoning_content, 'reasoning...');
});

// ============================================
// transformCompletionsResponse
// ============================================
section('transformCompletionsResponse');

test('basic completions response', () => {
  const ollamaRes = {
    model: 'llama3',
    response: ' there was a',
    done: true,
    prompt_eval_count: 5,
    eval_count: 4,
  };
  const result = transformCompletionsResponse(ollamaRes, 'llama3');
  assert.equal(result.object, 'text_completion');
  assert.equal(result.choices[0].text, ' there was a');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.usage.total_tokens, 9);
});

// ============================================
// transformEmbeddingsResponse (BUG FIX validation)
// ============================================
section('transformEmbeddingsResponse (BUG FIX)');

test('handles embeddings array (plural)', () => {
  const ollamaRes = {
    model: 'nomic-embed',
    embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
  };
  const result = transformEmbeddingsResponse(ollamaRes, 'nomic-embed');
  assert.equal(result.data.length, 2);
  assert.deepEqual(result.data[0].embedding, [0.1, 0.2, 0.3]);
  assert.deepEqual(result.data[1].embedding, [0.4, 0.5, 0.6]);
});

test('handles single embedding (singular)', () => {
  const ollamaRes = {
    model: 'nomic-embed',
    embedding: [0.1, 0.2, 0.3],
  };
  const result = transformEmbeddingsResponse(ollamaRes, 'nomic-embed');
  assert.equal(result.data.length, 1);
  assert.deepEqual(result.data[0].embedding, [0.1, 0.2, 0.3]);
});

test('handles missing embeddings gracefully (BUG FIX)', () => {
  const ollamaRes = { model: 'nomic-embed' };
  const result = transformEmbeddingsResponse(ollamaRes, 'nomic-embed');
  // BUG FIX: previously this would produce [undefined] due to `[ollamaRes.embedding] || []`
  assert.equal(result.data.length, 0);
});

test('handles empty embeddings array', () => {
  const ollamaRes = { model: 'nomic-embed', embeddings: [] };
  const result = transformEmbeddingsResponse(ollamaRes, 'nomic-embed');
  assert.equal(result.data.length, 0);
});

// ============================================
// Edge cases
// ============================================
section('Edge Cases');

test('empty messages array', () => {
  const req = { model: 'llama3', messages: [] };
  const result = transformChatRequest(req);
  assert.equal(result.messages.length, 0);
});

test('missing messages property', () => {
  const req = { model: 'llama3' };
  const result = transformChatRequest(req);
  assert.equal(result.messages.length, 0);
});

test('tool_calls with non-string arguments', () => {
  const req = {
    model: 'llama3', messages: [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        function: { name: 'test', arguments: { key: 'value' } }
      }]
    }]
  };
  const result = transformChatRequest(req);
  // Object arguments should be kept as-is (already parsed)
  assert.deepEqual(result.messages[0].tool_calls[0].function.arguments, { key: 'value' });
});

// ============================================
// Summary
// ============================================
console.log(`\n=============================================`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`=============================================\n`);

if (failed > 0) {
  console.log('Failed tests:');
  for (const { name, error } of errors) {
    console.log(`  - ${name}: ${error.message}`);
  }
  process.exit(1);
}
