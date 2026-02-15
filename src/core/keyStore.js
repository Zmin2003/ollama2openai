import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Key store - manages Ollama API keys with persistence
 * Supports: ollama.com keys, self-hosted URLs, New API format
 */
class KeyStore {
  constructor() {
    this.keys = [];         // Array of key objects
    this.currentIndex = 0;  // Round-robin index
    this.stats = {};        // Usage statistics per key
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(KEYS_FILE)) {
        const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
        this.keys = data.keys || [];
        this.currentIndex = data.currentIndex || 0;
      }
    } catch (e) {
      console.error('[KeyStore] Failed to load keys:', e.message);
      this.keys = [];
    }
    try {
      if (fs.existsSync(STATS_FILE)) {
        this.stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
      }
    } catch (e) {
      this.stats = {};
    }
  }

  _save() {
    try {
      fs.writeFileSync(KEYS_FILE, JSON.stringify({
        keys: this.keys,
        currentIndex: this.currentIndex
      }, null, 2));
    } catch (e) {
      console.error('[KeyStore] Failed to save keys:', e.message);
    }
  }

  _saveStats() {
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.stats, null, 2));
    } catch (e) {
      console.error('[KeyStore] Failed to save stats:', e.message);
    }
  }

  /**
   * Parse a key string into a key object
   * Supported formats:
   *   1. "sk-xxxxx" (bare key, uses default base URL)
   *   2. "https://api.example.com/sk-xxxxx" (New API format: URL/key)
   *   3. "https://api.example.com|sk-xxxxx" (URL|key)
   *   4. "sk-xxxxx|https://api.example.com" (key|URL)
   *   5. "https://api.example.com#sk-xxxxx" (URL#key)
   */
  parseKeyString(raw, defaultBaseUrl) {
    raw = raw.trim();
    if (!raw) return null;

    let key = '';
    let baseUrl = defaultBaseUrl || 'https://ollama.com/api';
    let name = '';

    // Format: URL|key or key|URL
    if (raw.includes('|')) {
      const parts = raw.split('|');
      if (parts[0].startsWith('http')) {
        baseUrl = parts[0].trim().replace(/\/+$/, '');
        key = parts.slice(1).join('|').trim();
      } else {
        key = parts[0].trim();
        baseUrl = parts.slice(1).join('|').trim().replace(/\/+$/, '');
      }
    }
    // Format: URL#key
    else if (raw.includes('#') && raw.startsWith('http')) {
      const idx = raw.lastIndexOf('#');
      baseUrl = raw.substring(0, idx).trim().replace(/\/+$/, '');
      key = raw.substring(idx + 1).trim();
    }
    // Format: New API style - URL/key (key starts with sk- or similar)
    else if (raw.startsWith('http') && raw.match(/\/([a-zA-Z0-9_-]{20,})$/)) {
      const lastSlash = raw.lastIndexOf('/');
      baseUrl = raw.substring(0, lastSlash).trim().replace(/\/+$/, '');
      key = raw.substring(lastSlash + 1).trim();
    }
    // Format: bare key
    else {
      key = raw;
    }

    // Normalize base URL - remove trailing /api if present for consistency
    // We'll add /api back when making requests
    baseUrl = baseUrl.replace(/\/api\/?$/, '');
    // But we need to store with /api
    if (!baseUrl.endsWith('/api')) {
      // Check if it's an ollama.com URL or a base URL
      if (baseUrl.includes('ollama.com')) {
        baseUrl = baseUrl.replace(/\/$/, '') + '/api';
      }
      // For self-hosted, keep as-is (user provides full base URL)
    }

    // Generate short name from key
    if (key.length > 8) {
      name = key.substring(0, 4) + '...' + key.substring(key.length - 4);
    } else {
      name = key;
    }

    return {
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substr(2),
      key,
      baseUrl,
      name,
      enabled: true,
      healthy: true,
      lastCheck: null,
      lastUsed: null,
      lastError: null,
      addedAt: new Date().toISOString(),
      totalRequests: 0,
      failedRequests: 0,
      tags: []
    };
  }

  /**
   * Add a single key
   */
  addKey(rawKey, defaultBaseUrl) {
    const keyObj = this.parseKeyString(rawKey, defaultBaseUrl);
    if (!keyObj) return null;

    // Check for duplicates
    const existing = this.keys.find(k => k.key === keyObj.key && k.baseUrl === keyObj.baseUrl);
    if (existing) {
      return { ...existing, duplicate: true };
    }

    this.keys.push(keyObj);
    this._save();
    return keyObj;
  }

  /**
   * Batch import keys (newline or comma separated)
   */
  batchImport(text, defaultBaseUrl) {
    const lines = text.split(/[\n,;]+/).map(l => l.trim()).filter(Boolean);
    const results = { added: [], duplicates: [], errors: [] };

    for (const line of lines) {
      try {
        const keyObj = this.addKey(line, defaultBaseUrl);
        if (!keyObj) {
          results.errors.push({ input: line, error: 'Invalid format' });
        } else if (keyObj.duplicate) {
          results.duplicates.push(keyObj);
        } else {
          results.added.push(keyObj);
        }
      } catch (e) {
        results.errors.push({ input: line, error: e.message });
      }
    }

    return results;
  }

  /**
   * Remove a key by ID
   */
  removeKey(id) {
    const idx = this.keys.findIndex(k => k.id === id);
    if (idx === -1) return false;
    this.keys.splice(idx, 1);
    if (this.currentIndex >= this.keys.length) {
      this.currentIndex = 0;
    }
    this._save();
    return true;
  }

  /**
   * Toggle key enabled/disabled
   */
  toggleKey(id) {
    const key = this.keys.find(k => k.id === id);
    if (!key) return null;
    key.enabled = !key.enabled;
    this._save();
    return key;
  }

  /**
   * Get next available key using round-robin
   */
  getNextKey() {
    const available = this.keys.filter(k => k.enabled && k.healthy);
    if (available.length === 0) {
      // Fallback: try enabled but unhealthy keys
      const enabled = this.keys.filter(k => k.enabled);
      if (enabled.length === 0) return null;
      this.currentIndex = this.currentIndex % enabled.length;
      const key = enabled[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % enabled.length;
      this._save();
      return key;
    }

    this.currentIndex = this.currentIndex % available.length;
    const key = available[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % available.length;
    this._save();
    return key;
  }

  /**
   * Record a successful request
   */
  recordSuccess(keyId) {
    const key = this.keys.find(k => k.id === keyId);
    if (!key) return;
    key.totalRequests++;
    key.lastUsed = new Date().toISOString();
    key.healthy = true;
    key.lastError = null;
    this._save();

    // Update stats
    const today = new Date().toISOString().split('T')[0];
    if (!this.stats[today]) this.stats[today] = {};
    if (!this.stats[today][keyId]) this.stats[today][keyId] = { success: 0, fail: 0 };
    this.stats[today][keyId].success++;
    this._saveStats();
  }

  /**
   * Record a failed request
   */
  recordFailure(keyId, error) {
    const key = this.keys.find(k => k.id === keyId);
    if (!key) return;
    key.totalRequests++;
    key.failedRequests++;
    key.lastUsed = new Date().toISOString();
    key.lastError = error || 'Unknown error';

    // Auto-disable after 5 consecutive failures
    // We check if last 5 requests were failures
    if (key.failedRequests > 5 && (key.failedRequests / key.totalRequests) > 0.8) {
      key.healthy = false;
    }

    this._save();

    const today = new Date().toISOString().split('T')[0];
    if (!this.stats[today]) this.stats[today] = {};
    if (!this.stats[today][keyId]) this.stats[today][keyId] = { success: 0, fail: 0 };
    this.stats[today][keyId].fail++;
    this._saveStats();
  }

  /**
   * Health check: test a key by calling /api/tags
   */
  async checkKeyHealth(keyObj) {
    try {
      const url = keyObj.baseUrl.endsWith('/api')
        ? `${keyObj.baseUrl}/tags`
        : `${keyObj.baseUrl}/api/tags`;

      const headers = {};
      if (keyObj.key) {
        headers['Authorization'] = `Bearer ${keyObj.key}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      });

      clearTimeout(timeout);

      keyObj.lastCheck = new Date().toISOString();

      if (res.ok) {
        keyObj.healthy = true;
        keyObj.lastError = null;
      } else {
        keyObj.healthy = false;
        keyObj.lastError = `HTTP ${res.status}`;
      }
    } catch (e) {
      keyObj.lastCheck = new Date().toISOString();
      keyObj.healthy = false;
      keyObj.lastError = e.message;
    }

    this._save();
    return keyObj;
  }

  /**
   * Check all keys health
   */
  async checkAllHealth() {
    const promises = this.keys.map(k => this.checkKeyHealth(k));
    await Promise.allSettled(promises);
    return this.keys;
  }

  /**
   * Get all keys (for admin display)
   */
  getAllKeys() {
    return this.keys.map(k => ({
      ...k,
      key: k.key ? k.key.substring(0, 6) + '***' + k.key.substring(k.key.length - 4) : '(empty)'
    }));
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    return {
      total: this.keys.length,
      enabled: this.keys.filter(k => k.enabled).length,
      healthy: this.keys.filter(k => k.enabled && k.healthy).length,
      disabled: this.keys.filter(k => !k.enabled).length,
      unhealthy: this.keys.filter(k => k.enabled && !k.healthy).length,
    };
  }

  /**
   * Clear all keys
   */
  clearAll() {
    this.keys = [];
    this.currentIndex = 0;
    this._save();
  }

  /**
   * Reset health status of all keys
   */
  resetHealth() {
    for (const key of this.keys) {
      key.healthy = true;
      key.lastError = null;
    }
    this._save();
  }
}

// Singleton
const keyStore = new KeyStore();
export default keyStore;
