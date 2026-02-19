/**
 * Admin API routes - Enterprise Edition
 * Key management, token management, channel management, health checks,
 * logs viewer, settings, audit trail, monitoring
 */
import { Router } from 'express';
import { createHmac } from 'crypto';
import keyStore from '../core/keyStore.js';
import channelManager from '../core/channelManager.js';
import tokenManager from '../core/tokenManager.js';
import cacheManager from '../core/cache.js';
import rateLimiter from '../core/rateLimiter.js';
import accessControl from '../core/accessControl.js';
import metrics from '../core/metrics.js';
import logger from '../core/logger.js';

const router = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function generateSessionToken() {
  return createHmac('sha256', 'ollama2openai-admin-salt')
    .update(ADMIN_PASSWORD)
    .digest('hex')
    .substring(0, 32);
}

const SESSION_TOKEN = generateSessionToken();

function maskKey(key) {
  if (!key) return '(empty)';
  if (key.length > 10) return key.substring(0, 6) + '***' + key.substring(key.length - 4);
  if (key.length > 4) return key.substring(0, 2) + '***';
  return '***';
}

function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const queryToken = req.query?.token;

  let token;
  if (authHeader) {
    token = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.substring(7).trim()
      : authHeader.trim();
  }
  token = token || queryToken;

  if (req.path === '/login' && req.method === 'POST') return next();
  if (req.path === '/' && req.method === 'GET') return next();

  if (token === SESSION_TOKEN || token === ADMIN_PASSWORD) return next();

  return res.status(401).json({ error: 'Unauthorized. Provide admin password.' });
}

router.use(adminAuth);

// ============================================
// GET /admin/ - Serve admin panel HTML
// ============================================
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getAdminHTML());
});

// ============================================
// POST /admin/login
// ============================================
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, token: SESSION_TOKEN });
  }
  return res.status(401).json({ error: 'Wrong password' });
});

// ============================================
// GET /admin/api/keys - List all keys
// ============================================
router.get('/api/keys', (req, res) => {
  res.json({
    keys: keyStore.getAllKeys(),
    summary: keyStore.getSummary()
  });
});

// ============================================
// POST /admin/api/keys - Add single key
// ============================================
router.post('/api/keys', (req, res) => {
  const { key, baseUrl } = req.body;
  if (!key) return res.status(400).json({ error: 'key is required' });

  const result = keyStore.addKey(key, baseUrl || process.env.OLLAMA_BASE_URL);
  if (!result) return res.status(400).json({ error: 'Invalid key format' });
  if (result.duplicate) return res.status(409).json({ error: 'Key already exists', key: result });

  res.json({ success: true, key: result });
});

// ============================================
// POST /admin/api/keys/batch - Batch import
// ============================================
router.post('/api/keys/batch', (req, res) => {
  const { keys, baseUrl } = req.body;
  if (!keys) return res.status(400).json({ error: 'keys text is required' });

  const results = keyStore.batchImport(keys, baseUrl || process.env.OLLAMA_BASE_URL);
  res.json(results);
});

// ============================================
// DELETE /admin/api/keys/:id - Remove key
// ============================================
router.delete('/api/keys/:id', (req, res) => {
  const ok = keyStore.removeKey(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Key not found' });
  res.json({ success: true });
});

// ============================================
// POST /admin/api/keys/:id/toggle - Enable/disable
// ============================================
router.post('/api/keys/:id/toggle', (req, res) => {
  const key = keyStore.toggleKey(req.params.id);
  if (!key) return res.status(404).json({ error: 'Key not found' });
  res.json({ success: true, key });
});

// ============================================
// POST /admin/api/keys/check - Health check all
// ============================================
router.post('/api/keys/check', async (req, res) => {
  await keyStore.checkAllHealth();
  res.json({
    keys: keyStore.getAllKeys(),
    summary: keyStore.getSummary()
  });
});

// ============================================
// POST /admin/api/keys/:id/check - Health check single
// ============================================
router.post('/api/keys/:id/check', async (req, res) => {
  const key = keyStore.keys.find(k => k.id === req.params.id);
  if (!key) return res.status(404).json({ error: 'Key not found' });

  await keyStore.checkKeyHealth(key);
  res.json({ success: true, key: { ...key, key: maskKey(key.key) } });
});

// ============================================
// DELETE /admin/api/keys - Clear all keys
// ============================================
router.delete('/api/keys', (req, res) => {
  keyStore.clearAll();
  res.json({ success: true });
});

// ============================================
// POST /admin/api/keys/reset-health
// ============================================
router.post('/api/keys/reset-health', (req, res) => {
  keyStore.resetHealth();
  res.json({ success: true });
});

// ============================================
// GET /admin/api/stats - Usage stats
// ============================================
router.get('/api/stats', (req, res) => {
  res.json({
    summary: keyStore.getSummary(),
    stats: keyStore.stats,
  });
});

// ============================================
// GET /admin/api/cache - Cache stats
// ============================================
router.get('/api/cache', (req, res) => {
  res.json(cacheManager.getStats());
});

// ============================================
// DELETE /admin/api/cache - Clear cache
// ============================================
router.delete('/api/cache', (req, res) => {
  cacheManager.clearAll();
  res.json({ success: true, message: 'All caches cleared' });
});

// ============================================
// Token Management API
// ============================================
router.get('/api/tokens', (req, res) => {
  res.json({ tokens: tokenManager.getAllTokens(), summary: tokenManager.getSummary() });
});

router.post('/api/tokens', (req, res) => {
  const { name, expiresAt, rateLimit, quotaLimit, allowedModels, allowedIPs } = req.body;
  const token = tokenManager.createToken({ name, expiresAt, rateLimit, quotaLimit, allowedModels, allowedIPs });
  logger.audit('token.create', 'admin', { tokenId: token.id, name });
  // Return full token only on creation
  res.json({ success: true, token });
});

router.put('/api/tokens/:id', (req, res) => {
  const result = tokenManager.updateToken(req.params.id, req.body);
  if (!result) return res.status(404).json({ error: 'Token not found' });
  logger.audit('token.update', 'admin', { tokenId: req.params.id });
  res.json({ success: true, token: result });
});

router.delete('/api/tokens/:id', (req, res) => {
  const ok = tokenManager.deleteToken(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Token not found' });
  logger.audit('token.delete', 'admin', { tokenId: req.params.id });
  res.json({ success: true });
});

router.get('/api/tokens/:id/usage', (req, res) => {
  const days = parseInt(req.query.days || '30');
  res.json({ usage: tokenManager.getTokenUsage(req.params.id, days) });
});

// ============================================
// Channel Management API
// ============================================
router.get('/api/channels', (req, res) => {
  res.json({ channels: channelManager.getAllChannels(), summary: channelManager.getSummary() });
});

router.post('/api/channels', (req, res) => {
  const channel = channelManager.createChannel(req.body);
  logger.audit('channel.create', 'admin', { channelId: channel.id, name: channel.name });
  res.json({ success: true, channel });
});

router.put('/api/channels/:id', (req, res) => {
  const result = channelManager.updateChannel(req.params.id, req.body);
  if (!result) return res.status(404).json({ error: 'Channel not found' });
  logger.audit('channel.update', 'admin', { channelId: req.params.id });
  res.json({ success: true, channel: result });
});

router.delete('/api/channels/:id', (req, res) => {
  const ok = channelManager.deleteChannel(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Channel not found' });
  logger.audit('channel.delete', 'admin', { channelId: req.params.id });
  res.json({ success: true });
});

router.post('/api/channels/check', async (req, res) => {
  const results = await channelManager.checkAllHealth();
  res.json({ results, channels: channelManager.getAllChannels() });
});

router.post('/api/channels/reset-health', (req, res) => {
  channelManager.resetHealth();
  res.json({ success: true });
});

// ============================================
// Logs API
// ============================================
router.get('/api/logs', (req, res) => {
  const { type, level, limit } = req.query;
  const logs = logger.getRecentLogs({
    type: type || undefined,
    level: level || undefined,
    limit: parseInt(limit || '200'),
  });
  res.json({ logs });
});

router.delete('/api/logs', (req, res) => {
  logger.clearRecent();
  res.json({ success: true });
});

// ============================================
// Settings / Access Control API
// ============================================
router.get('/api/settings', (req, res) => {
  res.json({
    accessControl: accessControl.getConfig(),
    rateLimiter: rateLimiter.getStats(),
    metrics: metrics.getSummary(),
    version: '3.0.0',
    env: {
      port: process.env.PORT || '3000',
      connectTimeout: process.env.CONNECT_TIMEOUT || '30000',
      requestTimeout: process.env.REQUEST_TIMEOUT || '300000',
      maxRetries: process.env.MAX_RETRIES || '2',
      logLevel: process.env.LOG_LEVEL || 'info',
      logToFile: process.env.LOG_TO_FILE || 'false',
      healthCheckInterval: process.env.HEALTH_CHECK_INTERVAL || '60',
      cacheEmbeddings: process.env.CACHE_EMBEDDINGS !== 'false',
      cacheChat: process.env.CACHE_CHAT === 'true',
    }
  });
});

router.post('/api/settings/access-control', (req, res) => {
  const { mode, whitelist, blacklist } = req.body;
  if (mode) accessControl.setMode(mode);
  if (whitelist) {
    accessControl.whitelist.clear();
    whitelist.forEach(ip => accessControl.addToWhitelist(ip));
  }
  if (blacklist) {
    accessControl.blacklist.clear();
    blacklist.forEach(ip => accessControl.addToBlacklist(ip));
  }
  logger.audit('settings.access_control', 'admin', { mode });
  res.json({ success: true, accessControl: accessControl.getConfig() });
});

// ============================================
// Dashboard API (aggregate)
// ============================================
router.get('/api/dashboard', (req, res) => {
  res.json({
    keys: keyStore.getSummary(),
    channels: channelManager.getSummary(),
    tokens: tokenManager.getSummary(),
    cache: cacheManager.getStats(),
    metrics: metrics.getSummary(),
    usage: tokenManager.getAggregateUsage(7),
    rateLimiter: rateLimiter.getStats(),
    accessControl: { mode: accessControl.mode },
  });
});

// ============================================
// Admin Panel HTML (embedded - fully redesigned)
// ============================================
function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="theme-color" content="#0f1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Ollama2OpenAI Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0f1117;--surface:#161b27;--surface2:#1e2435;--surface3:#252c3f;
  --border:#2a3050;--border2:#374165;
  --text:#e2e8f0;--text2:#8892a4;--text3:#5a6478;
  --primary:#6366f1;--primary-hover:#818cf8;--primary-glow:rgba(99,102,241,.2);
  --success:#22c55e;--success-bg:rgba(34,197,94,.1);
  --danger:#ef4444;--danger-bg:rgba(239,68,68,.1);
  --warning:#f59e0b;--warning-bg:rgba(245,158,11,.1);
  --info:#38bdf8;--info-bg:rgba(56,189,248,.1);
  --radius:12px;--radius-sm:8px;--radius-xs:4px;
  --shadow:0 4px 24px rgba(0,0,0,.4);
  --font-mono:'JetBrains Mono','Fira Code','Cascadia Code',monospace;
}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Helvetica Neue',sans-serif;
  background:var(--bg);color:var(--text);min-height:100vh;font-size:14px;line-height:1.5;overflow-x:hidden}

/* Scrollbar */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}

