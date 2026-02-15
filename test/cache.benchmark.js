/**
 * Cache Performance Benchmark
 * Tests the effectiveness of caching for embeddings and chat completions
 */

import http from 'http';

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const API_TOKEN = process.env.API_TOKEN || '';

// Test configuration
const WARMUP_ITERATIONS = 3;
const TEST_ITERATIONS = 10;

// Helper: Make HTTP request
function makeRequest(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const data = JSON.stringify(body);
    
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    
    if (API_TOKEN) {
      options.headers['Authorization'] = `Bearer ${API_TOKEN}`;
    }
    
    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: JSON.parse(responseData),
            headers: res.headers,
          });
        } catch (e) {
          resolve({ status: res.statusCode, data: responseData, headers: res.headers });
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.write(data);
    req.end();
  });
}

// Helper: Measure execution time
async function measureTime(name, fn, iterations) {
  const times = [];
  const results = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    const result = await fn();
    const end = process.hrtime.bigint();
    const timeMs = Number(end - start) / 1_000_000;
    times.push(timeMs);
    results.push(result);
  }
  
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  
  // Check cache hit indicator
  const cacheHits = results.filter(r => r.data?.cached === true).length;
  
  return { name, avg, min, max, times, cacheHits, iterations };
}

// Test embeddings cache
async function testEmbeddingsCache() {
  console.log('\n========================================');
  console.log('  Embeddings Cache Benchmark');
  console.log('========================================\n');
  
  const testInput = 'This is a test sentence for embedding cache benchmark.';
  
  // Warmup (populate cache)
  console.log('Warming up cache...');
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    try {
      await makeRequest('/v1/embeddings', {
        model: 'nomic-embed-text',
        input: testInput,
      });
    } catch (e) {
      console.log(`  Warmup ${i + 1} failed: ${e.message}`);
    }
  }
  
  // Test with cache (should hit)
  console.log('\nTesting with cache (same input)...');
  const cachedResult = await measureTime(
    'Embeddings (cached)',
    () => makeRequest('/v1/embeddings', {
      model: 'nomic-embed-text',
      input: testInput,
    }),
    TEST_ITERATIONS
  );
  
  // Test without cache (different inputs)
  console.log('Testing without cache (different inputs)...');
  const uncachedResult = await measureTime(
    'Embeddings (uncached)',
    () => makeRequest('/v1/embeddings', {
      model: 'nomic-embed-text',
      input: `Random input ${Date.now()} ${Math.random()}`,
    }),
    TEST_ITERATIONS
  );
  
  // Results
  console.log('\n--- Results ---\n');
  console.log(`Cached requests:`);
  console.log(`  Average: ${cachedResult.avg.toFixed(2)}ms`);
  console.log(`  Min: ${cachedResult.min.toFixed(2)}ms`);
  console.log(`  Max: ${cachedResult.max.toFixed(2)}ms`);
  console.log(`  Cache hits: ${cachedResult.cacheHits}/${cachedResult.iterations}`);
  
  console.log(`\nUncached requests:`);
  console.log(`  Average: ${uncachedResult.avg.toFixed(2)}ms`);
  console.log(`  Min: ${uncachedResult.min.toFixed(2)}ms`);
  console.log(`  Max: ${uncachedResult.max.toFixed(2)}ms`);
  
  if (cachedResult.avg < uncachedResult.avg) {
    const speedup = (uncachedResult.avg / cachedResult.avg).toFixed(2);
    console.log(`\n✅ Cache is ${speedup}x faster!`);
  } else {
    console.log(`\n⚠️  Cache hit rate may be low. Check if backend supports the model.`);
  }
  
  return { cachedResult, uncachedResult };
}

// Test chat cache
async function testChatCache() {
  console.log('\n========================================');
  console.log('  Chat Completions Cache Benchmark');
  console.log('  (Note: Chat cache is disabled by default)');
  console.log('========================================\n');
  
  const testMessage = 'Say "hello" and nothing else.';
  
  // Warmup
  console.log('Warming up cache...');
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    try {
      await makeRequest('/v1/chat/completions', {
        model: 'llama3.2',
        messages: [{ role: 'user', content: testMessage }],
        stream: false,
      });
    } catch (e) {
      console.log(`  Warmup ${i + 1} failed: ${e.message}`);
    }
  }
  
  // Test with same input
  console.log('\nTesting with same input...');
  const cachedResult = await measureTime(
    'Chat (same input)',
    () => makeRequest('/v1/chat/completions', {
      model: 'llama3.2',
      messages: [{ role: 'user', content: testMessage }],
      stream: false,
    }),
    TEST_ITERATIONS
  );
  
  // Results
  console.log('\n--- Results ---\n');
  console.log(`Chat requests (same input):`);
  console.log(`  Average: ${cachedResult.avg.toFixed(2)}ms`);
  console.log(`  Min: ${cachedResult.min.toFixed(2)}ms`);
  console.log(`  Max: ${cachedResult.max.toFixed(2)}ms`);
  console.log(`  Cache hits: ${cachedResult.cacheHits}/${cachedResult.iterations}`);
  
  if (cachedResult.cacheHits > 0) {
    console.log(`\n✅ Chat cache is working!`);
  } else {
    console.log(`\nℹ️  Chat cache is disabled by default. Enable with CACHE_CHAT=true`);
  }
  
  return { cachedResult };
}

// Test cache stats endpoint
async function testCacheStats() {
  console.log('\n========================================');
  console.log('  Cache Stats');
  console.log('========================================\n');
  
  try {
    const url = new URL('/admin/api/cache', BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'GET',
      headers: {},
    };
    
    if (API_TOKEN) {
      options.headers['Authorization'] = `Bearer ${API_TOKEN}`;
    }
    
    const result = await new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
    
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    console.log(`Failed to get cache stats: ${e.message}`);
    return null;
  }
}

// Main
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Ollama2OpenAI Cache Benchmark           ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\nTarget: ${BASE_URL}`);
  console.log(`Iterations per test: ${TEST_ITERATIONS}`);
  
  // Check if server is running
  try {
    await makeRequest('/v1', {});
    console.log('Server is running!\n');
  } catch (e) {
    console.log(`\n❌ Cannot connect to server: ${e.message}`);
    console.log('Make sure the server is running: npm start');
    process.exit(1);
  }
  
  // Run benchmarks
  await testEmbeddingsCache();
  await testChatCache();
  await testCacheStats();
  
  console.log('\n========================================');
  console.log('  Benchmark Complete');
  console.log('========================================\n');
}

main().catch(console.error);