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
    // BUG FIX: Return a hashed session token instead of the plaintext password
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
  const keys = await keyStore.checkAllHealth();
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
    limit: parseInt(limit || '100'),
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
  });
});

router.post('/api/settings/access-control', (req, res) => {
  const { mode, whitelist, blacklist } = req.body;
  if (mode) accessControl.setMode(mode);
  if (whitelist) {
    // Replace whitelist
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
// Admin Panel HTML (embedded)
// ============================================
function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ollama2OpenAI Enterprise Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f1117;--surface:#1a1d27;--surface2:#242734;--border:#2d3145;--text:#e4e4e7;--text2:#9ca3af;--primary:#6366f1;--primary-hover:#818cf8;--success:#22c55e;--danger:#ef4444;--warning:#f59e0b;--info:#3b82f6;--radius:10px}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.container{max-width:1400px;margin:0 auto;padding:20px}
.header{display:flex;justify-content:space-between;align-items:center;padding:16px 0;border-bottom:1px solid var(--border);margin-bottom:20px}
.header h1{font-size:22px;font-weight:700;background:linear-gradient(135deg,#6366f1,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .version{font-size:11px;color:var(--text2);margin-left:8px;background:var(--surface2);padding:2px 8px;border-radius:4px}
.header-right{display:flex;align-items:center;gap:10px}
.login-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:100}
.login-box{background:var(--surface);padding:40px;border-radius:var(--radius);width:380px}
.login-box h2{margin-bottom:20px;text-align:center}
.tabs{display:flex;gap:2px;border-bottom:2px solid var(--border);margin-bottom:20px}
.tab{padding:10px 20px;cursor:pointer;color:var(--text2);font-size:13px;font-weight:500;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .15s}
.tab:hover{color:var(--text)}
.tab.active{color:var(--primary);border-bottom-color:var(--primary)}
.tab-content{display:none}.tab-content.active{display:block}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
.stat-card .label{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.stat-card .value{font-size:24px;font-weight:700}
.stat-card .sub{font-size:11px;color:var(--text2);margin-top:2px}
.green{color:var(--success)}.red{color:var(--danger)}.yellow{color:var(--warning)}.blue{color:var(--info)}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:20px}
.panel-header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border)}
.panel-header h3{font-size:15px;font-weight:600}
.panel-body{padding:18px}
.btn{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border:none;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:var(--primary);color:#fff}.btn-primary:hover:not(:disabled){background:var(--primary-hover)}
.btn-danger{background:var(--danger);color:#fff}.btn-danger:hover:not(:disabled){opacity:.85}
.btn-success{background:var(--success);color:#fff}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}.btn-outline:hover:not(:disabled){border-color:var(--primary);color:var(--primary)}
.btn-sm{padding:3px 8px;font-size:11px}
.btn-group{display:flex;gap:6px;flex-wrap:wrap}
input,textarea,select{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text);font-size:13px;width:100%;outline:none;transition:border-color .15s}
input:focus,textarea:focus,select:focus{border-color:var(--primary)}
textarea{resize:vertical;min-height:100px;font-family:monospace;font-size:12px}
select{appearance:auto}
label{display:block;font-size:12px;font-weight:500;margin-bottom:4px;color:var(--text2)}
.form-group{margin-bottom:12px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.tbl{width:100%;border-collapse:collapse}
.tbl th{text-align:left;padding:8px 12px;font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)}
.tbl td{padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px}
.tbl tr:hover{background:var(--surface2)}
.mono{font-family:monospace;font-size:11px}
.badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600}
.badge-green{background:rgba(34,197,94,.15);color:var(--success)}
.badge-red{background:rgba(239,68,68,.15);color:var(--danger)}
.badge-yellow{background:rgba(245,158,11,.15);color:var(--warning)}
.badge-gray{background:rgba(156,163,175,.15);color:var(--text2)}
.badge-blue{background:rgba(59,130,246,.15);color:var(--info)}
.dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.toast{position:fixed;top:16px;right:16px;padding:10px 18px;border-radius:8px;color:#fff;font-size:13px;z-index:1000;animation:si .3s ease;max-width:380px;word-break:break-word}
.toast-success{background:var(--success)}.toast-error{background:var(--danger)}
@keyframes si{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
.log-entry{padding:6px 10px;border-bottom:1px solid var(--border);font-size:11px;font-family:monospace;display:flex;gap:8px}
.log-entry .ts{color:var(--text2);min-width:170px}
.log-entry .lvl{min-width:50px;font-weight:600}
.log-entry .comp{color:var(--info);min-width:80px}
.log-entry .msg{flex:1;word-break:break-all}
.overflow-x{overflow-x:auto}
.hidden{display:none!important}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:200}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px;width:500px;max-width:90vw;max-height:80vh;overflow-y:auto}
.modal h3{margin-bottom:16px}
@media(max-width:768px){.stats-grid{grid-template-columns:repeat(2,1fr)}.header{flex-direction:column;gap:8px;align-items:flex-start}.form-row{grid-template-columns:1fr}.tabs{overflow-x:auto}}
</style>
</head>
<body>
<div id="loginOverlay" class="login-overlay">
<div class="login-box"><h2>Ollama2OpenAI Enterprise</h2>
<div class="form-group"><label>Admin Password</label><input type="password" id="loginPassword" placeholder="Enter admin password" onkeydown="if(event.key==='Enter')doLogin()"></div>
<button class="btn btn-primary" style="width:100%" onclick="doLogin()">Login</button></div></div>

<div id="app" class="container hidden">
<div class="header">
<div style="display:flex;align-items:center;gap:8px"><h1>Ollama2OpenAI</h1><span class="version">v3.0 Enterprise</span></div>
<div class="header-right">
<span style="font-size:12px;color:var(--text2)">API: <code id="apiEndpoint" style="font-size:11px"></code></span>
<button class="btn btn-outline btn-sm" onclick="loadTab()">Refresh</button>
<button class="btn btn-outline btn-sm" onclick="doLogout()">Logout</button>
</div></div>

<div class="tabs" id="tabs">
<div class="tab active" data-tab="dashboard">Dashboard</div>
<div class="tab" data-tab="keys">Keys</div>
<div class="tab" data-tab="tokens">Tokens</div>
<div class="tab" data-tab="channels">Channels</div>
<div class="tab" data-tab="logs">Logs</div>
<div class="tab" data-tab="settings">Settings</div>
</div>

<!-- Dashboard Tab -->
<div class="tab-content active" id="tab-dashboard">
<div class="stats-grid" id="dashStats"></div>
<div class="panel"><div class="panel-header"><h3>Usage (Last 7 Days)</h3></div>
<div class="panel-body" id="usageChart" style="font-size:12px;color:var(--text2)">Loading...</div></div>
<div class="panel"><div class="panel-header"><h3>System</h3></div>
<div class="panel-body" id="sysInfo" style="font-size:12px;color:var(--text2)">Loading...</div></div>
</div>

<!-- Keys Tab -->
<div class="tab-content" id="tab-keys">
<div class="panel"><div class="panel-header"><h3>Import Keys</h3>
<div class="btn-group"><button class="btn btn-outline btn-sm" onclick="checkAllHealth()">Check All</button><button class="btn btn-outline btn-sm" onclick="resetHealth()">Reset Health</button><button class="btn btn-danger btn-sm" onclick="clearAllKeys()">Clear All</button></div></div>
<div class="panel-body">
<div class="form-row"><div class="form-group"><label>Default Base URL</label><input id="defaultBaseUrl" placeholder="https://ollama.com/api"></div><div></div></div>
<div class="form-group"><label>Keys (one per line)</label><textarea id="batchKeys" placeholder="sk-xxx\\nhttps://api.example.com|sk-xxx"></textarea></div>
<button class="btn btn-primary" onclick="batchImport()">Batch Import</button>
<span id="importResult" style="margin-left:12px;font-size:12px"></span>
</div></div>
<div class="panel"><div class="panel-header"><h3>API Keys</h3><span id="keyCount" style="color:var(--text2);font-size:12px"></span></div>
<div class="panel-body overflow-x"><table class="tbl"><thead><tr><th>Status</th><th>Key</th><th>URL</th><th>W</th><th>P</th><th>Reqs</th><th>Fail</th><th>Tokens</th><th>Last Used</th><th>Actions</th></tr></thead>
<tbody id="keysBody"></tbody></table>
<div id="noKeys" class="hidden" style="text-align:center;padding:30px;color:var(--text2)">No keys. Import above.</div></div></div>
</div>

<!-- Tokens Tab -->
<div class="tab-content" id="tab-tokens">
<div class="panel"><div class="panel-header"><h3>API Tokens</h3><button class="btn btn-primary btn-sm" onclick="showCreateToken()">Create Token</button></div>
<div class="panel-body overflow-x"><table class="tbl"><thead><tr><th>Name</th><th>Token</th><th>Status</th><th>Requests</th><th>Tokens Used</th><th>Quota</th><th>Last Used</th><th>Actions</th></tr></thead>
<tbody id="tokensBody"></tbody></table>
<div id="noTokens" class="hidden" style="text-align:center;padding:30px;color:var(--text2)">No API tokens created. Use legacy API_TOKEN or create tokens above.</div></div></div>
</div>

<!-- Channels Tab -->
<div class="tab-content" id="tab-channels">
<div class="panel"><div class="panel-header"><h3>Channels</h3>
<div class="btn-group"><button class="btn btn-primary btn-sm" onclick="showCreateChannel()">Create Channel</button><button class="btn btn-outline btn-sm" onclick="checkChannels()">Check All</button></div></div>
<div class="panel-body overflow-x"><table class="tbl"><thead><tr><th>Name</th><th>Status</th><th>Priority</th><th>Weight</th><th>Keys</th><th>Models</th><th>Reqs</th><th>Tokens</th><th>Actions</th></tr></thead>
<tbody id="channelsBody"></tbody></table>
<div id="noChannels" class="hidden" style="text-align:center;padding:30px;color:var(--text2)">No channels. Keys from the Keys tab are used directly.</div></div></div>
</div>

<!-- Logs Tab -->
<div class="tab-content" id="tab-logs">
<div class="panel"><div class="panel-header"><h3>Recent Logs</h3>
<div class="btn-group"><select id="logFilter" style="width:120px" onchange="loadLogs()"><option value="">All</option><option value="request">Requests</option><option value="audit">Audit</option></select>
<button class="btn btn-outline btn-sm" onclick="loadLogs()">Refresh</button><button class="btn btn-danger btn-sm" onclick="clearLogs()">Clear</button></div></div>
<div class="panel-body" style="max-height:500px;overflow-y:auto;padding:0" id="logsContainer">Loading...</div></div>
</div>

<!-- Settings Tab -->
<div class="tab-content" id="tab-settings">
<div class="panel"><div class="panel-header"><h3>IP Access Control</h3></div>
<div class="panel-body">
<div class="form-group"><label>Mode</label><select id="acMode"><option value="disabled">Disabled</option><option value="whitelist">Whitelist</option><option value="blacklist">Blacklist</option></select></div>
<div class="form-row">
<div class="form-group"><label>Whitelist (one IP per line)</label><textarea id="acWhitelist" rows="4"></textarea></div>
<div class="form-group"><label>Blacklist (one IP per line)</label><textarea id="acBlacklist" rows="4"></textarea></div>
</div>
<button class="btn btn-primary" onclick="saveAccessControl()">Save Access Control</button>
</div></div>
<div class="panel"><div class="panel-header"><h3>Cache</h3><button class="btn btn-outline btn-sm" onclick="clearCache()">Clear Cache</button></div>
<div class="panel-body" id="cacheInfo" style="font-size:12px;color:var(--text2)">Loading...</div></div>
<div class="panel"><div class="panel-header"><h3>Rate Limiting</h3></div>
<div class="panel-body" id="rlInfo" style="font-size:12px;color:var(--text2)">Loading...</div></div>
</div>
</div>

<div id="modalOverlay" class="modal-overlay hidden" onclick="if(event.target===this)closeModal()">
<div class="modal" id="modalContent"></div></div>

<script>
let TOKEN=localStorage.getItem('admin_token')||'';
let currentTab='dashboard';

if(TOKEN){apiFetch('/api/keys').then(r=>{if(r.ok)showApp();else showLogin()}).catch(()=>showLogin())}else showLogin();

function showLogin(){document.getElementById('loginOverlay').classList.remove('hidden');document.getElementById('app').classList.add('hidden')}
function showApp(){document.getElementById('loginOverlay').classList.add('hidden');document.getElementById('app').classList.remove('hidden');document.getElementById('apiEndpoint').textContent=location.origin+'/v1';loadTab()}

async function doLogin(){const pw=document.getElementById('loginPassword').value;if(!pw)return toast('Enter password','error');
try{const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});const d=await r.json();
if(d.success){TOKEN=d.token;localStorage.setItem('admin_token',TOKEN);showApp()}else toast('Wrong password','error')}catch(e){toast('Login failed','error')}}

function doLogout(){TOKEN='';localStorage.removeItem('admin_token');showLogin()}
function authHeaders(){return{'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'}}
async function apiFetch(path,opts={}){return fetch('/admin'+path,{headers:authHeaders(),...opts})}
async function apiJson(path,opts={}){const r=await apiFetch(path,opts);if(r.status===401){doLogout();return null}return r.json()}

// Tabs
document.getElementById('tabs').addEventListener('click',e=>{const t=e.target.closest('.tab');if(!t)return;
document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');
document.querySelectorAll('.tab-content').forEach(x=>x.classList.remove('active'));
currentTab=t.dataset.tab;document.getElementById('tab-'+currentTab).classList.add('active');loadTab()});

function loadTab(){
if(currentTab==='dashboard')loadDashboard();
else if(currentTab==='keys')loadKeys();
else if(currentTab==='tokens')loadTokens();
else if(currentTab==='channels')loadChannels();
else if(currentTab==='logs')loadLogs();
else if(currentTab==='settings')loadSettings();
}

// Dashboard
async function loadDashboard(){
const d=await apiJson('/api/dashboard');if(!d)return;
const s=d.keys,c=d.channels,t=d.tokens,m=d.metrics;
document.getElementById('dashStats').innerHTML=
'<div class="stat-card"><div class="label">Keys</div><div class="value green">'+s.healthy+'</div><div class="sub">'+s.total+' total, '+s.unhealthy+' unhealthy</div></div>'+
'<div class="stat-card"><div class="label">Channels</div><div class="value blue">'+c.healthy+'</div><div class="sub">'+c.total+' total</div></div>'+
'<div class="stat-card"><div class="label">API Tokens</div><div class="value">'+t.enabled+'</div><div class="sub">'+t.total+' total</div></div>'+
'<div class="stat-card"><div class="label">Total Requests</div><div class="value">'+(m.requests||0)+'</div><div class="sub">'+m.activeConnections+' active</div></div>'+
'<div class="stat-card"><div class="label">Active Streams</div><div class="value blue">'+(m.activeStreams||0)+'</div></div>'+
'<div class="stat-card"><div class="label">Cache</div><div class="value">'+(d.cache.totalItems||0)+'</div><div class="sub">items cached</div></div>'+
'<div class="stat-card"><div class="label">Memory</div><div class="value">'+m.memory.heapUsed+'</div><div class="sub">MB heap used</div></div>'+
'<div class="stat-card"><div class="label">Uptime</div><div class="value">'+Math.floor(m.uptime/3600)+'h</div><div class="sub">'+Math.floor(m.uptime/60)+'m total</div></div>';

const usage=d.usage||{};const dates=Object.keys(usage).sort();
let html='<table class="tbl"><thead><tr><th>Date</th><th>Requests</th><th>Prompt Tokens</th><th>Completion Tokens</th><th>Total</th></tr></thead><tbody>';
dates.forEach(dt=>{const u=usage[dt];html+='<tr><td>'+esc(dt)+'</td><td>'+u.requests+'</td><td>'+u.promptTokens+'</td><td>'+u.completionTokens+'</td><td>'+(u.promptTokens+u.completionTokens)+'</td></tr>'});
html+='</tbody></table>';if(dates.length===0)html='<div style="color:var(--text2);padding:20px;text-align:center">No usage data yet</div>';
document.getElementById('usageChart').innerHTML=html;
document.getElementById('sysInfo').innerHTML='<div>Uptime: '+Math.floor(m.uptime/60)+' min | Memory: RSS='+m.memory.rss+'MB Heap='+m.memory.heapUsed+'/'+m.memory.heapTotal+'MB | Rate Limit: '+(typeof d.rateLimiter.global==='string'?'disabled':'active')+' | IP Access: '+d.accessControl.mode+'</div>';
}

// Keys
async function loadKeys(){
const d=await apiJson('/api/keys');if(!d)return;
const keys=d.keys,s=d.summary;
document.getElementById('keyCount').textContent=keys.length+' keys';
if(keys.length===0){document.getElementById('keysBody').innerHTML='';document.getElementById('noKeys').classList.remove('hidden');return}
document.getElementById('noKeys').classList.add('hidden');
document.getElementById('keysBody').innerHTML=keys.map(k=>{
const st=!k.enabled?'<span class="badge badge-gray">Disabled</span>':k.healthy?'<span class="badge badge-green">Healthy</span>':'<span class="badge badge-red">Unhealthy</span>';
const lu=k.lastUsed?new Date(k.lastUsed).toLocaleString():'-';
const bu=k.baseUrl.length>30?k.baseUrl.substring(0,30)+'...':k.baseUrl;
return '<tr><td>'+st+'</td><td class="mono">'+esc(k.key)+'</td><td class="mono" title="'+esc(k.baseUrl)+'">'+esc(bu)+'</td><td>'+(k.weight||10)+'</td><td>'+(k.priority||0)+'</td><td>'+k.totalRequests+'</td><td>'+(k.failedRequests||0)+'</td><td>'+(k.totalTokens||0)+'</td><td>'+lu+'</td><td><div class="btn-group"><button class="btn btn-outline btn-sm" onclick="toggleKey(\\''+k.id+'\\')">'+
(k.enabled?'Disable':'Enable')+'</button><button class="btn btn-outline btn-sm" onclick="checkKey(\\''+k.id+'\\')">Check</button><button class="btn btn-danger btn-sm" onclick="removeKey(\\''+k.id+'\\')">Del</button></div></td></tr>'}).join('')}

async function batchImport(){const keys=document.getElementById('batchKeys').value.trim();const baseUrl=document.getElementById('defaultBaseUrl').value.trim()||undefined;if(!keys)return toast('Enter keys','error');
const d=await apiJson('/api/keys/batch',{method:'POST',body:JSON.stringify({keys,baseUrl})});if(!d)return;
toast('Added:'+d.added.length+' Dup:'+d.duplicates.length+' Err:'+d.errors.length,'success');document.getElementById('batchKeys').value='';loadKeys()}

async function removeKey(id){if(!confirm('Remove this key?'))return;await apiFetch('/api/keys/'+id,{method:'DELETE'});loadKeys();toast('Removed','success')}
async function toggleKey(id){await apiFetch('/api/keys/'+id+'/toggle',{method:'POST'});loadKeys()}
async function checkKey(id){toast('Checking...','success');await apiFetch('/api/keys/'+id+'/check',{method:'POST'});loadKeys();toast('Done','success')}
async function checkAllHealth(){toast('Checking...','success');await apiFetch('/api/keys/check',{method:'POST'});loadKeys();toast('Done','success')}
async function resetHealth(){await apiFetch('/api/keys/reset-health',{method:'POST'});loadKeys();toast('Reset','success')}
async function clearAllKeys(){if(!confirm('Remove ALL keys?'))return;await apiFetch('/api/keys',{method:'DELETE'});loadKeys();toast('Cleared','success')}

// Tokens
async function loadTokens(){
const d=await apiJson('/api/tokens');if(!d)return;
const tokens=d.tokens;
if(tokens.length===0){document.getElementById('tokensBody').innerHTML='';document.getElementById('noTokens').classList.remove('hidden');return}
document.getElementById('noTokens').classList.add('hidden');
document.getElementById('tokensBody').innerHTML=tokens.map(t=>{
const st=!t.enabled?'<span class="badge badge-gray">Disabled</span>':(t.expiresAt&&new Date(t.expiresAt)<new Date())?'<span class="badge badge-red">Expired</span>':'<span class="badge badge-green">Active</span>';
const quota=t.quotaLimit?t.quotaUsed+'/'+t.quotaLimit:'Unlimited';
const lu=t.lastUsed?new Date(t.lastUsed).toLocaleString():'-';
return '<tr><td>'+esc(t.name)+'</td><td class="mono">'+esc(t.token)+'</td><td>'+st+'</td><td>'+t.totalRequests+'</td><td>'+t.totalTokens+'</td><td>'+quota+'</td><td>'+lu+'</td><td><div class="btn-group"><button class="btn btn-outline btn-sm" onclick="editToken(\\''+t.id+'\\')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteToken(\\''+t.id+'\\')">Del</button></div></td></tr>'}).join('')}

function showCreateToken(){
document.getElementById('modalContent').innerHTML='<h3>Create API Token</h3>'+
'<div class="form-group"><label>Name</label><input id="mTokName" value="API Token"></div>'+
'<div class="form-row"><div class="form-group"><label>Quota (tokens/month, 0=unlimited)</label><input id="mTokQuota" type="number" value="0"></div>'+
'<div class="form-group"><label>Rate Limit (req/min, 0=default)</label><input id="mTokRate" type="number" value="0"></div></div>'+
'<div class="form-group"><label>Allowed Models (comma separated, empty=all)</label><input id="mTokModels" placeholder="llama3.2,deepseek-r1"></div>'+
'<div class="form-group"><label>Expires At (optional)</label><input id="mTokExpires" type="datetime-local"></div>'+
'<div class="btn-group" style="margin-top:16px"><button class="btn btn-primary" onclick="createToken()">Create</button><button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>';
document.getElementById('modalOverlay').classList.remove('hidden')}

async function createToken(){
const name=document.getElementById('mTokName').value;const quota=parseInt(document.getElementById('mTokQuota').value)||null;
const rate=parseInt(document.getElementById('mTokRate').value)||null;const models=document.getElementById('mTokModels').value.split(',').map(s=>s.trim()).filter(Boolean);
const exp=document.getElementById('mTokExpires').value;
const d=await apiJson('/api/tokens',{method:'POST',body:JSON.stringify({name,quotaLimit:quota,rateLimit:rate,allowedModels:models,expiresAt:exp||null})});
if(d&&d.success){closeModal();toast('Token created: '+d.token.token,'success');loadTokens()}}

async function editToken(id){const d=await apiJson('/api/tokens');if(!d)return;const t=d.tokens.find(x=>x.id===id);if(!t)return;
document.getElementById('modalContent').innerHTML='<h3>Edit Token: '+esc(t.name)+'</h3>'+
'<div class="form-group"><label>Name</label><input id="mTokName" value="'+esc(t.name)+'"></div>'+
'<div class="form-group"><label>Enabled</label><select id="mTokEnabled"><option value="true"'+(t.enabled?' selected':'')+'>Yes</option><option value="false"'+(!t.enabled?' selected':'')+'>No</option></select></div>'+
'<div class="form-row"><div class="form-group"><label>Quota Limit</label><input id="mTokQuota" type="number" value="'+(t.quotaLimit||0)+'"></div>'+
'<div class="form-group"><label>Rate Limit</label><input id="mTokRate" type="number" value="'+(t.rateLimit||0)+'"></div></div>'+
'<div class="form-group"><label>Allowed Models</label><input id="mTokModels" value="'+(t.allowedModels||[]).join(',')+'"></div>'+
'<div class="btn-group" style="margin-top:16px"><button class="btn btn-primary" onclick="updateToken(\\''+id+'\\')">Save</button><button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>';
document.getElementById('modalOverlay').classList.remove('hidden')}

async function updateToken(id){
const d=await apiJson('/api/tokens/'+id,{method:'PUT',body:JSON.stringify({name:document.getElementById('mTokName').value,
enabled:document.getElementById('mTokEnabled').value==='true',quotaLimit:parseInt(document.getElementById('mTokQuota').value)||null,
rateLimit:parseInt(document.getElementById('mTokRate').value)||null,allowedModels:document.getElementById('mTokModels').value.split(',').map(s=>s.trim()).filter(Boolean)})});
if(d&&d.success){closeModal();toast('Updated','success');loadTokens()}}

async function deleteToken(id){if(!confirm('Delete this token?'))return;await apiFetch('/api/tokens/'+id,{method:'DELETE'});loadTokens();toast('Deleted','success')}

// Channels
async function loadChannels(){
const d=await apiJson('/api/channels');if(!d)return;
const chs=d.channels;
if(chs.length===0){document.getElementById('channelsBody').innerHTML='';document.getElementById('noChannels').classList.remove('hidden');return}
document.getElementById('noChannels').classList.add('hidden');
document.getElementById('channelsBody').innerHTML=chs.map(c=>{
const st=!c.enabled?'<span class="badge badge-gray">Disabled</span>':c.healthy?'<span class="badge badge-green">Healthy</span>':'<span class="badge badge-red">Unhealthy</span>';
return '<tr><td>'+esc(c.name)+'</td><td>'+st+'</td><td>'+c.priority+'</td><td>'+c.weight+'</td><td>'+c.keys.length+'</td><td>'+(c.models.length||'All')+'</td><td>'+c.totalRequests+'</td><td>'+c.totalTokens+'</td><td><div class="btn-group"><button class="btn btn-outline btn-sm" onclick="editChannel(\\''+c.id+'\\')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteChannel(\\''+c.id+'\\')">Del</button></div></td></tr>'}).join('')}

function showCreateChannel(){
document.getElementById('modalContent').innerHTML='<h3>Create Channel</h3>'+
'<div class="form-group"><label>Name</label><input id="mChName" value="New Channel"></div>'+
'<div class="form-group"><label>Base URL</label><input id="mChUrl" value="https://ollama.com/api"></div>'+
'<div class="form-group"><label>Keys (one per line)</label><textarea id="mChKeys" rows="4"></textarea></div>'+
'<div class="form-row"><div class="form-group"><label>Priority</label><input id="mChPri" type="number" value="0"></div>'+
'<div class="form-group"><label>Weight</label><input id="mChWeight" type="number" value="10"></div></div>'+
'<div class="form-group"><label>Models (comma separated, empty=all)</label><input id="mChModels" placeholder="llama3.2,deepseek-r1"></div>'+
'<div class="form-group"><label>Model Mapping (JSON, e.g. {"gpt-4":"llama3.2:70b"})</label><input id="mChMapping" placeholder="{}"></div>'+
'<div class="form-group"><label>Max Concurrent (0=unlimited)</label><input id="mChMax" type="number" value="0"></div>'+
'<div class="btn-group" style="margin-top:16px"><button class="btn btn-primary" onclick="createChannel()">Create</button><button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>';
document.getElementById('modalOverlay').classList.remove('hidden')}

async function createChannel(){
let mapping={};try{mapping=JSON.parse(document.getElementById('mChMapping').value||'{}')}catch{}
const d=await apiJson('/api/channels',{method:'POST',body:JSON.stringify({name:document.getElementById('mChName').value,
baseUrl:document.getElementById('mChUrl').value,keys:document.getElementById('mChKeys').value.split('\\n').map(s=>s.trim()).filter(Boolean),
priority:parseInt(document.getElementById('mChPri').value)||0,weight:parseInt(document.getElementById('mChWeight').value)||10,
models:document.getElementById('mChModels').value.split(',').map(s=>s.trim()).filter(Boolean),modelMapping:mapping,
maxConcurrent:parseInt(document.getElementById('mChMax').value)||0})});
if(d&&d.success){closeModal();toast('Channel created','success');loadChannels()}}

async function editChannel(id){const d=await apiJson('/api/channels');if(!d)return;const c=d.channels.find(x=>x.id===id);if(!c)return;
document.getElementById('modalContent').innerHTML='<h3>Edit: '+esc(c.name)+'</h3>'+
'<div class="form-group"><label>Name</label><input id="mChName" value="'+esc(c.name)+'"></div>'+
'<div class="form-group"><label>Base URL</label><input id="mChUrl" value="'+esc(c.baseUrl)+'"></div>'+
'<div class="form-group"><label>Enabled</label><select id="mChEnabled"><option value="true"'+(c.enabled?' selected':'')+'>Yes</option><option value="false"'+(!c.enabled?' selected':'')+'>No</option></select></div>'+
'<div class="form-row"><div class="form-group"><label>Priority</label><input id="mChPri" type="number" value="'+c.priority+'"></div>'+
'<div class="form-group"><label>Weight</label><input id="mChWeight" type="number" value="'+c.weight+'"></div></div>'+
'<div class="form-group"><label>Models</label><input id="mChModels" value="'+(c.models||[]).join(',')+'"></div>'+
'<div class="form-group"><label>Max Concurrent</label><input id="mChMax" type="number" value="'+(c.maxConcurrent||0)+'"></div>'+
'<div class="btn-group" style="margin-top:16px"><button class="btn btn-primary" onclick="updateChannel(\\''+id+'\\')">Save</button><button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>';
document.getElementById('modalOverlay').classList.remove('hidden')}

async function updateChannel(id){
const d=await apiJson('/api/channels/'+id,{method:'PUT',body:JSON.stringify({name:document.getElementById('mChName').value,
baseUrl:document.getElementById('mChUrl').value,enabled:document.getElementById('mChEnabled').value==='true',
priority:parseInt(document.getElementById('mChPri').value)||0,weight:parseInt(document.getElementById('mChWeight').value)||10,
models:document.getElementById('mChModels').value.split(',').map(s=>s.trim()).filter(Boolean),
maxConcurrent:parseInt(document.getElementById('mChMax').value)||0})});
if(d&&d.success){closeModal();toast('Updated','success');loadChannels()}}

async function deleteChannel(id){if(!confirm('Delete this channel?'))return;await apiFetch('/api/channels/'+id,{method:'DELETE'});loadChannels();toast('Deleted','success')}
async function checkChannels(){toast('Checking...','success');await apiFetch('/api/channels/check',{method:'POST'});loadChannels();toast('Done','success')}

// Logs
async function loadLogs(){
const type=document.getElementById('logFilter')?.value||'';
const d=await apiJson('/api/logs?limit=200'+(type?'&type='+type:''));if(!d)return;
const c=document.getElementById('logsContainer');
if(!d.logs||d.logs.length===0){c.innerHTML='<div style="padding:20px;text-align:center;color:var(--text2)">No logs</div>';return}
c.innerHTML=d.logs.map(l=>{
const lvlColor=l.level==='error'?'color:var(--danger)':l.level==='warn'?'color:var(--warning)':'color:var(--text2)';
return '<div class="log-entry"><span class="ts">'+(l.timestamp||'').substring(0,19)+'</span><span class="lvl" style="'+lvlColor+'">'+(l.level||l.type||'').toUpperCase()+'</span><span class="comp">'+(l.component||l.action||'')+'</span><span class="msg">'+esc(l.message||l.endpoint||JSON.stringify(l).substring(0,200))+'</span></div>'}).join('')}
async function clearLogs(){await apiFetch('/api/logs',{method:'DELETE'});loadLogs();toast('Cleared','success')}

// Settings
async function loadSettings(){
const d=await apiJson('/api/settings');if(!d)return;
const ac=d.accessControl;
document.getElementById('acMode').value=ac.mode;
document.getElementById('acWhitelist').value=(ac.whitelist||[]).join('\\n');
document.getElementById('acBlacklist').value=(ac.blacklist||[]).join('\\n');

// Cache
const cd=await apiJson('/api/cache');if(cd){
document.getElementById('cacheInfo').innerHTML=
'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'+
'<div><strong>Embeddings</strong> ('+(cd.enabled?.embeddings?'ON':'OFF')+')<br>Size:'+(cd.embeddings?.size||0)+'/'+(cd.embeddings?.maxSize||0)+' | Hits:'+(cd.embeddings?.hits||0)+' | Rate:'+(cd.embeddings?.hitRate||'0%')+'</div>'+
'<div><strong>Chat</strong> ('+(cd.enabled?.chat?'ON':'OFF')+')<br>Size:'+(cd.chat?.size||0)+'/'+(cd.chat?.maxSize||0)+' | Hits:'+(cd.chat?.hits||0)+' | Rate:'+(cd.chat?.hitRate||'0%')+'</div></div>'}

// Rate limiter
const rl=d.rateLimiter;
document.getElementById('rlInfo').innerHTML='Global: '+(typeof rl.global==='string'?rl.global:rl.global.maxRequests+' req/'+Math.round(rl.global.windowMs/1000)+'s ('+rl.global.activeKeys+' tracked)')+
' | Per-IP: '+(typeof rl.ip==='string'?rl.ip:rl.ip.maxRequests+' req/'+Math.round(rl.ip.windowMs/1000)+'s')+
' | Per-Token: '+(typeof rl.token==='string'?rl.token:rl.token.maxRequests+' req/'+Math.round(rl.token.windowMs/1000)+'s')}

async function saveAccessControl(){
const mode=document.getElementById('acMode').value;
const wl=document.getElementById('acWhitelist').value.split('\\n').map(s=>s.trim()).filter(Boolean);
const bl=document.getElementById('acBlacklist').value.split('\\n').map(s=>s.trim()).filter(Boolean);
await apiJson('/api/settings/access-control',{method:'POST',body:JSON.stringify({mode,whitelist:wl,blacklist:bl})});
toast('Saved','success')}
async function clearCache(){await apiFetch('/api/cache',{method:'DELETE'});loadSettings();toast('Cache cleared','success')}

function closeModal(){document.getElementById('modalOverlay').classList.add('hidden')}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function toast(m,t){const e=document.createElement('div');e.className='toast toast-'+(t||'success');e.textContent=m;document.body.appendChild(e);setTimeout(()=>e.remove(),3000)}
</script>
</body></html>`;
}

export default router;
