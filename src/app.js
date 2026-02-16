/**
 * Ollama2OpenAI v3.0 - Enterprise Edition
 * Converts Ollama API to OpenAI-compatible API format
 * Features: weighted LB, channel routing, multi-token auth, rate limiting,
 * IP access control, Prometheus metrics, structured logging, audit trail
 */

import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import openaiRoutes from './routes/openai.js';
import adminRoutes from './routes/admin.js';
import keyStore from './core/keyStore.js';
import channelManager from './core/channelManager.js';
import tokenManager from './core/tokenManager.js';
import cacheManager from './core/cache.js';
import rateLimiter from './core/rateLimiter.js';
import accessControl from './core/accessControl.js';
import metrics from './core/metrics.js';
import logger from './core/logger.js';

const VERSION = '3.0.0';
const app = express();
const PORT = parseInt(process.env.PORT || '3000');

// ============================================
// Middleware
// ============================================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Trust proxy for correct IP detection behind reverse proxy
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : (process.env.TRUST_PROXY || false));

// ============================================
// Request ID & Timing middleware
// ============================================
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID().substring(0, 8);
  req.startTime = Date.now();
  res.setHeader('X-Request-ID', req.requestId);

  res.on('finish', () => {
    const duration = Date.now() - req.startTime;
    const logLevel = process.env.LOG_LEVEL || 'info';
    if (logLevel === 'debug' || (logLevel === 'info' && !req.path.startsWith('/admin'))) {
      if (req.path.startsWith('/v1') || req.path.startsWith('/admin/api')) {
        logger.info('HTTP', `${req.method} ${req.path} ${res.statusCode} ${duration}ms`, { ip: req.ip });
      }
    }
  });

  next();
});

// ============================================
// IP Access Control middleware
// ============================================
app.use('/v1', (req, res, next) => {
  const clientIP = req.ip || req.connection?.remoteAddress || '';

  if (!accessControl.isAllowed(clientIP)) {
    logger.warn('AccessControl', `Blocked IP: ${clientIP}`);
    return res.status(403).json({
      error: { message: 'Access denied from your IP address', type: 'access_denied' }
    });
  }
  next();
});

// ============================================
// Rate Limiting middleware
// ============================================
app.use('/v1', (req, res, next) => {
  const clientIP = req.ip || '';
  const tokenId = req.tokenObj?.id || '';

  const result = rateLimiter.check(clientIP, tokenId);
  if (!result.allowed) {
    metrics.rateLimitHits.inc({ limit_type: result.limitType });
    logger.warn('RateLimit', `Rate limited: ${result.limitType} for ${clientIP}`, { tokenId });

    res.setHeader('X-RateLimit-Limit', result.limitType);
    res.setHeader('Retry-After', result.retryAfter || 60);

    return res.status(429).json({
      error: {
        message: `Rate limit exceeded (${result.limitType}). Try again in ${result.retryAfter}s.`,
        type: 'rate_limit_error',
      }
    });
  }

  next();
});

// ============================================
// API Token Auth (supports legacy single token + multi-token)
// ============================================
const API_TOKEN = process.env.API_TOKEN;

app.use('/v1', (req, res, next) => {
  // If no auth configured at all, skip
  if (!API_TOKEN && !tokenManager.isMultiTokenMode()) return next();

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: { message: 'Missing Authorization header', type: 'auth_error' } });
  }

  // Extract token
  let token;
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.substring(7).trim();
  } else {
    token = authHeader.trim();
  }

  // Multi-token mode: validate against token manager
  if (tokenManager.isMultiTokenMode()) {
    const result = tokenManager.validateToken(token);
    if (!result.valid) {
      // Fall through to legacy check
      if (API_TOKEN && token === API_TOKEN) {
        return next();
      }
      return res.status(401).json({ error: { message: result.error || 'Invalid API token', type: 'auth_error' } });
    }

    // Check IP restriction
    const clientIP = req.ip || '';
    if (!tokenManager.checkIPAccess(result.token, clientIP)) {
      return res.status(403).json({ error: { message: 'IP not allowed for this token', type: 'access_denied' } });
    }

    req.tokenObj = result.token;
    return next();
  }

  // Legacy single-token mode
  if (token !== API_TOKEN) {
    return res.status(401).json({ error: { message: 'Invalid API token', type: 'auth_error' } });
  }

  next();
});

// ============================================
// Active connections tracking
// ============================================
app.use('/v1', (req, res, next) => {
  metrics.activeConnections.inc();
  res.on('finish', () => metrics.activeConnections.dec());
  next();
});

// ============================================
// Routes
// ============================================
app.use(openaiRoutes);
app.use('/admin', adminRoutes);

