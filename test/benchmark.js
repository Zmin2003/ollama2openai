/**
 * Performance Benchmark for Ollama2OpenAI
 * 
 * Tests:
 * 1. Transformer function throughput
 * 2. KeyStore operations under load
 * 3. HTTP endpoint latency (requires running server)
 * 
 * Run with: node test/benchmark.js [--server]
 *   --server: also run HTTP endpoint benchmarks (requires server at localhost:3000)
 */

import { performance } from 'perf_hooks';
import {
  generateChatId,
  generateToolCallId,
  transformChatRequest,
  transformChatResponse,
  transformStreamChunk,
  transformModelsResponse,
  transformCompletionsRequest,
  transformCompletionsResponse,
  transformEmbeddingsRequest,
  transformEmbeddingsResponse,
} from '../src/core/transformer.js';

const runServer = process.argv.includes('--server');
const SERVER_URL = process.env.BENCH_URL || 'http://localhost:3000';
const API_TOKEN = process.env.API_TOKEN || '';

// ============================================
// Benchmark utilities
// ============================================

function bench(name, fn, iterations = 10000) {
  // Warmup
  for (let i = 0; i < 100; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const opsPerSec = Math.round((iterations / elapsed) * 1000);
  const avgMs = (elapsed / iterations).toFixed(4);
  console.log(`  ${name.padEnd(45)} ${String(opsPerSec).padStart(10)} ops/s  ${avgMs} ms/op  (${iterations} iterations)`);
  return { name, opsPerSec, avgMs, iterations };
}

async function benchAsync(name, fn, iterations = 100) {
  // Warmup
  for (let i = 0; i < 5; i++) await fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsed = performance.now() - start;

  const opsPerSec = Math.round((iterations / elapsed) * 1000);
  const avgMs = (elapsed / iterations).toFixed(2);
  console.log(`  ${name.padEnd(45)} ${String(opsPerSec).padStart(10)} ops/s  ${avgMs} ms/op  (${iterations} iterations)`);
  return { name, opsPerSec, avgMs, iterations };
}

async function benchConcurrent(name, fn, totalRequests = 200, concurrency = 20) {
  // Warmup
  for (let i = 0; i < 3; i++) await fn();

  const start = performance.now();
  const latencies = [];
  let completed = 0;
  let errors = 0;

  // Run in batches of `concurrency`
  for (let batch = 0; batch < totalRequests; batch += concurrency) {
    const batchSize = Math.min(concurrency, totalRequests - batch);
    const promises = [];
    for (let i = 0; i < batchSize; i++) {
      const reqStart = performance.now();
      promises.push(
        fn()
          .then(() => {
            latencies.push(performance.now() - reqStart);
            completed++;
          })
          .catch(() => {
            latencies.push(performance.now() - reqStart);
            errors++;
          })
      );
    }
    await Promise.all(promises);
  }

  const elapsed = performance.now() - start;
  const rps = Math.round((totalRequests / elapsed) * 1000);

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)]?.toFixed(1) || '-';
  const p95 = latencies[Math.floor(latencies.length * 0.95)]?.toFixed(1) || '-';
  const p99 = latencies[Math.floor(latencies.length * 0.99)]?.toFixed(1) || '-';
  const avg = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1);

  console.log(`  ${name.padEnd(35)} ${String(rps).padStart(6)} rps  avg=${avg}ms  p50=${p50}ms  p95=${p95}ms  p99=${p99}ms  ok=${completed} err=${errors}`);
  return { name, rps, avg, p50, p95, p99, completed, errors };
}

// ============================================
// Test data generators
// ============================================

function makeSimpleChatRequest() {
  return {
    model: 'llama3',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the capital of France?' },
    ],
    temperature: 0.7,
    max_tokens: 100,
  };
}