/* ===================== Layout ===================== */
.app-layout{display:flex;min-height:100vh}

/* Sidebar */
.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);
  display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:50;
  transition:transform .25s cubic-bezier(.4,0,.2,1)}
.sidebar-logo{padding:20px 16px 16px;border-bottom:1px solid var(--border)}
.sidebar-logo h1{font-size:16px;font-weight:700;background:linear-gradient(135deg,#6366f1,#a78bfa,#38bdf8);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.sidebar-logo .version{font-size:10px;color:var(--text3);margin-top:2px;font-family:var(--font-mono)}
.sidebar-nav{flex:1;padding:12px 8px;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:var(--radius-sm);
  cursor:pointer;color:var(--text2);font-size:13px;font-weight:500;
  transition:all .15s;margin-bottom:2px;user-select:none}
.nav-item:hover{background:var(--surface2);color:var(--text)}
.nav-item.active{background:var(--primary-glow);color:var(--primary)}
.nav-item .nav-icon{width:18px;height:18px;opacity:.7;flex-shrink:0}
.nav-item.active .nav-icon{opacity:1}
.nav-badge{margin-left:auto;background:var(--primary);color:#fff;font-size:10px;
  font-weight:700;padding:1px 6px;border-radius:10px;min-width:18px;text-align:center}
.sidebar-footer{padding:12px 8px;border-top:1px solid var(--border)}
.sidebar-footer .api-url{font-size:10px;color:var(--text3);font-family:var(--font-mono);
  padding:6px 8px;background:var(--surface2);border-radius:var(--radius-xs);word-break:break-all}

/* Main */
.main-content{flex:1;margin-left:220px;min-height:100vh;display:flex;flex-direction:column}
.topbar{height:56px;background:var(--surface);border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;padding:0 24px;
  position:sticky;top:0;z-index:40;gap:12px}
.topbar-left{display:flex;align-items:center;gap:10px}
.topbar-title{font-size:16px;font-weight:600;color:var(--text)}
.topbar-subtitle{font-size:12px;color:var(--text2)}
.topbar-right{display:flex;align-items:center;gap:8px}
.page-content{flex:1;padding:24px;max-width:1400px;width:100%}

/* Mobile nav toggle */
.hamburger{display:none;background:none;border:none;cursor:pointer;padding:6px;
  color:var(--text);flex-direction:column;gap:4px}
.hamburger span{display:block;width:20px;height:2px;background:currentColor;border-radius:2px;transition:.2s}
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:45}

/* ===================== Components ===================== */
/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.card-header{display:flex;justify-content:space-between;align-items:center;
  padding:14px 18px;border-bottom:1px solid var(--border);gap:10px;flex-wrap:wrap}
.card-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
.card-body{padding:18px}
.card-body.no-pad{padding:0}

/* Stat cards */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:16px 18px;transition:border-color .15s,transform .15s}
.stat-card:hover{border-color:var(--border2);transform:translateY(-1px)}
.stat-label{font-size:11px;font-weight:500;color:var(--text2);text-transform:uppercase;
  letter-spacing:.6px;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.stat-value{font-size:28px;font-weight:700;line-height:1;margin-bottom:4px}
.stat-sub{font-size:11px;color:var(--text2)}
.stat-trend{font-size:11px;color:var(--success);margin-top:4px}

/* Color helpers */
.c-green{color:var(--success)}.c-red{color:var(--danger)}.c-yellow{color:var(--warning)}
.c-blue{color:var(--info)}.c-purple{color:var(--primary)}.c-gray{color:var(--text2)}

/* Badges */
.badge{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:20px;
  font-size:11px;font-weight:600;white-space:nowrap}
.badge-green{background:var(--success-bg);color:var(--success);border:1px solid rgba(34,197,94,.2)}
.badge-red{background:var(--danger-bg);color:var(--danger);border:1px solid rgba(239,68,68,.2)}
.badge-yellow{background:var(--warning-bg);color:var(--warning);border:1px solid rgba(245,158,11,.2)}
.badge-gray{background:rgba(88,107,130,.1);color:var(--text2);border:1px solid var(--border)}
.badge-blue{background:var(--info-bg);color:var(--info);border:1px solid rgba(56,189,248,.2)}
.badge-purple{background:var(--primary-glow);color:var(--primary);border:1px solid rgba(99,102,241,.2)}
.dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0}
.dot-green{background:var(--success)}.dot-red{background:var(--danger)}
.dot-yellow{background:var(--warning)}.dot-gray{background:var(--text3)}

/* Buttons */
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:none;
  border-radius:var(--radius-sm);font-size:13px;font-weight:500;cursor:pointer;
  transition:all .15s;white-space:nowrap;text-decoration:none;user-select:none}
.btn:disabled{opacity:.45;cursor:not-allowed;pointer-events:none}
.btn-sm{padding:5px 10px;font-size:12px;border-radius:6px}
.btn-xs{padding:3px 8px;font-size:11px;border-radius:4px}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover:not(:disabled){background:var(--primary-hover);box-shadow:0 0 12px var(--primary-glow)}
.btn-danger{background:var(--danger);color:#fff}.btn-danger:hover:not(:disabled){opacity:.85}
.btn-success{background:var(--success);color:#fff}.btn-success:hover:not(:disabled){opacity:.85}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-outline:hover:not(:disabled){border-color:var(--primary);color:var(--primary);background:var(--primary-glow)}
.btn-ghost{background:transparent;border:1px solid transparent;color:var(--text2)}
.btn-ghost:hover:not(:disabled){background:var(--surface2);color:var(--text)}
.btn-group{display:flex;gap:6px;flex-wrap:wrap;align-items:center}

/* Forms */
.form-group{margin-bottom:14px}
label,.form-label{display:block;font-size:12px;font-weight:500;color:var(--text2);margin-bottom:5px}
input,textarea,select{background:var(--surface2);border:1px solid var(--border);
  border-radius:var(--radius-sm);padding:9px 12px;color:var(--text);font-size:13px;
  width:100%;outline:none;transition:border-color .15s,box-shadow .15s;
  -webkit-appearance:none;appearance:none}
input:focus,textarea:focus,select:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-glow)}
input::placeholder,textarea::placeholder{color:var(--text3)}
textarea{resize:vertical;min-height:90px;font-family:var(--font-mono);font-size:12px;line-height:1.6}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 10px center;padding-right:32px;cursor:pointer}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.form-hint{font-size:11px;color:var(--text3);margin-top:4px}
.input-group{display:flex;gap:0}
.input-group input{border-radius:var(--radius-sm) 0 0 var(--radius-sm)}
.input-group .btn{border-radius:0 var(--radius-sm) var(--radius-sm) 0;flex-shrink:0}

/* Table */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.tbl{width:100%;border-collapse:collapse;min-width:600px}
table.tbl th{text-align:left;padding:10px 14px;font-size:11px;font-weight:600;
  color:var(--text2);text-transform:uppercase;letter-spacing:.5px;
  border-bottom:1px solid var(--border);background:var(--surface2);white-space:nowrap}
table.tbl td{padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px;vertical-align:middle}
table.tbl tr:last-child td{border-bottom:none}
table.tbl tr:hover td{background:var(--surface2)}
table.tbl .mono{font-family:var(--font-mono);font-size:11px}

