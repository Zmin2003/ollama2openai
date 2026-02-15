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

// Auth middleware for admin routes
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const cookieToken = req.cookies?.admin_token;
  const queryToken = req.query?.token;

  let token;
  if (authHeader) {
    token = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : authHeader.trim();
  }
  token = token || cookieToken || queryToken;

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
  res.json({ success: true, key: { ...key, key: key.key.substring(0, 6) + '***' } });
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
    --radius: 10px;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }

  /* Header */
  .header { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
  .header h1 { font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #6366f1, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .header .info { color: var(--text2); font-size: 13px; }

  /* Login */
  .login-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .login-box { background: var(--surface); padding: 40px; border-radius: var(--radius); width: 380px; }
  .login-box h2 { margin-bottom: 20px; text-align: center; }

  /* Cards */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
  .stat-card .label { font-size: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .stat-card .value { font-size: 28px; font-weight: 700; }
  .stat-card .value.green { color: var(--success); }
  .stat-card .value.red { color: var(--danger); }
  .stat-card .value.yellow { color: var(--warning); }

  /* Panels */
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 24px; }
  .panel-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); }
  .panel-header h2 { font-size: 16px; font-weight: 600; }
  .panel-body { padding: 20px; }

  /* Buttons */
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
  .btn-primary { background: var(--primary); color: white; }
  .btn-primary:hover { background: var(--primary-hover); }
  .btn-danger { background: var(--danger); color: white; }
  .btn-danger:hover { opacity: 0.85; }
  .btn-success { background: var(--success); color: white; }
  .btn-success:hover { opacity: 0.85; }
  .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .btn-outline:hover { border-color: var(--primary); color: var(--primary); }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .btn-group { display: flex; gap: 8px; flex-wrap: wrap; }

  /* Inputs */
  input, textarea { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; color: var(--text); font-size: 14px; width: 100%; outline: none; transition: border-color 0.15s; }
  input:focus, textarea:focus { border-color: var(--primary); }
  textarea { resize: vertical; min-height: 120px; font-family: monospace; font-size: 13px; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--text2); }
  .form-group { margin-bottom: 16px; }

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
  .toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; font-size: 14px; z-index: 1000; animation: slideIn 0.3s ease; }
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
    <button class="btn btn-outline" onclick="doLogout()">Logout</button>
  </div>

  <!-- Stats -->
  <div class="stats-grid" id="statsGrid">
    <div class="stat-card"><div class="label">Total Keys</div><div class="value" id="statTotal">0</div></div>
    <div class="stat-card"><div class="label">Healthy</div><div class="value green" id="statHealthy">0</div></div>
    <div class="stat-card"><div class="label">Unhealthy</div><div class="value red" id="statUnhealthy">0</div></div>
    <div class="stat-card"><div class="label">Disabled</div><div class="value yellow" id="statDisabled">0</div></div>
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
        <label>Keys (one per line, supports multiple formats)</label>
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
}

function showApp() {
  document.getElementById('loginOverlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('apiEndpoint').textContent = location.origin + '/v1';
  loadKeys();
}

async function doLogin() {
  const pw = document.getElementById('loginPassword').value;
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
    if (!r.ok) return;
    const d = await r.json();
    renderKeys(d.keys);
    renderStats(d.summary);
  } catch (e) {
    toast('Failed to load keys: ' + e.message, 'error');
  }
}

function renderStats(s) {
  document.getElementById('statTotal').textContent = s.total;
  document.getElementById('statHealthy').textContent = s.healthy;
  document.getElementById('statUnhealthy').textContent = s.unhealthy;
  document.getElementById('statDisabled').textContent = s.disabled;
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

    return '<tr>' +
      '<td>' + statusBadge + '</td>' +
      '<td class="mono">' + escHtml(k.key) + '</td>' +
      '<td class="mono" title="' + escHtml(k.baseUrl) + '">' + escHtml(baseUrlShort) + '</td>' +
      '<td>' + k.totalRequests + '</td>' +
      '<td>' + (k.failedRequests || 0) + '</td>' +
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

function escHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

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
    document.getElementById('importResult').innerHTML = '<span style="color:var(--success)">' + msg + '</span>';
    if (d.errors.length > 0) {
      document.getElementById('importResult').innerHTML += '<br><span style="color:var(--danger)">Errors: ' + d.errors.map(e => e.input + ': ' + e.error).join(', ') + '</span>';
    }
    document.getElementById('batchKeys').value = '';
    toast(msg, 'success');
    loadKeys();
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
    loadKeys();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
}

async function removeKey(id) {
  if (!confirm('Remove this key?')) return;
  try {
    await fetch('/admin/api/keys/' + id, { method: 'DELETE', headers: authHeaders() });
    toast('Key removed', 'success');
    loadKeys();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function toggleKey(id) {
  try {
    await fetch('/admin/api/keys/' + id + '/toggle', { method: 'POST', headers: authHeaders() });
    loadKeys();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function checkKey(id) {
  try {
    toast('Checking...', 'success');
    await fetch('/admin/api/keys/' + id + '/check', { method: 'POST', headers: authHeaders() });
    loadKeys();
    toast('Check complete', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function checkAllHealth() {
  try {
    toast('Checking all keys...', 'success');
    await fetch('/admin/api/keys/check', { method: 'POST', headers: authHeaders() });
    loadKeys();
    toast('All checks complete', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function resetHealth() {
  try {
    await fetch('/admin/api/keys/reset-health', { method: 'POST', headers: authHeaders() });
    loadKeys();
    toast('Health status reset', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function clearAll() {
  if (!confirm('Remove ALL keys? This cannot be undone.')) return;
  try {
    await fetch('/admin/api/keys', { method: 'DELETE', headers: authHeaders() });
    loadKeys();
    toast('All keys cleared', 'success');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
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
