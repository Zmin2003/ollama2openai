/**
 * Admin API routes - key management, health checks, monitoring
 */
import { Router } from 'express';
import { createHmac } from 'crypto';
import keyStore from '../core/keyStore.js';
import cacheManager from '../core/cache.js';

const router = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

/**
 * Generate a session token from the admin password
 * This avoids sending/storing the plaintext password as a token
 */
function generateSessionToken() {
  return createHmac('sha256', 'ollama2openai-admin-salt')
    .update(ADMIN_PASSWORD)
    .digest('hex')
    .substring(0, 32);
}

const SESSION_TOKEN = generateSessionToken();

/**
 * Helper: consistently mask a key for display
 */
function maskKey(key) {
  if (!key) return '(empty)';
  if (key.length > 10) return key.substring(0, 6) + '***' + key.substring(key.length - 4);
  if (key.length > 4) return key.substring(0, 2) + '***';
  return '***';
}

// Auth middleware for admin routes
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const queryToken = req.query?.token;

  let token;
  if (authHeader) {
    // Case-insensitive Bearer extraction
    token = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.substring(7).trim()
      : authHeader.trim();
  }
  token = token || queryToken;

  // Login endpoint doesn't need auth
  if (req.path === '/login' && req.method === 'POST') return next();
  // Serve admin page without auth (auth is handled client-side)
  if (req.path === '/' && req.method === 'GET') return next();

  // Accept either the session token or the raw password for backwards compatibility
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
// Admin Panel HTML (embedded)
// ============================================
function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ollama2OpenAI Admin</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0f1117; --surface: #1a1d27; --surface2: #242734;
    --border: #2d3145; --text: #e4e4e7; --text2: #9ca3af;
    --primary: #6366f1; --primary-hover: #818cf8;
    --success: #22c55e; --danger: #ef4444; --warning: #f59e0b;
    --info: #3b82f6;
    --radius: 10px;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }

  /* Header */
  .header { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
  .header h1 { font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #6366f1, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .header .info { color: var(--text2); font-size: 13px; }
  .header-right { display: flex; align-items: center; gap: 12px; }

  /* Login */
  .login-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .login-box { background: var(--surface); padding: 40px; border-radius: var(--radius); width: 380px; }
  .login-box h2 { margin-bottom: 20px; text-align: center; }

  /* Cards */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
  .stat-card .label { font-size: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .stat-card .value { font-size: 28px; font-weight: 700; }
  .stat-card .value.green { color: var(--success); }
  .stat-card .value.red { color: var(--danger); }
  .stat-card .value.yellow { color: var(--warning); }
  .stat-card .value.blue { color: var(--info); }
  .stat-card .sub { font-size: 11px; color: var(--text2); margin-top: 4px; }

  /* Panels */
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 24px; }
  .panel-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); }
  .panel-header h2 { font-size: 16px; font-weight: 600; }
  .panel-body { padding: 20px; }

  /* Buttons */
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--primary); color: white; }
  .btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
  .btn-danger { background: var(--danger); color: white; }
  .btn-danger:hover:not(:disabled) { opacity: 0.85; }
  .btn-success { background: var(--success); color: white; }
  .btn-success:hover:not(:disabled) { opacity: 0.85; }
  .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .btn-outline:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .btn-group { display: flex; gap: 8px; flex-wrap: wrap; }

  /* Inputs */
  input, textarea, select { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; color: var(--text); font-size: 14px; width: 100%; outline: none; transition: border-color 0.15s; }
  input:focus, textarea:focus { border-color: var(--primary); }
  textarea { resize: vertical; min-height: 120px; font-family: monospace; font-size: 13px; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--text2); }
  .form-group { margin-bottom: 16px; }

  /* Toggle switch */
  .toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text2); cursor: pointer; }
  .toggle input { width: auto; display: none; }
  .toggle-slider { width: 36px; height: 20px; background: var(--border); border-radius: 10px; position: relative; transition: background 0.2s; }
  .toggle-slider::after { content: ''; width: 16px; height: 16px; background: white; border-radius: 50%; position: absolute; top: 2px; left: 2px; transition: transform 0.2s; }
  .toggle input:checked + .toggle-slider { background: var(--primary); }
  .toggle input:checked + .toggle-slider::after { transform: translateX(16px); }

  /* Table */
  .key-table { width: 100%; border-collapse: collapse; }
  .key-table th { text-align: left; padding: 10px 14px; font-size: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
  .key-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
  .key-table tr:hover { background: var(--surface2); }
  .key-table .mono { font-family: monospace; font-size: 12px; }

  /* Badges */
  .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-green { background: rgba(34,197,94,0.15); color: var(--success); }
  .badge-red { background: rgba(239,68,68,0.15); color: var(--danger); }
  .badge-yellow { background: rgba(245,158,11,0.15); color: var(--warning); }
  .badge-gray { background: rgba(156,163,175,0.15); color: var(--text2); }

  .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
  .dot-green { background: var(--success); }
  .dot-red { background: var(--danger); }
  .dot-gray { background: var(--text2); }

  /* Toast */
  .toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; font-size: 14px; z-index: 1000; animation: slideIn 0.3s ease; max-width: 400px; word-break: break-word; }
  .toast-success { background: var(--success); }
  .toast-error { background: var(--danger); }
  @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

  /* Responsive */
  .overflow-x { overflow-x: auto; }
  @media (max-width: 768px) {
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .header { flex-direction: column; gap: 10px; align-items: flex-start; }
    .btn-group { flex-direction: column; }
  }

  .hidden { display: none !important; }
  .loading { opacity: 0.6; pointer-events: none; }