/* Mono text with copy */
.mono-copy{display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono);font-size:11px}
.copy-btn{background:none;border:none;cursor:pointer;color:var(--text3);padding:1px 3px;
  border-radius:3px;transition:.15s;font-size:10px;display:inline-flex;align-items:center}
.copy-btn:hover{color:var(--primary);background:var(--primary-glow)}

/* Modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);
  display:flex;align-items:flex-end;justify-content:center;z-index:200;padding:0}
@media(min-width:640px){.modal-overlay{align-items:center;padding:20px}}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius) var(--radius) 0 0;
  padding:24px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;
  box-shadow:var(--shadow);animation:slideUp .25s ease}
@media(min-width:640px){.modal{border-radius:var(--radius);animation:fadeScale .2s ease}}
@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
@keyframes fadeScale{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
.modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.modal-title{font-size:16px;font-weight:600}
.modal-close{background:none;border:none;cursor:pointer;color:var(--text2);
  padding:4px;border-radius:4px;transition:.15s;display:flex}
.modal-close:hover{color:var(--text);background:var(--surface2)}
.modal-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:20px;flex-wrap:wrap}

/* Toast */
.toast-container{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:1000;pointer-events:none}
.toast{padding:10px 16px;border-radius:var(--radius-sm);color:#fff;font-size:13px;
  box-shadow:var(--shadow);animation:toastIn .3s ease;pointer-events:all;
  max-width:340px;word-break:break-word;display:flex;align-items:center;gap:8px;
  border-left:3px solid rgba(255,255,255,.3)}
.toast-success{background:#15803d}.toast-error{background:#b91c1c}.toast-info{background:#1d4ed8}.toast-warn{background:#b45309}
@keyframes toastIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes toastOut{to{transform:translateX(120%);opacity:0}}

/* Login */
.login-page{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;
  justify-content:center;padding:20px;z-index:500}
.login-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:40px 32px;width:100%;max-width:380px;box-shadow:var(--shadow)}
.login-logo{text-align:center;margin-bottom:28px}
.login-logo h1{font-size:22px;font-weight:700;background:linear-gradient(135deg,#6366f1,#a78bfa,#38bdf8);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.login-logo p{font-size:13px;color:var(--text2);margin-top:6px}
.login-card .btn{width:100%;justify-content:center;padding:11px}

/* Log entries */
.log-list{font-family:var(--font-mono);font-size:11px;line-height:1.6}
.log-entry{display:flex;gap:8px;padding:6px 14px;border-bottom:1px solid var(--border);align-items:baseline}
.log-entry:last-child{border-bottom:none}
.log-entry:hover{background:var(--surface2)}
.log-ts{color:var(--text3);min-width:140px;flex-shrink:0;font-size:10px}
.log-lvl{min-width:42px;font-weight:700;flex-shrink:0}
.log-comp{color:var(--info);min-width:70px;flex-shrink:0}
.log-msg{flex:1;color:var(--text2);word-break:break-all}
.log-lvl-error{color:var(--danger)}.log-lvl-warn{color:var(--warning)}
.log-lvl-info{color:var(--success)}.log-lvl-debug{color:var(--text3)}
.log-type-request{background:rgba(56,189,248,.03)}
.log-type-audit{background:rgba(99,102,241,.03)}

/* Progress / Chart */
.usage-bar{height:4px;background:var(--surface2);border-radius:2px;overflow:hidden;margin-top:4px}
.usage-bar-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,var(--primary),#a78bfa);transition:width .4s ease}
.mini-chart{display:flex;align-items:flex-end;gap:3px;height:40px}
.mini-bar{flex:1;background:var(--primary-glow);border-radius:2px 2px 0 0;
  min-height:2px;transition:height .4s ease;cursor:pointer;position:relative}
.mini-bar:hover{background:var(--primary)}

/* Divider */
.divider{border:none;border-top:1px solid var(--border);margin:16px 0}

/* Status indicator */
.status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;position:relative}
.status-dot.pulse::after{content:'';position:absolute;inset:-3px;border-radius:50%;
  border:1px solid currentColor;opacity:.4;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{transform:scale(1);opacity:.4}50%{transform:scale(1.5);opacity:0}}
.status-green{background:var(--success);color:var(--success)}
.status-red{background:var(--danger);color:var(--danger)}
.status-yellow{background:var(--warning);color:var(--warning)}

/* Search / filter bar */
.filter-bar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
.filter-bar input,.filter-bar select{width:auto;min-width:120px;flex:1}
.search-input{max-width:280px}

/* Tabs (for sub-views) */
.sub-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:16px}
.sub-tab{padding:8px 14px;cursor:pointer;color:var(--text2);font-size:12px;font-weight:500;
  border-bottom:2px solid transparent;margin-bottom:-1px;transition:.15s}
.sub-tab:hover{color:var(--text)}
.sub-tab.active{color:var(--primary);border-bottom-color:var(--primary)}

/* Page fade */
.page-section{display:none;animation:fadeIn .2s ease}
.page-section.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

/* Empty states */
.empty-state{text-align:center;padding:40px 20px;color:var(--text2)}
.empty-state svg{opacity:.3;margin-bottom:12px}
.empty-state p{font-size:13px}

/* Code block */
.code-block{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);
  padding:12px 14px;font-family:var(--font-mono);font-size:12px;color:var(--text);
  overflow-x:auto;white-space:pre-wrap;word-break:break-all}

/* Tooltip */
[data-tip]{position:relative}
[data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100%+6px);left:50%;
  transform:translateX(-50%);background:#1e293b;color:var(--text);font-size:11px;
  padding:4px 8px;border-radius:4px;white-space:nowrap;z-index:100;pointer-events:none;
  border:1px solid var(--border)}

/* ===================== Responsive ===================== */
@media(max-width:768px){
  .sidebar{transform:translateX(-100%)}
  .sidebar.open{transform:translateX(0)}
  .sidebar-overlay.open{display:block}
  .main-content{margin-left:0}
  .hamburger{display:flex}
  .stats-grid{grid-template-columns:repeat(2,1fr)}
  .form-row,.form-row-3{grid-template-columns:1fr}
  .topbar{padding:0 16px}
  .page-content{padding:16px}
  .card-header{padding:12px 14px}
  .card-body{padding:14px}
  .tbl th,.tbl td{padding:8px 10px}
  table.tbl{min-width:480px}
  .modal-footer{flex-direction:column-reverse}
  .modal-footer .btn{width:100%;justify-content:center}
}
@media(max-width:480px){
  .stats-grid{grid-template-columns:1fr 1fr}
  .stat-value{font-size:22px}
  .topbar-subtitle{display:none}
}
</style>
</head>
<body>

<!-- Toast container -->
<div class="toast-container" id="toastContainer"></div>

<!-- Login -->
<div class="login-page" id="loginPage">
<div class="login-card">
  <div class="login-logo">
    <h1>Ollama2OpenAI</h1>
    <p>Enterprise Admin Panel</p>
  </div>
  <div class="form-group">
    <label>管理员密码</label>
    <input type="password" id="loginPwd" placeholder="输入密码" autocomplete="current-password"
      onkeydown="if(event.key==='Enter')doLogin()">
  </div>
  <button class="btn btn-primary" onclick="doLogin()" id="loginBtn">登录</button>
</div>
</div>

<!-- Sidebar overlay for mobile -->
<div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>

<!-- Sidebar -->
<aside class="sidebar" id="sidebar">
  <div class="sidebar-logo">
    <h1>Ollama2OpenAI</h1>
    <div class="version">v3.0 Enterprise</div>
  </div>
  <nav class="sidebar-nav">
    <div class="nav-item active" data-page="dashboard" onclick="navTo('dashboard',this)">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      Dashboard
    </div>
    <div class="nav-item" data-page="keys" onclick="navTo('keys',this)">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="15" r="4"/><path d="m15 9-6.343 6.343M15 9l3-3M18 6l-1.5 1.5"/></svg>
      API Keys
      <span class="nav-badge" id="navKeyCount">0</span>
    </div>
    <div class="nav-item" data-page="tokens" onclick="navTo('tokens',this)">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 9v9"/></svg>
      Tokens
      <span class="nav-badge" id="navTokenCount">0</span>
    </div>
    <div class="nav-item" data-page="channels" onclick="navTo('channels',this)">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
      Channels
    </div>
    <div class="nav-item" data-page="logs" onclick="navTo('logs',this)">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      日志
    </div>
    <div class="nav-item" data-page="settings" onclick="navTo('settings',this)">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      设置
    </div>
    <div class="nav-item" data-page="docs" onclick="navTo('docs',this)">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
      使用文档
    </div>
  </nav>
  <div class="sidebar-footer">
    <div class="api-url" id="sidebarApiUrl">API: loading...</div>
  </div>
</aside>

