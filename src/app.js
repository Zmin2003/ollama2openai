/**
 * Ollama2OpenAI - Main Application
 * Converts Ollama API to OpenAI-compatible API format
 * with key management, round-robin load balancing, and admin panel
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import openaiRoutes from './routes/openai.js';
import adminRoutes from './routes/admin.js';
import keyStore from './core/keyStore.js';
import cacheManager from './core/cache.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

// ============================================
// Middleware
// ============================================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  const logLevel = process.env.LOG_LEVEL || 'info';

  res.on('finish', () => {
    const duration = Date.now() - start;
    if (logLevel === 'debug' || (logLevel === 'info' && !req.path.startsWith('/admin'))) {
      if (req.path.startsWith('/v1') || req.path.startsWith('/admin/api')) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      }
    }
  });

  next();
});

// ============================================
// API Token Auth (optional)
// ============================================
const API_TOKEN = process.env.API_TOKEN;

app.use('/v1', (req, res, next) => {
  if (!API_TOKEN) return next(); // No auth required

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: { message: 'Missing Authorization header', type: 'auth_error' } });
  }

  // BUG FIX: More robust Bearer token extraction
  // Handle both "Bearer <token>" and raw "<token>" formats
  let token;
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (authHeader.startsWith('bearer ')) {
    token = authHeader.substring(7).trim();
  } else {
    token = authHeader.trim();
  }

  if (token !== API_TOKEN) {
    return res.status(401).json({ error: { message: 'Invalid API token', type: 'auth_error' } });
  }

  next();
});

// ============================================
// Routes
// ============================================

// OpenAI-compatible API endpoints
app.use(openaiRoutes);

// Admin panel
app.use('/admin', adminRoutes);

// Root - info endpoint
app.get('/', (req, res) => {
  const summary = keyStore.getSummary();
  res.json({
    service: 'Ollama2OpenAI',
    version: '2.0.0',
    description: 'Ollama to OpenAI API proxy with key management',
    endpoints: {
      chat: '/v1/chat/completions',
      completions: '/v1/completions',
      models: '/v1/models',
      embeddings: '/v1/embeddings',
      admin: '/admin',
    },
    keys: summary,
  });
});

// Health endpoint
app.get('/health', (req, res) => {
  const summary = keyStore.getSummary();
  res.json({
    status: summary.healthy > 0 ? 'ok' : 'degraded',
    keys: summary,
    uptime: process.uptime(),
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.method} ${req.path} not found`,
      type: 'not_found',
      hint: 'Available: /v1/chat/completions, /v1/completions, /v1/models, /v1/embeddings, /admin'
    }
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({
    error: { message: 'Internal server error', type: 'server_error' }
  });
});

// ============================================
// Periodic health check
// ============================================
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '60') * 1000;

if (HEALTH_CHECK_INTERVAL > 0) {
  setInterval(async () => {
    const keys = keyStore.keys.filter(k => k.enabled);
    if (keys.length === 0) return;

    console.log(`[HealthCheck] Checking ${keys.length} keys...`);
    await keyStore.checkAllHealth();
    const summary = keyStore.getSummary();
    console.log(`[HealthCheck] Results: ${summary.healthy} healthy, ${summary.unhealthy} unhealthy`);
  }, HEALTH_CHECK_INTERVAL);
}

// ============================================
// Start server
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  const summary = keyStore.getSummary();
  const cacheStats = cacheManager.getStats();
  console.log('');
  console.log('=============================================');
  console.log('  Ollama2OpenAI v2.0.0');
  console.log('=============================================');
  console.log(`  Server:     http://0.0.0.0:${PORT}`);
  console.log(`  API Base:   http://localhost:${PORT}/v1`);
  console.log(`  Admin:      http://localhost:${PORT}/admin`);
  console.log(`  Keys:       ${summary.total} total, ${summary.healthy} healthy`);
  console.log(`  Auth:       ${API_TOKEN ? 'Enabled' : 'Disabled (set API_TOKEN in .env)'}`);
  console.log(`  HealthChk:  Every ${HEALTH_CHECK_INTERVAL / 1000}s`);
  console.log(`  Cache:      Embeddings=${cacheStats.enabled.embeddings}, Chat=${cacheStats.enabled.chat}`);
  console.log('=============================================');
  console.log('');
});