</style>
</head>
<body>
<div id="loginOverlay" class="login-overlay">
  <div class="login-box">
    <h2>Ollama2OpenAI</h2>
    <div class="form-group">
      <label>Admin Password</label>
      <input type="password" id="loginPassword" placeholder="Enter admin password" onkeydown="if(event.key==='Enter')doLogin()">
    </div>
    <button class="btn btn-primary" style="width:100%" onclick="doLogin()">Login</button>
  </div>
</div>

<div id="app" class="container hidden">
  <div class="header">
    <div>
      <h1>Ollama2OpenAI Admin</h1>
      <div class="info">API Endpoint: <code id="apiEndpoint"></code></div>
    </div>
    <div class="header-right">
      <label class="toggle" title="Auto-refresh every 10s">
        <input type="checkbox" id="autoRefresh" onchange="toggleAutoRefresh()">
        <span class="toggle-slider"></span>
        Auto-refresh
      </label>
      <button class="btn btn-outline btn-sm" onclick="loadAll()">Refresh</button>
      <button class="btn btn-outline" onclick="doLogout()">Logout</button>
    </div>
  </div>

  <!-- Stats -->
  <div class="stats-grid" id="statsGrid">
    <div class="stat-card"><div class="label">Total Keys</div><div class="value" id="statTotal">0</div></div>
    <div class="stat-card"><div class="label">Healthy</div><div class="value green" id="statHealthy">0</div></div>
    <div class="stat-card"><div class="label">Unhealthy</div><div class="value red" id="statUnhealthy">0</div></div>
    <div class="stat-card"><div class="label">Disabled</div><div class="value yellow" id="statDisabled">0</div></div>
    <div class="stat-card"><div class="label">Cache Items</div><div class="value blue" id="statCacheItems">0</div><div class="sub" id="statCacheHitRate">-</div></div>
  </div>

  <!-- Import Panel -->
  <div class="panel">
    <div class="panel-header">
      <h2>Import Keys</h2>
      <div class="btn-group">
        <button class="btn btn-outline btn-sm" onclick="checkAllHealth()">Check All Health</button>
        <button class="btn btn-outline btn-sm" onclick="resetHealth()">Reset Health</button>
        <button class="btn btn-danger btn-sm" onclick="clearAll()">Clear All</button>
      </div>
    </div>
    <div class="panel-body">
      <div class="form-group">
        <label>Default Base URL (optional, for bare keys)</label>
        <input type="text" id="defaultBaseUrl" placeholder="https://ollama.com/api (default)">
      </div>
      <div class="form-group">
        <label>Keys (one per line, supports multiple formats. Lines starting with # are ignored.)</label>
        <textarea id="batchKeys" placeholder="Supported formats:
sk-xxxxxxxxxxxxxxxx
https://api.example.com|sk-xxxxxxxx
sk-xxxxxxxx|https://api.example.com
https://api.example.com#sk-xxxxxxxx
https://api.example.com/sk-xxxxxxxx"></textarea>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="batchImport()">Batch Import</button>
        <button class="btn btn-outline" onclick="addSingleKey()">Add Single Key</button>
      </div>
      <div id="importResult" style="margin-top:12px;font-size:13px;"></div>
    </div>
  </div>

  <!-- Cache Panel -->
  <div class="panel">
    <div class="panel-header">
      <h2>Cache</h2>
      <button class="btn btn-outline btn-sm" onclick="clearCache()">Clear Cache</button>
    </div>
    <div class="panel-body" id="cacheInfo" style="font-size:13px;color:var(--text2);">Loading...</div>
  </div>

  <!-- Keys Table -->
  <div class="panel">
    <div class="panel-header">
      <h2>API Keys</h2>
      <span id="keyCount" style="color:var(--text2);font-size:13px;"></span>
    </div>
    <div class="panel-body overflow-x">
      <table class="key-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Key</th>
            <th>Base URL</th>
            <th>Requests</th>
            <th>Failed</th>
            <th>Last Used</th>
            <th>Last Error</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="keysTableBody"></tbody>
      </table>
      <div id="noKeys" class="hidden" style="text-align:center;padding:40px;color:var(--text2);">No keys added yet. Import keys above.</div>
    </div>
  </div>
</div>

<script>
let TOKEN = localStorage.getItem('admin_token') || '';
let autoRefreshTimer = null;

// Check saved token
if (TOKEN) {
  fetchKeys().then(ok => {
    if (ok) showApp();
    else showLogin();
  }).catch(() => showLogin());
} else {
  showLogin();
}

function showLogin() {
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  stopAutoRefresh();
}

function showApp() {
  document.getElementById('loginOverlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('apiEndpoint').textContent = location.origin + '/v1';
  loadAll();
}

function loadAll() {
  loadKeys();
  loadCacheStats();
}

async function doLogin() {
  const pw = document.getElementById('loginPassword').value;
  if (!pw) return toast('Please enter password', 'error');
  try {
    const r = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const d = await r.json();
    if (d.success) {
      TOKEN = d.token;
      localStorage.setItem('admin_token', TOKEN);
      showApp();
    } else {
      toast('Wrong password', 'error');
    }
  } catch (e) {
    toast('Login failed: ' + e.message, 'error');
  }
}

function doLogout() {
  TOKEN = '';
  localStorage.removeItem('admin_token');
  stopAutoRefresh();
  showLogin();
}

function authHeaders() {
  return { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
}

async function fetchKeys() {
  try {
    const r = await fetch('/admin/api/keys', { headers: authHeaders() });
    if (!r.ok) return false;
    return true;
  } catch { return false; }
}

async function loadKeys() {
  try {
    const r = await fetch('/admin/api/keys', { headers: authHeaders() });
    if (!r.ok) { if (r.status === 401) { doLogout(); } return; }
    const d = await r.json();
    renderKeys(d.keys);
    renderStats(d.summary);
  } catch (e) {
    toast('Failed to load keys: ' + e.message, 'error');
  }
}

async function loadCacheStats() {
  try {
    const r = await fetch('/admin/api/cache', { headers: authHeaders() });
    if (!r.ok) return;
    const d = await r.json();
    renderCacheStats(d);
  } catch (e) { /* ignore */ }
}

function renderStats(s) {
  document.getElementById('statTotal').textContent = s.total;
  document.getElementById('statHealthy').textContent = s.healthy;
  document.getElementById('statUnhealthy').textContent = s.unhealthy;
  document.getElementById('statDisabled').textContent = s.disabled;
}

function renderCacheStats(c) {
  const totalItems = (c.totalItems || 0);
  document.getElementById('statCacheItems').textContent = totalItems;

  const embHits = c.embeddings?.hits || 0;
  const embMisses = c.embeddings?.misses || 0;
  const chatHits = c.chat?.hits || 0;
  const chatMisses = c.chat?.misses || 0;
  const totalReqs = embHits + embMisses + chatHits + chatMisses;
  const totalHits = embHits + chatHits;
  const hitRate = totalReqs > 0 ? ((totalHits / totalReqs) * 100).toFixed(1) + '%' : '-';
  document.getElementById('statCacheHitRate').textContent = 'Hit rate: ' + hitRate;

  const info = document.getElementById('cacheInfo');
  info.innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">' +
      '<div><strong>Embeddings</strong> (' + (c.enabled?.embeddings ? 'ON' : 'OFF') + ')<br>' +
        'Size: ' + (c.embeddings?.size || 0) + '/' + (c.embeddings?.maxSize || 0) +
        ' | Hits: ' + embHits + ' | Misses: ' + embMisses +
        ' | Rate: ' + (c.embeddings?.hitRate || '0%') +
        ' | Evictions: ' + (c.embeddings?.evictions || 0) + '</div>' +
      '<div><strong>Chat</strong> (' + (c.enabled?.chat ? 'ON' : 'OFF') + ')<br>' +
        'Size: ' + (c.chat?.size || 0) + '/' + (c.chat?.maxSize || 0) +
        ' | Hits: ' + chatHits + ' | Misses: ' + chatMisses +
        ' | Rate: ' + (c.chat?.hitRate || '0%') +
        ' | Evictions: ' + (c.chat?.evictions || 0) + '</div>' +
    '</div>';
}

function renderKeys(keys) {
  const tbody = document.getElementById('keysTableBody');
  const noKeys = document.getElementById('noKeys');
  document.getElementById('keyCount').textContent = keys.length + ' keys';

  if (keys.length === 0) {
    tbody.innerHTML = '';
    noKeys.classList.remove('hidden');
    return;
  }
  noKeys.classList.add('hidden');

  tbody.innerHTML = keys.map(k => {
    const statusBadge = !k.enabled
      ? '<span class="badge badge-gray"><span class="dot dot-gray"></span> Disabled</span>'
      : k.healthy
        ? '<span class="badge badge-green"><span class="dot dot-green"></span> Healthy</span>'
        : '<span class="badge badge-red"><span class="dot dot-red"></span> Unhealthy</span>';

    const lastUsed = k.lastUsed ? new Date(k.lastUsed).toLocaleString() : '-';
    const baseUrlShort = k.baseUrl.length > 35 ? k.baseUrl.substring(0, 35) + '...' : k.baseUrl;
    const failRate = k.totalRequests > 0 ? ' (' + ((k.failedRequests / k.totalRequests) * 100).toFixed(0) + '%)' : '';

    return '<tr>' +
      '<td>' + statusBadge + '</td>' +
      '<td class="mono">' + escHtml(k.key) + '</td>' +
      '<td class="mono" title="' + escHtml(k.baseUrl) + '">' + escHtml(baseUrlShort) + '</td>' +
      '<td>' + k.totalRequests + '</td>' +
      '<td>' + (k.failedRequests || 0) + escHtml(failRate) + '</td>' +
      '<td>' + lastUsed + '</td>' +
      '<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(k.lastError || '') + '">' + escHtml(k.lastError || '-') + '</td>' +
      '<td><div class="btn-group">' +
        '<button class="btn btn-outline btn-sm" onclick="toggleKey(\\''+k.id+'\\')">' + (k.enabled ? 'Disable' : 'Enable') + '</button>' +
        '<button class="btn btn-outline btn-sm" onclick="checkKey(\\''+k.id+'\\')">Check</button>' +
        '<button class="btn btn-danger btn-sm" onclick="removeKey(\\''+k.id+'\\')">Del</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
}

function escHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

async function batchImport() {
  const keys = document.getElementById('batchKeys').value.trim();
  const baseUrl = document.getElementById('defaultBaseUrl').value.trim() || undefined;
  if (!keys) return toast('Please enter keys', 'error');

  try {
    const r = await fetch('/admin/api/keys/batch', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ keys, baseUrl })
    });
    const d = await r.json();
    const msg = 'Added: ' + d.added.length + ' | Duplicates: ' + d.duplicates.length + ' | Errors: ' + d.errors.length;
    document.getElementById('importResult').innerHTML = '<span style="color:var(--success)">' + escHtml(msg) + '</span>';
    if (d.errors.length > 0) {
      document.getElementById('importResult').innerHTML += '<br><span style="color:var(--danger)">Errors: ' + d.errors.map(e => escHtml(e.input) + ': ' + escHtml(e.error)).join(', ') + '</span>';
    }
    document.getElementById('batchKeys').value = '';
    toast(msg, 'success');
    loadAll();
  } catch (e) {
    toast('Import failed: ' + e.message, 'error');
  }
}

async function addSingleKey() {
  const keys = document.getElementById('batchKeys').value.trim();
  const baseUrl = document.getElementById('defaultBaseUrl').value.trim() || undefined;
  if (!keys) return toast('Please enter a key', 'error');

  try {
    const r = await fetch('/admin/api/keys', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ key: keys.split('\\n')[0], baseUrl })
    });
    const d = await r.json();
    if (d.error) return toast(d.error, 'error');
    toast('Key added', 'success');
    document.getElementById('batchKeys').value = '';
    loadAll();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
}