<!-- Main -->
<div class="main-content" id="mainContent" style="display:none">
  <header class="topbar">
    <div class="topbar-left">
      <button class="hamburger" onclick="toggleSidebar()" aria-label="菜单">
        <span></span><span></span><span></span>
      </button>
      <div>
        <div class="topbar-title" id="pageTitle">Dashboard</div>
        <div class="topbar-subtitle" id="pageSubtitle">系统概览</div>
      </div>
    </div>
    <div class="topbar-right">
      <div id="autoRefreshIndicator" style="display:none;font-size:11px;color:var(--text3);align-items:center;gap:4px">
        <span class="status-dot status-green pulse" style="width:6px;height:6px"></span>实时刷新
      </div>
      <button class="btn btn-outline btn-sm" onclick="loadCurrentPage()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        刷新
      </button>
      <button class="btn btn-ghost btn-sm" onclick="doLogout()">退出</button>
    </div>
  </header>

  <div class="page-content">
    <!-- Dashboard -->
    <section class="page-section active" id="page-dashboard">
      <div class="stats-grid" id="dashStats"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px" id="dashCharts">
        <div class="card">
          <div class="card-header"><div class="card-title">7天请求趋势</div></div>
          <div class="card-body" id="reqTrend" style="min-height:80px"></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">系统状态</div></div>
          <div class="card-body" id="sysStatus" style="font-size:12px"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">近7日用量统计</div>
          <button class="btn btn-ghost btn-sm" onclick="loadDashboard()">刷新</button>
        </div>
        <div class="card-body no-pad">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>日期</th><th>请求数</th><th>Prompt Tokens</th><th>Completion</th><th>合计</th></tr></thead>
            <tbody id="usageBody"></tbody>
          </table></div>
        </div>
      </div>
    </section>

    <!-- Keys -->
    <section class="page-section" id="page-keys">
      <div class="card" style="margin-bottom:16px">
        <div class="card-header">
          <div class="card-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            批量导入 Keys
          </div>
          <div class="btn-group">
            <button class="btn btn-outline btn-sm" onclick="checkAllHealth()">全部检测</button>
            <button class="btn btn-outline btn-sm" onclick="resetHealth()">重置状态</button>
            <button class="btn btn-danger btn-sm" onclick="clearAllKeys()">清空全部</button>
          </div>
        </div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group">
              <label>默认 Base URL</label>
              <input id="defaultBaseUrl" placeholder="https://ollama.com/api 或留空使用环境变量">
            </div>
            <div></div>
          </div>
          <div class="form-group">
            <label>Keys（每行一个，支持多种格式）</label>
            <textarea id="batchKeys" placeholder="sk-xxxxx&#10;https://api.example.com|sk-xxxxx&#10;https://api.example.com/sk-xxxxx"></textarea>
            <div class="form-hint">支持格式：bare key / URL|key / URL/key / URL#key</div>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <button class="btn btn-primary" onclick="batchImport()">导入</button>
            <span id="importResult" style="font-size:12px;color:var(--text2)"></span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">API Keys <span id="keyCount" style="color:var(--text2);font-weight:400;font-size:12px"></span></div>
        </div>
        <div class="card-body" style="padding-bottom:8px">
          <div class="filter-bar">
            <input class="search-input" id="keySearch" placeholder="搜索 key / URL..." oninput="renderKeys()">
            <select id="keyFilter" onchange="renderKeys()" style="width:100px">
              <option value="">全部状态</option>
              <option value="healthy">健康</option>
              <option value="unhealthy">异常</option>
              <option value="disabled">禁用</option>
            </select>
            <select id="keySort" onchange="renderKeys()" style="width:110px">
              <option value="added">添加时间</option>
              <option value="requests">请求数</option>
              <option value="tokens">Token用量</option>
              <option value="failed">失败率</option>
            </select>
          </div>
        </div>
        <div class="card-body no-pad">
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>状态</th><th>Key</th><th>URL</th><th>权重</th><th>优先级</th><th>请求</th><th>失败</th><th>Tokens</th><th>最后使用</th><th>操作</th></tr></thead>
              <tbody id="keysBody"></tbody>
            </table>
            <div id="noKeys" class="empty-state" style="display:none">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="15" r="4"/><path d="m15 9-6.343 6.343M15 9l3-3M18 6l-1.5 1.5"/></svg>
              <p>暂无 Keys，请在上方导入</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Tokens -->
    <section class="page-section" id="page-tokens">
      <div class="card">
        <div class="card-header">
          <div class="card-title">API Tokens（多用户认证）</div>
          <button class="btn btn-primary btn-sm" onclick="showCreateToken()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
            创建 Token
          </button>
        </div>
        <div class="card-body no-pad">
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>名称</th><th>Token</th><th>状态</th><th>请求数</th><th>Tokens用量</th><th>配额</th><th>最后使用</th><th>操作</th></tr></thead>
              <tbody id="tokensBody"></tbody>
            </table>
            <div id="noTokens" class="empty-state" style="display:none">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/></svg>
              <p>未创建任何 Token，使用上方按钮创建</p>
              <p style="margin-top:6px;font-size:11px">或使用环境变量 <code style="background:var(--surface2);padding:1px 5px;border-radius:3px">API_TOKEN</code> 设置单一认证</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Channels -->
    <section class="page-section" id="page-channels">
      <div class="card">
        <div class="card-header">
          <div class="card-title">渠道管理（Channel 路由）</div>
          <div class="btn-group">
            <button class="btn btn-primary btn-sm" onclick="showCreateChannel()">创建渠道</button>
            <button class="btn btn-outline btn-sm" onclick="checkChannels()">全部检测</button>
            <button class="btn btn-outline btn-sm" onclick="resetChannels()">重置状态</button>
          </div>
        </div>
        <div class="card-body no-pad">
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>名称</th><th>状态</th><th>优先级</th><th>权重</th><th>Keys</th><th>模型</th><th>请求</th><th>Tokens</th><th>操作</th></tr></thead>
              <tbody id="channelsBody"></tbody>
            </table>
            <div id="noChannels" class="empty-state" style="display:none">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18"/></svg>
              <p>未配置渠道，Keys 将直接使用（无渠道路由）</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Logs -->
    <section class="page-section" id="page-logs">
      <div class="card">
        <div class="card-header">
          <div class="card-title">系统日志</div>
          <div class="btn-group">
            <input id="logSearch" placeholder="搜索日志..." style="width:160px" oninput="filterLogs()">
            <select id="logType" style="width:90px" onchange="loadLogs()"><option value="">全部</option><option value="request">请求</option><option value="audit">审计</option></select>
            <select id="logLevel" style="width:90px" onchange="loadLogs()"><option value="">全部级别</option><option value="error">Error</option><option value="warn">Warn</option><option value="info">Info</option><option value="debug">Debug</option></select>
            <button class="btn btn-outline btn-sm" onclick="loadLogs()">刷新</button>
            <button class="btn btn-danger btn-sm" onclick="clearLogs()">清空</button>
          </div>
        </div>
        <div style="max-height:560px;overflow-y:auto;background:var(--surface)" id="logsContainer">
          <div class="log-list" id="logList"></div>
        </div>
      </div>
    </section>

    <!-- Settings -->
    <section class="page-section" id="page-settings">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><div class="card-title">IP 访问控制</div></div>
            <div class="card-body">
              <div class="form-group">
                <label>访问模式</label>
                <select id="acMode">
                  <option value="disabled">禁用（不限制）</option>
                  <option value="whitelist">白名单模式</option>
                  <option value="blacklist">黑名单模式</option>
                </select>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>白名单（每行一个IP/CIDR）</label>
                  <textarea id="acWhitelist" rows="4" placeholder="192.168.1.0/24&#10;10.0.0.1"></textarea>
                </div>
                <div class="form-group">
                  <label>黑名单（每行一个IP/CIDR）</label>
                  <textarea id="acBlacklist" rows="4" placeholder="1.2.3.4"></textarea>
                </div>
              </div>
              <button class="btn btn-primary" onclick="saveAccessControl()">保存访问控制</button>
            </div>
          </div>
          <div class="card">
            <div class="card-header">
              <div class="card-title">速率限制状态</div>
            </div>
            <div class="card-body" id="rlInfo" style="font-size:13px"></div>
          </div>
        </div>
        <div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header">
              <div class="card-title">缓存状态</div>
              <button class="btn btn-outline btn-sm" onclick="clearCache()">清空缓存</button>
            </div>
            <div class="card-body" id="cacheInfo"></div>
          </div>
          <div class="card">
            <div class="card-header"><div class="card-title">运行时配置</div></div>
            <div class="card-body" id="envInfo" style="font-size:12px"></div>
          </div>
        </div>
      </div>
    </section>

    <!-- Docs -->
    <section class="page-section" id="page-docs">
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><div class="card-title">快速接入指南</div></div>
        <div class="card-body">
          <p style="font-size:13px;color:var(--text2);margin-bottom:16px">将 API Base URL 和 Token 配置到你的 AI 客户端即可使用。</p>
          <div class="form-row">
            <div class="form-group">
              <label>API Base URL</label>
              <div class="input-group">
                <input id="docApiUrl" readonly>
                <button class="btn btn-outline" onclick="copyText(document.getElementById('docApiUrl').value)">复制</button>
              </div>
            </div>
            <div class="form-group">
              <label>模型名称（示例）</label>
              <input value="llama3.2 / deepseek-r1 / nomic-embed-text" readonly>
            </div>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card">
          <div class="card-header"><div class="card-title">Chat Completions</div></div>
          <div class="card-body">
            <div class="code-block" id="docCurlChat"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">Embeddings</div></div>
          <div class="card-body">
            <div class="code-block" id="docCurlEmbed"></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">兼容客户端</div></div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px">
            ${['ChatGPT Next Web','Open WebUI','LobeChat','Cherry Studio','ChatBox','LibreChat','Cursor','VS Code Copilot'].map(c=>`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:12px;font-weight:500">${c}</div>`).join('')}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-header"><div class="card-title">API 端点一览</div></div>
        <div class="card-body no-pad">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>方法</th><th>路径</th><th>说明</th></tr></thead>
            <tbody>
              <tr><td><span class="badge badge-green">GET</span></td><td class="mono">/v1/models</td><td>列出可用模型</td></tr>
              <tr><td><span class="badge badge-blue">POST</span></td><td class="mono">/v1/chat/completions</td><td>对话补全（流式+非流式）</td></tr>
              <tr><td><span class="badge badge-blue">POST</span></td><td class="mono">/v1/completions</td><td>文本补全</td></tr>
              <tr><td><span class="badge badge-blue">POST</span></td><td class="mono">/v1/embeddings</td><td>文本嵌入（带LRU缓存）</td></tr>
              <tr><td><span class="badge badge-green">GET</span></td><td class="mono">/health</td><td>健康检查</td></tr>
              <tr><td><span class="badge badge-green">GET</span></td><td class="mono">/metrics</td><td>Prometheus 指标</td></tr>
            </tbody>
          </table></div>
        </div>
      </div>
    </section>
  </div>