function makeLargeChatRequest(messageCount = 50) {
  const messages = [{ role: 'system', content: 'You are a helpful assistant.' }];
  for (let i = 0; i < messageCount; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}: ${'Lorem ipsum dolor sit amet. '.repeat(10)}` });
  }
  return { model: 'llama3', messages, temperature: 0.7, max_tokens: 2000 };
}

function makeMultimodalChatRequest() {
  return {
    model: 'llava',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image in detail.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(1000) } },
      ]
    }],
  };
}

function makeToolsChatRequest() {
  return {
    model: 'llama3',
    messages: [{ role: 'user', content: 'What is the weather in NYC?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for a location',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
            unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
          },
          required: ['location']
        }
      }
    }],
  };
}

function makeOllamaChatResponse() {
  return {
    model: 'llama3',
    message: { role: 'assistant', content: 'The capital of France is Paris. It is known as the City of Light.' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 25,
    eval_count: 15,
  };
}

function makeOllamaStreamChunks(tokenCount = 20) {
  const chunks = [];
  const words = 'The capital of France is Paris It is known as the City of Light and is famous for the Eiffel Tower among other landmarks'.split(' ');
  for (let i = 0; i < tokenCount; i++) {
    chunks.push({
      model: 'llama3',
      message: { content: (words[i % words.length] || 'word') + ' ' },
      done: false,
    });
  }
  chunks.push({
    model: 'llama3',
    message: { content: '' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 25,
    eval_count: tokenCount,
  });
  return chunks;
}

function makeOllamaModelsResponse(count = 50) {
  return {
    models: Array.from({ length: count }, (_, i) => ({
      name: `model-${i}:latest`,
      model: `model-${i}:latest`,
      modified_at: new Date().toISOString(),
      size: 4000000000 + i * 100000000,
      digest: `sha256:${crypto.randomUUID().replace(/-/g, '')}`,
    }))
  };
}

// ============================================
// Run benchmarks
// ============================================

async function main() {
  console.log('');
  console.log('=============================================');
  console.log('  Ollama2OpenAI Performance Benchmark');
  console.log('=============================================');
  console.log('');

  // --- ID Generation ---
  console.log('--- ID Generation ---');
  bench('generateChatId', generateChatId, 100000);
  bench('generateToolCallId', generateToolCallId, 100000);

  // --- Request Transformation ---
  console.log('\n--- Request Transformation (OpenAI -> Ollama) ---');
  const simpleReq = makeSimpleChatRequest();
  bench('transformChatRequest (simple, 2 msgs)', () => transformChatRequest(simpleReq));

  const largeReq = makeLargeChatRequest(50);
  bench('transformChatRequest (large, 51 msgs)', () => transformChatRequest(largeReq), 5000);

  const mmReq = makeMultimodalChatRequest();
  bench('transformChatRequest (multimodal)', () => transformChatRequest(mmReq));

  const toolsReq = makeToolsChatRequest();
  bench('transformChatRequest (with tools)', () => transformChatRequest(toolsReq));

  const compReq = { model: 'llama3', prompt: 'Once upon a time', temperature: 0.7, max_tokens: 100 };
  bench('transformCompletionsRequest', () => transformCompletionsRequest(compReq));

  const embReq = { model: 'nomic-embed', input: ['hello', 'world', 'test'] };
  bench('transformEmbeddingsRequest', () => transformEmbeddingsRequest(embReq));

  // --- Response Transformation ---
  console.log('\n--- Response Transformation (Ollama -> OpenAI) ---');
  const chatRes = makeOllamaChatResponse();
  bench('transformChatResponse', () => transformChatResponse(chatRes, 'llama3', simpleReq.messages));

  const modelsRes = makeOllamaModelsResponse(50);
  bench('transformModelsResponse (50 models)', () => transformModelsResponse(modelsRes), 5000);

  const modelsResLarge = makeOllamaModelsResponse(200);
  bench('transformModelsResponse (200 models)', () => transformModelsResponse(modelsResLarge), 2000);

  const compRes = { model: 'llama3', response: 'there was a', done: true, prompt_eval_count: 5, eval_count: 4 };
  bench('transformCompletionsResponse', () => transformCompletionsResponse(compRes, 'llama3'));

  const embRes = { model: 'nomic-embed', embeddings: [Array.from({ length: 768 }, () => Math.random())] };
  bench('transformEmbeddingsResponse', () => transformEmbeddingsResponse(embRes, 'nomic-embed'));

  // --- Stream Chunk Transformation ---
  console.log('\n--- Stream Chunk Transformation ---');
  const chunks = makeOllamaStreamChunks(20);
  bench('transformStreamChunk (single)', () => {
    transformStreamChunk(chunks[0], 'chatcmpl-123', 1700000000, 'llama3', true, 0);
  });

  bench('transformStreamChunk (20-chunk stream)', () => {
    const chatId = 'chatcmpl-test';
    const created = Math.floor(Date.now() / 1000);
    for (let i = 0; i < chunks.length; i++) {
      transformStreamChunk(chunks[i], chatId, created, 'llama3', i === 0, i);
    }
  }, 5000);

  // --- KeyStore Operations (in-memory) ---
  console.log('\n--- KeyStore Operations (in-memory, no I/O) ---');

  // Import keyStore module dynamically to avoid file I/O conflicts
  const { default: keyStore } = await import('../src/core/keyStore.js');

  // Save original methods and monkey-patch to avoid actual file writes during benchmark
  const origSave = keyStore._save.bind(keyStore);
  const origSaveSync = keyStore._saveSync.bind(keyStore);
  const origSaveStats = keyStore._saveStats.bind(keyStore);
  keyStore._save = () => { keyStore._invalidateCache(); };
  keyStore._saveSync = () => { keyStore._invalidateCache(); };
  keyStore._saveStats = () => {};

  // Setup test keys
  const origKeys = [...keyStore.keys];
  keyStore.keys = [];
  for (let i = 0; i < 100; i++) {
    keyStore.keys.push({
      id: `bench-key-${i}`,
      key: `sk-benchmark-key-${i}`,
      baseUrl: 'https://ollama.com/api',
      name: `key-${i}`,
      enabled: i < 80, // 80% enabled
      healthy: i < 60,  // 60% healthy
      lastCheck: null,
      lastUsed: null,
      lastError: null,
      addedAt: new Date().toISOString(),
      totalRequests: 100,
      failedRequests: 10,
      tags: [],
    });
  }

  bench('getNextKey (100 keys, 60 healthy)', () => keyStore.getNextKey(), 50000);
  bench('getSummary (100 keys)', () => {
    keyStore._invalidateCache(); // Force recalculation
    keyStore.getSummary();
  }, 50000);
  bench('getSummary (100 keys, cached)', () => keyStore.getSummary(), 100000);

  bench('getAllKeys (100 keys)', () => {
    keyStore._invalidateCache();
    keyStore.getAllKeys();
  }, 10000);
  bench('getAllKeys (100 keys, cached)', () => keyStore.getAllKeys(), 100000);

  bench('recordSuccess', () => keyStore.recordSuccess('bench-key-0'), 50000);
  bench('recordFailure', () => keyStore.recordFailure('bench-key-0', 'test error'), 50000);

  bench('parseKeyString (bare key)', () => keyStore.parseKeyString('sk-test123456789012'), 50000);
  bench('parseKeyString (URL|key)', () => keyStore.parseKeyString('https://api.example.com|sk-test123456789012'), 50000);
  bench('parseKeyString (URL/key)', () => keyStore.parseKeyString('https://api.example.com/sk-test123456789012test'), 50000);

  // Restore
  keyStore.keys = origKeys;
  keyStore._save = origSave;
  keyStore._saveSync = origSaveSync;
  keyStore._saveStats = origSaveStats;

  // --- HTTP Benchmarks (optional) ---
  if (runServer) {
    console.log(`\n--- HTTP Endpoint Benchmarks (${SERVER_URL}) ---`);

    const headers = {
      'Content-Type': 'application/json',
    };
    if (API_TOKEN) {
      headers['Authorization'] = `Bearer ${API_TOKEN}`;
    }

    // Health endpoint
    await benchConcurrent(
      'GET /health',
      () => fetch(`${SERVER_URL}/health`).then(r => r.json()),
      500, 50
    );

    // Root endpoint
    await benchConcurrent(
      'GET /',
      () => fetch(`${SERVER_URL}/`).then(r => r.json()),
      500, 50
    );

    // Models endpoint (requires keys configured)
    try {
      const testRes = await fetch(`${SERVER_URL}/v1/models`, { headers });
      if (testRes.ok) {
        await benchConcurrent(
          'GET /v1/models',
          () => fetch(`${SERVER_URL}/v1/models`, { headers }).then(r => r.json()),
          200, 20
        );
      } else {
        console.log(`  GET /v1/models - Skipped (status ${testRes.status})`);
      }
    } catch (e) {
      console.log(`  GET /v1/models - Skipped (${e.message})`);
    }

    // Chat completions (non-streaming, requires keys + model)
    try {
      const chatBody = {
        model: 'llama3.2:1b',
        messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
        stream: false,
        max_tokens: 10,
        temperature: 0,
      };
      const testRes = await fetch(`${SERVER_URL}/v1/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(chatBody)
      });
      if (testRes.ok) {
        await benchConcurrent(
          'POST /v1/chat/completions (no stream)',
          () => fetch(`${SERVER_URL}/v1/chat/completions`, {
            method: 'POST', headers, body: JSON.stringify(chatBody)
          }).then(r => r.json()),
          50, 5
        );
      } else {
        const err = await testRes.text();
        console.log(`  POST /v1/chat/completions - Skipped (${testRes.status}: ${err.substring(0, 80)})`);
      }
    } catch (e) {
      console.log(`  POST /v1/chat/completions - Skipped (${e.message})`);
    }
  } else {
    console.log('\n--- HTTP Benchmarks skipped (use --server flag to enable) ---');
  }

  // --- Memory Usage ---
  console.log('\n--- Memory Usage ---');
  const mem = process.memoryUsage();
  console.log(`  RSS:         ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Heap Used:   ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Heap Total:  ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  External:    ${(mem.external / 1024 / 1024).toFixed(1)} MB`);

  console.log('\n=============================================');
  console.log('  Benchmark complete');
  console.log('=============================================\n');
}

main().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