async function removeKey(id) {
  if (!confirm('Remove this key?')) return;
  try {
    await fetch('/admin/api/keys/' + id, { method: 'DELETE', headers: authHeaders() });
    toast('Key removed', 'success');
    loadAll();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function toggleKey(id) {
  try {
    await fetch('/admin/api/keys/' + id + '/toggle', { method: 'POST', headers: authHeaders() });
    loadAll();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function checkKey(id) {
  try {
    toast('Checking...', 'success');
    await fetch('/admin/api/keys/' + id + '/check', { method: 'POST', headers: authHeaders() });
    loadAll();
    toast('Check complete', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function checkAllHealth() {
  try {
    toast('Checking all keys...', 'success');
    await fetch('/admin/api/keys/check', { method: 'POST', headers: authHeaders() });
    loadAll();
    toast('All checks complete', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function resetHealth() {
  try {
    await fetch('/admin/api/keys/reset-health', { method: 'POST', headers: authHeaders() });
    loadAll();
    toast('Health status reset', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function clearAll() {
  if (!confirm('Remove ALL keys? This cannot be undone.')) return;
  try {
    await fetch('/admin/api/keys', { method: 'DELETE', headers: authHeaders() });
    loadAll();
    toast('All keys cleared', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function clearCache() {
  try {
    await fetch('/admin/api/cache', { method: 'DELETE', headers: authHeaders() });
    loadCacheStats();
    toast('Cache cleared', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

function toggleAutoRefresh() {
  const on = document.getElementById('autoRefresh').checked;
  if (on) {
    autoRefreshTimer = setInterval(loadAll, 10000);
  } else {
    stopAutoRefresh();
  }
}

function stopAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  const cb = document.getElementById('autoRefresh');
  if (cb) cb.checked = false;
}

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'success');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
</script>
</body>
</html>`;
}

export default router;