// Root - info endpoint
app.get('/', (req, res) => {
  const keySummary = keyStore.getSummary();
  const channelSummary = channelManager.getSummary();
  const tokenSummary = tokenManager.getSummary();

  res.json({
    service: 'Ollama2OpenAI',
    version: VERSION,
    edition: 'Enterprise',
    description: 'Ollama to OpenAI API proxy with enterprise features',
    endpoints: {
      chat: '/v1/chat/completions',
      completions: '/v1/completions',
      models: '/v1/models',
      embeddings: '/v1/embeddings',
      admin: '/admin',
      metrics: '/metrics',
      health: '/health',
    },
    keys: keySummary,
    channels: channelSummary,
    tokens: tokenSummary,
  });
});

// Health endpoint
app.get('/health', (req, res) => {
  const keySummary = keyStore.getSummary();
  const channelSummary = channelManager.getSummary();
  const hasBackends = keySummary.healthy > 0 || channelSummary.healthy > 0;

  res.json({
    status: hasBackends ? 'ok' : (keySummary.total > 0 || channelSummary.total > 0 ? 'degraded' : 'no_backends'),
    version: VERSION,
    keys: keySummary,
    channels: channelSummary,
    uptime: process.uptime(),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    },
  });
});

// Prometheus metrics endpoint
app.get('/metrics', (req, res) => {
  // Update key metrics
  const keySummary = keyStore.getSummary();
  metrics.keysHealthy.set({}, keySummary.healthy);
  metrics.keysTotal.set({}, keySummary.total);

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metrics.toPrometheus());
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
  logger.error('Server', `${req.method} ${req.path}: ${err.message || err}`);
  if (!res.headersSent) {
    res.status(err.status || 500).json({
      error: { message: 'Internal server error', type: 'server_error' }
    });
  }
});

// ============================================
// Periodic health check
// ============================================
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '60') * 1000;

if (HEALTH_CHECK_INTERVAL > 0) {
  setInterval(async () => {
    // Check keys
    const keys = keyStore.keys.filter(k => k.enabled);
    if (keys.length > 0) {
      logger.info('HealthCheck', `Checking ${keys.length} keys...`);
      await keyStore.checkAllHealth();
      const summary = keyStore.getSummary();
      logger.info('HealthCheck', `Keys: ${summary.healthy} healthy, ${summary.unhealthy} unhealthy`);
    }

    // Check channels
    if (channelManager.isActive()) {
      logger.info('HealthCheck', 'Checking channels...');
      await channelManager.checkAllHealth();
      const chSummary = channelManager.getSummary();
      logger.info('HealthCheck', `Channels: ${chSummary.healthy} healthy`);
    }
  }, HEALTH_CHECK_INTERVAL);
}

// ============================================
// Start server
// ============================================
const server = app.listen(PORT, '0.0.0.0', () => {
  const keySummary = keyStore.getSummary();
  const channelSummary = channelManager.getSummary();
  const tokenSummary = tokenManager.getSummary();
  const cacheStats = cacheManager.getStats();

  console.log('');
  console.log('=============================================');
  console.log(`  Ollama2OpenAI v${VERSION} Enterprise`);
  console.log('=============================================');
  console.log(`  Server:     http://0.0.0.0:${PORT}`);
  console.log(`  API Base:   http://localhost:${PORT}/v1`);
  console.log(`  Admin:      http://localhost:${PORT}/admin`);
  console.log(`  Metrics:    http://localhost:${PORT}/metrics`);
  console.log('---------------------------------------------');
  console.log(`  Keys:       ${keySummary.total} total, ${keySummary.healthy} healthy`);
  console.log(`  Channels:   ${channelSummary.total} total, ${channelSummary.healthy} healthy`);
  console.log(`  Tokens:     ${tokenSummary.total} API tokens (${tokenSummary.enabled} active)`);
  console.log(`  Auth:       ${API_TOKEN ? 'Legacy' : ''}${tokenManager.isMultiTokenMode() ? ' Multi-Token' : ''}${!API_TOKEN && !tokenManager.isMultiTokenMode() ? 'Disabled' : ''}`);
  console.log(`  RateLimit:  Global=${rateLimiter.globalEnabled}, IP=${rateLimiter.ipEnabled}, Token=${rateLimiter.tokenEnabled}`);
  console.log(`  IPAccess:   ${accessControl.mode}`);
  console.log(`  HealthChk:  Every ${HEALTH_CHECK_INTERVAL / 1000}s`);
  console.log(`  Cache:      Embeddings=${cacheStats.enabled.embeddings}, Chat=${cacheStats.enabled.chat}`);
  console.log(`  Logging:    Level=${process.env.LOG_LEVEL || 'info'}, File=${process.env.LOG_TO_FILE === 'true'}`);
  console.log('=============================================');
  console.log('');
});

// ============================================
// Graceful shutdown
// ============================================
function gracefulShutdown(signal) {
  logger.info('Shutdown', `${signal} received, shutting down gracefully...`);
  keyStore.flushSync();
  channelManager.flushSync();
  tokenManager.flushSync();
  cacheManager.shutdown();
  rateLimiter.shutdown();
  logger.flushSync();

  server.close(() => {
    console.log('[Shutdown] Server closed.');
    process.exit(0);
  });

  setTimeout(() => {
    console.warn('[Shutdown] Forced exit after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