</div>

<!-- Modal -->
<div class="modal-overlay" id="modalOverlay" style="display:none" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modalContent"></div>
</div>

<script>
'use strict';
// ===================== State =====================
let TOKEN = localStorage.getItem('admin_token') || '';
let currentPage = 'dashboard';
let allKeys = [];
let allLogs = [];
let autoRefreshTimer = null;
const AUTO_REFRESH_INTERVAL = 30000;

// ===================== Init =====================
(async () => {
  if (TOKEN) {
    const ok = await apiFetch('/api/keys').then(r => r.ok).catch(() => false);
    ok ? showApp() : showLogin();
  } else {
    showLogin();
  }
})();

// ===================== Auth =====================
function showLogin() {
  document.getElementById('loginPage').style.display = 'flex';
  document.getElementById('mainContent').style.display = 'none';
  document.getElementById('loginPwd').value = '';
  document.getElementById('loginPwd').focus();
}

function showApp() {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('mainContent').style.display = 'flex';
  const base = location.origin + '/v1';
  document.getElementById('sidebarApiUrl').textContent = 'API: ' + base;
  updateDocUrls();
  loadCurrentPage();
  startAutoRefresh();
}

async function doLogin() {
  const pw = document.getElementById('loginPwd').value;
  if (!pw) return toast('请输入密码', 'error');
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = '登录中...';
  try {
    const r = await fetch('/admin/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({password: pw})
    });
    const d = await r.json();
    if (d.success) {
      TOKEN = d.token;
      localStorage.setItem('admin_token', TOKEN);
      showApp();
    } else {
      toast('密码错误', 'error');
    }
  } catch(e) {
    toast('登录失败: ' + e.message, 'error');
  }
  btn.disabled = false; btn.textContent = '登录';
}

function doLogout() {
  TOKEN = '';
  localStorage.removeItem('admin_token');
  stopAutoRefresh();
  showLogin();
}

// ===================== Fetch helpers =====================
function authHeaders() { return {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}; }

async function apiFetch(path, opts = {}) {
  return fetch('/admin' + path, {headers: authHeaders(), ...opts});
}

async function apiJson(path, opts = {}) {
  const r = await apiFetch(path, opts);
  if (r.status === 401) { doLogout(); return null; }
  if (!r.ok) {
    const e = await r.json().catch(() => ({error: r.statusText}));
    throw new Error(e.error || r.statusText);
  }
  return r.json();
}

// ===================== Navigation =====================
const PAGE_META = {
  dashboard: {title: 'Dashboard', subtitle: '系统概览与实时状态'},
  keys: {title: 'API Keys', subtitle: '管理 Ollama API 密钥'},
  tokens: {title: 'API Tokens', subtitle: '多用户认证令牌管理'},
  channels: {title: 'Channels', subtitle: '多后端路由渠道'},
  logs: {title: '系统日志', subtitle: '请求日志与审计记录'},
  settings: {title: '系统设置', subtitle: '访问控制与缓存配置'},
  docs: {title: '使用文档', subtitle: 'API 接入指南'},
};

function navTo(page, el) {
  currentPage = page;
  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
  // Update page sections
  document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
  const sec = document.getElementById('page-' + page);
  if (sec) sec.classList.add('active');
  // Update topbar
  const meta = PAGE_META[page] || {title: page, subtitle: ''};
  document.getElementById('pageTitle').textContent = meta.title;
  document.getElementById('pageSubtitle').textContent = meta.subtitle;
  // Load data
  loadCurrentPage();
  closeSidebar();
}

function loadCurrentPage() {
  if (currentPage === 'dashboard') loadDashboard();
  else if (currentPage === 'keys') loadKeys();
  else if (currentPage === 'tokens') loadTokens();
  else if (currentPage === 'channels') loadChannels();
  else if (currentPage === 'logs') loadLogs();
  else if (currentPage === 'settings') loadSettings();
  else if (currentPage === 'docs') updateDocUrls();
}

// ===================== Auto Refresh =====================
function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    if (currentPage === 'dashboard' || currentPage === 'logs') loadCurrentPage();
  }, AUTO_REFRESH_INTERVAL);
  document.getElementById('autoRefreshIndicator').style.display = 'flex';
}

function stopAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}

// ===================== Dashboard =====================
async function loadDashboard() {
  const d = await apiJson('/api/dashboard').catch(() => null);
  if (!d) return;
  const s = d.keys, ch = d.channels, t = d.tokens, m = d.metrics;

  // Update nav badges
  document.getElementById('navKeyCount').textContent = s.total;
  document.getElementById('navTokenCount').textContent = t.total;

  // Stats cards
  const healthPct = s.total > 0 ? Math.round(s.healthy / s.total * 100) : 0;
  document.getElementById('dashStats').innerHTML = \`
    <div class="stat-card">
      <div class="stat-label"><span class="status-dot status-green"></span>健康 Keys</div>
      <div class="stat-value c-green">\${s.healthy}</div>
      <div class="stat-sub">共 \${s.total} 个，健康率 \${healthPct}%</div>
      <div class="usage-bar"><div class="usage-bar-fill" style="width:\${healthPct}%"></div></div>
    </div>
    <div class="stat-card">
      <div class="stat-label"><span class="dot dot-green" style="background:var(--info)"></span>渠道</div>
      <div class="stat-value c-blue">\${ch.healthy}</div>
      <div class="stat-sub">\${ch.total} 个渠道，\${ch.healthy} 健康</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">API Tokens</div>
      <div class="stat-value">\${t.enabled}</div>
      <div class="stat-sub">共 \${t.total} 个，\${t.disabled} 禁用，\${t.expired} 过期</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">总请求数</div>
      <div class="stat-value">\${fmtNum(m.requests)}</div>
      <div class="stat-sub">\${m.activeConnections} 活跃连接</div>
    </div>
    <div class="stat-card">
      <div class="stat-label"><span class="status-dot status-green pulse"></span>活跃流</div>
      <div class="stat-value c-blue">\${m.activeStreams}</div>
      <div class="stat-sub">SSE 流式连接</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">缓存</div>
      <div class="stat-value">\${d.cache.totalItems}</div>
      <div class="stat-sub">条目缓存（Embeddings/Chat）</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">内存使用</div>
      <div class="stat-value">\${m.memory.heapUsed}<span style="font-size:14px;font-weight:400">MB</span></div>
      <div class="stat-sub">堆内存 / \${m.memory.heapTotal}MB</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">运行时间</div>
      <div class="stat-value">\${fmtUptime(m.uptime)}</div>
      <div class="stat-sub">持续运行</div>
    </div>
  \`;

  // Mini chart for usage
  const usage = d.usage || {};
  const dates = Object.keys(usage).sort();
  if (dates.length > 0) {
    const maxReq = Math.max(...dates.map(dt => usage[dt].requests), 1);
    document.getElementById('reqTrend').innerHTML =
      \`<div class="mini-chart">\${dates.map(dt => {
        const u = usage[dt];
        const h = Math.round(u.requests / maxReq * 100);
        return \`<div class="mini-bar" style="height:\${Math.max(h,4)}%" data-tip="\${dt}: \${u.requests} 请求"></div>\`;
      }).join('')}</div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-top:6px">
        <span>\${dates[0]}</span><span>\${dates[dates.length-1]}</span>
      </div>\`;
  } else {
    document.getElementById('reqTrend').innerHTML = '<div style="color:var(--text3);font-size:12px;text-align:center;padding:20px">暂无数据</div>';
  }

  // System status
  const rl = d.rateLimiter;
  document.getElementById('sysStatus').innerHTML = \`
    <div style="display:grid;gap:8px">
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--text2)">IP 访问控制</span>
        <span class="badge badge-\${d.accessControl.mode==='disabled'?'gray':'blue'}">\${d.accessControl.mode}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--text2)">全局限速</span>
        <span>\${typeof rl.global==='string'?rl.global:rl.global.maxRequests+'req/'+Math.round(rl.global.windowMs/1000)+'s'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--text2)">RSS 内存</span>
        <span>\${m.memory.rss} MB</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:6px 0">
        <span style="color:var(--text2)">Node.js</span>
        <span style="color:var(--text3);font-size:11px">\${navigator.userAgent.includes('Node') ? 'v18+' : '运行中'}</span>
      </div>
    </div>\`;

  // Usage table
  let html = '';
  if (dates.length === 0) {
    html = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text2)">暂无用量数据</td></tr>';
  } else {
    dates.reverse().forEach(dt => {
      const u = usage[dt];
      const total = u.promptTokens + u.completionTokens;
      html += \`<tr><td>\${esc(dt)}</td><td>\${fmtNum(u.requests)}</td><td>\${fmtNum(u.promptTokens)}</td><td>\${fmtNum(u.completionTokens)}</td><td><strong>\${fmtNum(total)}</strong></td></tr>\`;
    });
  }
  document.getElementById('usageBody').innerHTML = html;
}

// ===================== Keys =====================
async function loadKeys() {
  const d = await apiJson('/api/keys').catch(() => null);
  if (!d) return;
  allKeys = d.keys;
  document.getElementById('navKeyCount').textContent = d.keys.length;
  document.getElementById('keyCount').textContent = \`（\${d.summary.healthy} 健康 / \${d.keys.length} 总计）\`;
  renderKeys();
}

function renderKeys() {
  const q = (document.getElementById('keySearch')?.value || '').toLowerCase();
  const f = document.getElementById('keyFilter')?.value || '';
  const s = document.getElementById('keySort')?.value || 'added';

  let keys = [...allKeys];

  // Filter
  if (q) keys = keys.filter(k => k.key.toLowerCase().includes(q) || k.baseUrl.toLowerCase().includes(q));
  if (f === 'healthy') keys = keys.filter(k => k.enabled && k.healthy);
  if (f === 'unhealthy') keys = keys.filter(k => k.enabled && !k.healthy);
  if (f === 'disabled') keys = keys.filter(k => !k.enabled);

  // Sort
  if (s === 'requests') keys.sort((a, b) => b.totalRequests - a.totalRequests);
  else if (s === 'tokens') keys.sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
  else if (s === 'failed') keys.sort((a, b) => (b.failedRequests || 0) - (a.failedRequests || 0));

  const tbody = document.getElementById('keysBody');
  const empty = document.getElementById('noKeys');

  if (keys.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = keys.map(k => {
    const statusBadge = !k.enabled
      ? '<span class="badge badge-gray">禁用</span>'
      : k.healthy
        ? '<span class="badge badge-green"><span class="dot dot-green"></span>健康</span>'
        : '<span class="badge badge-red"><span class="dot dot-red"></span>异常</span>';
    const url = k.baseUrl.length > 28 ? k.baseUrl.substring(0, 28) + '…' : k.baseUrl;
    const lu = k.lastUsed ? timeSince(k.lastUsed) : '—';
    const failRate = k.totalRequests > 0 ? Math.round((k.failedRequests||0)/k.totalRequests*100) : 0;
    return \`<tr>
      <td>\${statusBadge}</td>
      <td><div class="mono-copy"><span class="mono">\${esc(k.key)}</span><button class="copy-btn" onclick="copyText('\${esc(k.key)}')" data-tip="复制">⊞</button></div></td>
      <td class="mono" title="\${esc(k.baseUrl)}">\${esc(url)}</td>
      <td>\${k.weight || 10}</td>
      <td>\${k.priority || 0}</td>
      <td>\${fmtNum(k.totalRequests)}</td>
      <td>\${k.failedRequests || 0}\${failRate > 20 ? ' <span class="badge badge-red" style="font-size:9px">'+failRate+'%</span>' : ''}</td>
      <td>\${fmtNum(k.totalTokens || 0)}</td>
      <td style="color:var(--text2)">\${lu}</td>
      <td><div class="btn-group">
        <button class="btn btn-ghost btn-xs" onclick="toggleKey('\${k.id}')">\${k.enabled ? '禁用' : '启用'}</button>
        <button class="btn btn-ghost btn-xs" onclick="checkKey('\${k.id}')">检测</button>
        <button class="btn btn-danger btn-xs" onclick="removeKey('\${k.id}')">删除</button>
      </div></td>
    </tr>\`;
  }).join('');
}

async function batchImport() {
  const keys = document.getElementById('batchKeys').value.trim();
  const baseUrl = document.getElementById('defaultBaseUrl').value.trim() || undefined;
  if (!keys) return toast('请输入 Keys', 'error');
  try {
    const d = await apiJson('/api/keys/batch', {method: 'POST', body: JSON.stringify({keys, baseUrl})});
    if (!d) return;
    document.getElementById('importResult').textContent = \`✓ 添加 \${d.added.length}，重复 \${d.duplicates.length}，错误 \${d.errors.length}\`;
    document.getElementById('batchKeys').value = '';
    toast(\`成功导入 \${d.added.length} 个 Key\`, 'success');
    loadKeys();
  } catch(e) { toast(e.message, 'error'); }
}

async function removeKey(id) {
  if (!confirm('确认删除此 Key？')) return;
  try { await apiJson('/api/keys/' + id, {method: 'DELETE'}); toast('已删除', 'success'); loadKeys(); }
  catch(e) { toast(e.message, 'error'); }
}

async function toggleKey(id) {
  try { await apiJson('/api/keys/' + id + '/toggle', {method: 'POST'}); loadKeys(); }
  catch(e) { toast(e.message, 'error'); }
}

async function checkKey(id) {
  toast('检测中...', 'info');
  try { await apiJson('/api/keys/' + id + '/check', {method: 'POST'}); loadKeys(); toast('检测完成', 'success'); }
  catch(e) { toast(e.message, 'error'); }
}

async function checkAllHealth() {
  toast('正在检测所有 Keys...', 'info');
  try { await apiJson('/api/keys/check', {method: 'POST'}); loadKeys(); toast('检测完成', 'success'); }
  catch(e) { toast(e.message, 'error'); }
}

async function resetHealth() {
  try { await apiJson('/api/keys/reset-health', {method: 'POST'}); loadKeys(); toast('已重置', 'success'); }
  catch(e) { toast(e.message, 'error'); }
}

async function clearAllKeys() {
  if (!confirm('确认清空所有 Keys？此操作不可撤销！')) return;
  try { await apiJson('/api/keys', {method: 'DELETE'}); loadKeys(); toast('已清空', 'success'); }
  catch(e) { toast(e.message, 'error'); }
}

// ===================== Tokens =====================
async function loadTokens() {
  const d = await apiJson('/api/tokens').catch(() => null);
  if (!d) return;
  document.getElementById('navTokenCount').textContent = d.tokens.length;
  const tbody = document.getElementById('tokensBody');
  const empty = document.getElementById('noTokens');
  if (d.tokens.length === 0) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  const now = new Date();
  tbody.innerHTML = d.tokens.map(t => {
    const isExpired = t.expiresAt && new Date(t.expiresAt) < now;
    const statusBadge = !t.enabled
      ? '<span class="badge badge-gray">禁用</span>'
      : isExpired ? '<span class="badge badge-red">已过期</span>'
      : '<span class="badge badge-green">有效</span>';
    const quota = t.quotaLimit ? \`\${fmtNum(t.quotaUsed)}/\${fmtNum(t.quotaLimit)}\` : '无限制';
    const lu = t.lastUsed ? timeSince(t.lastUsed) : '—';
    return \`<tr>
      <td style="font-weight:500">\${esc(t.name)}</td>
      <td><div class="mono-copy"><span class="mono" style="font-size:10px">\${esc(t.token)}</span>
        <button class="copy-btn" onclick="copyText('\${esc(t.token)}')" data-tip="复制">⊞</button></div></td>
      <td>\${statusBadge}</td>
      <td>\${fmtNum(t.totalRequests)}</td>
      <td>\${fmtNum(t.totalTokens)}</td>
      <td>\${quota}</td>
      <td style="color:var(--text2)">\${lu}</td>
      <td><div class="btn-group">
        <button class="btn btn-ghost btn-xs" onclick="editToken('\${t.id}')">编辑</button>
        <button class="btn btn-danger btn-xs" onclick="deleteToken('\${t.id}')">删除</button>
      </div></td>
    </tr>\`;
  }).join('');
}

function showCreateToken() {
  showModal(\`<div class="modal-header"><div class="modal-title">创建 API Token</div><button class="modal-close" onclick="closeModal()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
    <div class="form-group"><label>名称</label><input id="mTokName" value="API Token" placeholder="如：用户-Alice"></div>
    <div class="form-row">
      <div class="form-group"><label>月配额（Tokens，0=不限）</label><input id="mTokQuota" type="number" value="0" min="0"></div>
      <div class="form-group"><label>速率限制（请求/分，0=默认）</label><input id="mTokRate" type="number" value="0" min="0"></div>
    </div>
    <div class="form-group"><label>允许模型（逗号分隔，空=全部，支持 * 通配）</label><input id="mTokModels" placeholder="llama3.2,deepseek-r1,*embed*"></div>
    <div class="form-group"><label>过期时间（留空=永不过期）</label><input id="mTokExpires" type="datetime-local"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="createToken()">创建</button>
    </div>\`);
}

async function createToken() {
  const name = document.getElementById('mTokName').value;
  const quota = parseInt(document.getElementById('mTokQuota').value) || null;
  const rate = parseInt(document.getElementById('mTokRate').value) || null;
  const models = document.getElementById('mTokModels').value.split(',').map(s => s.trim()).filter(Boolean);
  const exp = document.getElementById('mTokExpires').value;
  try {
    const d = await apiJson('/api/tokens', {method: 'POST', body: JSON.stringify({name, quotaLimit: quota, rateLimit: rate, allowedModels: models, expiresAt: exp || null})});
    if (!d || !d.success) return;
    closeModal();
    // Show full token in success modal
    showModal(\`<div class="modal-header"><div class="modal-title">Token 创建成功</div><button class="modal-close" onclick="closeModal()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px">请保存此 Token，它只会显示一次：</p>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:16px">
        <div style="font-family:var(--font-mono);font-size:13px;word-break:break-all;color:var(--text)">\${esc(d.token.token)}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="copyText('\${esc(d.token.token)}');toast('Token 已复制','success')">复制 Token</button>
        <button class="btn btn-primary" onclick="closeModal()">确认</button>
      </div>\`);
    loadTokens();
    toast('Token 创建成功', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function editToken(id) {
  const d = await apiJson('/api/tokens').catch(() => null);
  if (!d) return;
  const t = d.tokens.find(x => x.id === id);
  if (!t) return;
  showModal(\`<div class="modal-header"><div class="modal-title">编辑 Token: \${esc(t.name)}</div><button class="modal-close" onclick="closeModal()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
    <div class="form-group"><label>名称</label><input id="mTokName" value="\${esc(t.name)}"></div>
    <div class="form-group"><label>状态</label>
      <select id="mTokEnabled">
        <option value="true" \${t.enabled ? 'selected' : ''}>启用</option>
        <option value="false" \${!t.enabled ? 'selected' : ''}>禁用</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group"><label>月配额（0=不限）</label><input id="mTokQuota" type="number" value="\${t.quotaLimit || 0}"></div>
      <div class="form-group"><label>速率限制</label><input id="mTokRate" type="number" value="\${t.rateLimit || 0}"></div>
    </div>
    <div class="form-group"><label>允许模型</label><input id="mTokModels" value="\${(t.allowedModels||[]).join(',')}"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="updateToken('\${id}')">保存</button>
    </div>\`);
}

async function updateToken(id) {
  const updates = {
    name: document.getElementById('mTokName').value,
    enabled: document.getElementById('mTokEnabled').value === 'true',
    quotaLimit: parseInt(document.getElementById('mTokQuota').value) || null,
    rateLimit: parseInt(document.getElementById('mTokRate').value) || null,
    allowedModels: document.getElementById('mTokModels').value.split(',').map(s => s.trim()).filter(Boolean),
  };
  try {
    await apiJson('/api/tokens/' + id, {method: 'PUT', body: JSON.stringify(updates)});
    closeModal(); toast('已更新', 'success'); loadTokens();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteToken(id) {
  if (!confirm('确认删除此 Token？')) return;
  try { await apiJson('/api/tokens/' + id, {method: 'DELETE'}); toast('已删除', 'success'); loadTokens(); }
  catch(e) { toast(e.message, 'error'); }
}

// ===================== Channels =====================
async function loadChannels() {
  const d = await apiJson('/api/channels').catch(() => null);
  if (!d) return;
  const tbody = document.getElementById('channelsBody');
  const empty = document.getElementById('noChannels');
  if (d.channels.length === 0) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  tbody.innerHTML = d.channels.map(c => {
    const st = !c.enabled
      ? '<span class="badge badge-gray">禁用</span>'
      : c.healthy ? '<span class="badge badge-green">健康</span>'
      : '<span class="badge badge-red">异常</span>';
    const models = c.models.length > 0 ? c.models.join(', ').substring(0, 30) : '全部';
    return \`<tr>
      <td style="font-weight:500">\${esc(c.name)}</td>
      <td>\${st}</td>
      <td>\${c.priority}</td>
      <td>\${c.weight}</td>
      <td>\${c.keys.length}</td>
      <td style="color:var(--text2);font-size:11px">\${esc(models)}\${c.models.length > 3 ? '…' : ''}</td>
      <td>\${fmtNum(c.totalRequests)}</td>
      <td>\${fmtNum(c.totalTokens)}</td>
      <td><div class="btn-group">
        <button class="btn btn-ghost btn-xs" onclick="editChannel('\${c.id}')">编辑</button>
        <button class="btn btn-danger btn-xs" onclick="deleteChannel('\${c.id}')">删除</button>
      </div></td>
    </tr>\`;
  }).join('');
}

function showCreateChannel() {
  showModal(\`<div class="modal-header"><div class="modal-title">创建渠道</div><button class="modal-close" onclick="closeModal()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
    <div class="form-group"><label>名称</label><input id="mChName" value="New Channel" placeholder="如：Cloud GPU"></div>
    <div class="form-group"><label>Base URL</label><input id="mChUrl" value="https://ollama.com/api"></div>
    <div class="form-group"><label>Keys（每行一个）</label><textarea id="mChKeys" rows="3" placeholder="sk-xxx"></textarea></div>
    <div class="form-row">
      <div class="form-group"><label>优先级（越大越优先）</label><input id="mChPri" type="number" value="0"></div>
      <div class="form-group"><label>权重</label><input id="mChWeight" type="number" value="10"></div>
    </div>
    <div class="form-group"><label>支持模型（逗号分隔，空=全部）</label><input id="mChModels" placeholder="llama3.2,deepseek-r1"></div>
    <div class="form-group"><label>模型映射（JSON，如 {"gpt-4":"llama3.2:70b"}）</label><input id="mChMapping" placeholder="{}"></div>
    <div class="form-group"><label>最大并发（0=不限）</label><input id="mChMax" type="number" value="0"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="createChannel()">创建</button>
    </div>\`);
}

async function createChannel() {
  let mapping = {};
  try { mapping = JSON.parse(document.getElementById('mChMapping').value || '{}'); } catch {}
  try {
    const d = await apiJson('/api/channels', {method: 'POST', body: JSON.stringify({
      name: document.getElementById('mChName').value,
      baseUrl: document.getElementById('mChUrl').value,
      keys: document.getElementById('mChKeys').value.split('\\n').map(s => s.trim()).filter(Boolean),
      priority: parseInt(document.getElementById('mChPri').value) || 0,
      weight: parseInt(document.getElementById('mChWeight').value) || 10,
      models: document.getElementById('mChModels').value.split(',').map(s => s.trim()).filter(Boolean),
      modelMapping: mapping,
      maxConcurrent: parseInt(document.getElementById('mChMax').value) || 0,
    })});
    if (d?.success) { closeModal(); toast('渠道已创建', 'success'); loadChannels(); }
  } catch(e) { toast(e.message, 'error'); }
}

async function editChannel(id) {
  const d = await apiJson('/api/channels').catch(() => null);
  if (!d) return;
  const c = d.channels.find(x => x.id === id);
  if (!c) return;
  showModal(\`<div class="modal-header"><div class="modal-title">编辑渠道: \${esc(c.name)}</div><button class="modal-close" onclick="closeModal()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
    <div class="form-group"><label>名称</label><input id="mChName" value="\${esc(c.name)}"></div>
    <div class="form-group"><label>Base URL</label><input id="mChUrl" value="\${esc(c.baseUrl)}"></div>
    <div class="form-group"><label>状态</label>
      <select id="mChEnabled">
        <option value="true" \${c.enabled ? 'selected' : ''}>启用</option>
        <option value="false" \${!c.enabled ? 'selected' : ''}>禁用</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group"><label>优先级</label><input id="mChPri" type="number" value="\${c.priority}"></div>
      <div class="form-group"><label>权重</label><input id="mChWeight" type="number" value="\${c.weight}"></div>
    </div>
    <div class="form-group"><label>支持模型</label><input id="mChModels" value="\${(c.models||[]).join(',')}"></div>
    <div class="form-group"><label>最大并发（0=不限）</label><input id="mChMax" type="number" value="\${c.maxConcurrent||0}"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="updateChannel('\${id}')">保存</button>
    </div>\`);
}

async function updateChannel(id) {
  try {
    const d = await apiJson('/api/channels/' + id, {method: 'PUT', body: JSON.stringify({
      name: document.getElementById('mChName').value,
      baseUrl: document.getElementById('mChUrl').value,
      enabled: document.getElementById('mChEnabled').value === 'true',
      priority: parseInt(document.getElementById('mChPri').value) || 0,
      weight: parseInt(document.getElementById('mChWeight').value) || 10,
      models: document.getElementById('mChModels').value.split(',').map(s => s.trim()).filter(Boolean),
      maxConcurrent: parseInt(document.getElementById('mChMax').value) || 0,
    })});
    if (d?.success) { closeModal(); toast('已更新', 'success'); loadChannels(); }
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteChannel(id) {
  if (!confirm('确认删除此渠道？')) return;
  try { await apiJson('/api/channels/' + id, {method: 'DELETE'}); toast('已删除', 'success'); loadChannels(); }
  catch(e) { toast(e.message, 'error'); }
}

async function checkChannels() {
  toast('检测中...', 'info');
  try { await apiJson('/api/channels/check', {method: 'POST'}); loadChannels(); toast('检测完成', 'success'); }
  catch(e) { toast(e.message, 'error'); }
}

async function resetChannels() {
  try { await apiJson('/api/channels/reset-health', {method: 'POST'}); loadChannels(); toast('已重置', 'success'); }
  catch(e) { toast(e.message, 'error'); }
}

// ===================== Logs =====================
async function loadLogs() {
  const type = document.getElementById('logType')?.value || '';
  const level = document.getElementById('logLevel')?.value || '';
  try {
    const d = await apiJson('/api/logs?limit=300' + (type ? '&type=' + type : '') + (level ? '&level=' + level : ''));
    if (!d) return;
    allLogs = d.logs;
    renderLogs();
  } catch(e) { toast(e.message, 'error'); }
}

function filterLogs() { renderLogs(); }

function renderLogs() {
  const q = (document.getElementById('logSearch')?.value || '').toLowerCase();
  let logs = allLogs;
  if (q) logs = logs.filter(l => {
    const str = JSON.stringify(l).toLowerCase();
    return str.includes(q);
  });
  const container = document.getElementById('logList');
  if (logs.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无日志记录</p></div>';
    return;
  }
  container.innerHTML = logs.map(l => {
    const lvl = (l.level || l.type || 'info').toLowerCase();
    const comp = l.component || l.action || l.type || '';
    const msg = l.message || l.endpoint || (l.type === 'request' ? \`\${l.endpoint} [\${l.model}] \${l.duration}ms\` : JSON.stringify(l).substring(0, 200));
    const ts = (l.timestamp || '').substring(11, 19);
    const typeClass = l.type === 'request' ? 'log-type-request' : l.type === 'audit' ? 'log-type-audit' : '';
    return \`<div class="log-entry \${typeClass}">
      <span class="log-ts">\${ts}</span>
      <span class="log-lvl log-lvl-\${lvl}">\${lvl.toUpperCase()}</span>
      <span class="log-comp">\${esc(comp)}</span>
      <span class="log-msg">\${esc(String(msg))}</span>
    </div>\`;
  }).join('');
}

async function clearLogs() {
  if (!confirm('确认清空所有日志？')) return;
  try { await apiJson('/api/logs', {method: 'DELETE'}); allLogs = []; renderLogs(); toast('已清空', 'success'); }
  catch(e) { toast(e.message, 'error'); }
}

// ===================== Settings =====================
async function loadSettings() {
  try {
    const [d, cd] = await Promise.all([apiJson('/api/settings'), apiJson('/api/cache')]);
    if (!d) return;
    const ac = d.accessControl;
    document.getElementById('acMode').value = ac.mode;
    document.getElementById('acWhitelist').value = (ac.whitelist || []).join('\\n');
    document.getElementById('acBlacklist').value = (ac.blacklist || []).join('\\n');

    // Cache info
    if (cd) {
      document.getElementById('cacheInfo').innerHTML = \`
        <div style="display:grid;gap:12px">
          <div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-weight:500">Embeddings 缓存 <span class="badge badge-\${cd.enabled.embeddings?'green':'gray'}" style="font-size:10px">\${cd.enabled.embeddings?'开启':'关闭'}</span></span>
              <span style="color:var(--text2);font-size:12px">命中率: \${cd.embeddings.hitRate}</span>
            </div>
            <div class="usage-bar"><div class="usage-bar-fill" style="width:\${cd.embeddings.maxSize>0?Math.round(cd.embeddings.size/cd.embeddings.maxSize*100):0}%"></div></div>
            <div style="color:var(--text3);font-size:11px;margin-top:3px">\${cd.embeddings.size} / \${cd.embeddings.maxSize} 条目，命中 \${cd.embeddings.hits} 次</div>
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-weight:500">Chat 缓存 <span class="badge badge-\${cd.enabled.chat?'green':'gray'}" style="font-size:10px">\${cd.enabled.chat?'开启':'关闭'}</span></span>
              <span style="color:var(--text2);font-size:12px">命中率: \${cd.chat.hitRate}</span>
            </div>
            <div class="usage-bar"><div class="usage-bar-fill" style="width:\${cd.chat.maxSize>0?Math.round(cd.chat.size/cd.chat.maxSize*100):0}%"></div></div>
            <div style="color:var(--text3);font-size:11px;margin-top:3px">\${cd.chat.size} / \${cd.chat.maxSize} 条目，命中 \${cd.chat.hits} 次</div>
          </div>
        </div>\`;
    }

    // Rate limiter
    const rl = d.rateLimiter;
    document.getElementById('rlInfo').innerHTML = \`
      <div style="display:grid;gap:8px">
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--text2)">全局限速</span>
          <span>\${typeof rl.global==='string'?rl.global:rl.global.maxRequests+' req / '+Math.round(rl.global.windowMs/1000)+'s（'+rl.global.activeKeys+' 个活跃 key）'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--text2)">Per-IP 限速</span>
          <span>\${typeof rl.ip==='string'?rl.ip:rl.ip.maxRequests+' req / '+Math.round(rl.ip.windowMs/1000)+'s'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0">
          <span style="color:var(--text2)">Per-Token 限速</span>
          <span>\${typeof rl.token==='string'?rl.token:rl.token.maxRequests+' req / '+Math.round(rl.token.windowMs/1000)+'s'}</span>
        </div>
      </div>\`;

    // Env info
    if (d.env) {
      const envRows = [
        ['PORT', d.env.port], ['连接超时', d.env.connectTimeout + 'ms'],
        ['请求超时', d.env.requestTimeout + 'ms'], ['最大重试', d.env.maxRetries],
        ['日志级别', d.env.logLevel], ['文件日志', d.env.logToFile],
        ['健康检查间隔', d.env.healthCheckInterval + 's'],
        ['Embeddings缓存', String(d.env.cacheEmbeddings)], ['Chat缓存', String(d.env.cacheChat)],
      ];
      document.getElementById('envInfo').innerHTML = \`
        <p style="color:var(--text3);font-size:11px;margin-bottom:10px">运行时环境变量（只读，修改需重启）</p>
        <div style="display:grid;gap:6px">\${envRows.map(([k,v])=>\`
          <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)">
            <span style="color:var(--text2)">\${k}</span>
            <code style="font-family:var(--font-mono);font-size:11px;background:var(--surface2);padding:1px 6px;border-radius:3px">\${esc(String(v))}</code>
          </div>\`).join('')}
        </div>\`;
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function saveAccessControl() {
  const mode = document.getElementById('acMode').value;
  const wl = document.getElementById('acWhitelist').value.split('\\n').map(s => s.trim()).filter(Boolean);
  const bl = document.getElementById('acBlacklist').value.split('\\n').map(s => s.trim()).filter(Boolean);
  try {
    await apiJson('/api/settings/access-control', {method: 'POST', body: JSON.stringify({mode, whitelist: wl, blacklist: bl})});
    toast('访问控制已保存', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function clearCache() {
  try { await apiJson('/api/cache', {method: 'DELETE'}); toast('缓存已清空', 'success'); loadSettings(); }
  catch(e) { toast(e.message, 'error'); }
}

// ===================== Docs =====================
function updateDocUrls() {
  const base = location.origin + '/v1';
  const el = document.getElementById('docApiUrl');
  if (el) el.value = base;
  const curlChat = document.getElementById('docCurlChat');
  if (curlChat) curlChat.textContent = \`curl \${base}/chat/completions \\\\
  -H "Content-Type: application/json" \\\\
  -H "Authorization: Bearer sk-o2o-your-token" \\\\
  -d '{
    "model": "llama3.2",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": false
  }'\`;
  const curlEmbed = document.getElementById('docCurlEmbed');
  if (curlEmbed) curlEmbed.textContent = \`curl \${base}/embeddings \\\\
  -H "Content-Type: application/json" \\\\
  -d '{
    "model": "nomic-embed-text",
    "input": "Hello world"
  }'\`;
}

// ===================== Mobile Sidebar =====================
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

// ===================== Modal =====================
function showModal(html) {
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('modalOverlay').style.display = 'flex';
  // Focus first input
  setTimeout(() => {
    const inp = document.getElementById('modalContent').querySelector('input,textarea,select');
    if (inp) inp.focus();
  }, 100);
}

function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
  document.getElementById('modalContent').innerHTML = '';
}

// Close modal with Escape
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ===================== Toast =====================
function toast(msg, type = 'success') {
  const icons = {success: '✓', error: '✕', info: 'ℹ', warn: '⚠'};
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.innerHTML = \`<span>\${icons[type]||'•'}</span><span>\${esc(msg)}</span>\`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut .3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, type === 'error' ? 4500 : 2800);
}

// ===================== Clipboard =====================
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'success');
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:-999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制', 'success');
  }
}

// ===================== Helpers =====================
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtNum(n) {
  if (n === null || n === undefined) return '0';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtUptime(secs) {
  if (secs < 60) return secs + 's';
  if (secs < 3600) return Math.floor(secs/60) + 'm';
  if (secs < 86400) return Math.floor(secs/3600) + 'h ' + Math.floor((secs%3600)/60) + 'm';
  return Math.floor(secs/86400) + 'd ' + Math.floor((secs%86400)/3600) + 'h';
}

function timeSince(isoStr) {
  const secs = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (secs < 60) return secs + '秒前';
  if (secs < 3600) return Math.floor(secs/60) + '分钟前';
  if (secs < 86400) return Math.floor(secs/3600) + '小时前';
  return Math.floor(secs/86400) + '天前';
}
</script>
</body></html>`;
}

export default router;
