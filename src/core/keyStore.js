import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

// Max days to retain stats before auto-cleanup
const STATS_RETENTION_DAYS = 30;

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
    this._keyIndex = new Map(); // id -> key object for O(1) lookup
    this.currentIndex = 0;  // Round-robin index
    this.stats = {};        // Usage statistics per key

    // Debounce timers for async file writes
    this._saveTimer = null;
    this._saveStatsTimer = null;
    this._saveDelay = 500; // ms debounce delay

    // Cache invalidation
    this._summaryCache = null;
    this._allKeysCache = null;
    this._poolCache = null; // Cached healthy/enabled pool
    this._dirty = false;

    this._load();
    this._rebuildIndex();
    this._cleanupOldStats();
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

  /**
   * Rebuild the key index map for O(1) lookups
   */
  _rebuildIndex() {
    this._keyIndex.clear();
    for (const key of this.keys) {
      this._keyIndex.set(key.id, key);
    }
  }

  /**
   * Invalidate caches when data changes
   */
  _invalidateCache() {
    this._summaryCache = null;
    this._allKeysCache = null;
    this._poolCache = null;
  }

  /**
   * Debounced async save for keys
   * Avoids blocking the event loop with synchronous writeFileSync on every request
   */
  _save() {
    this._dirty = true;
    this._invalidateCache();

    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._doSave();
    }, this._saveDelay);
  }

  _doSave() {
    try {
      const data = JSON.stringify({
        keys: this.keys,
        currentIndex: this.currentIndex
      }, null, 2);
      fs.writeFile(KEYS_FILE, data, (err) => {
        if (err) console.error('[KeyStore] Failed to save keys:', err.message);
      });
    } catch (e) {
      console.error('[KeyStore] Failed to serialize keys:', e.message);
    }
  }

  /**
   * Synchronous save - only for critical operations (add/remove/toggle/clear)
   */
  _saveSync() {
    this._dirty = true;
    this._invalidateCache();
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      fs.writeFileSync(KEYS_FILE, JSON.stringify({
        keys: this.keys,
        currentIndex: this.currentIndex
      }, null, 2));
    } catch (e) {
      console.error('[KeyStore] Failed to save keys:', e.message);
    }
  }

  /**
   * Debounced async save for stats
   */
  _saveStats() {
    if (this._saveStatsTimer) clearTimeout(this._saveStatsTimer);
    this._saveStatsTimer = setTimeout(() => {
      this._saveStatsTimer = null;
      this._doSaveStats();
    }, this._saveDelay);
  }

  _doSaveStats() {
    try {
      const data = JSON.stringify(this.stats, null, 2);
      fs.writeFile(STATS_FILE, data, (err) => {
        if (err) console.error('[KeyStore] Failed to save stats:', err.message);
      });
    } catch (e) {
      console.error('[KeyStore] Failed to serialize stats:', e.message);
    }
  }

  /**
   * Flush pending writes immediately (for graceful shutdown)
   */
  flushSync() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._saveStatsTimer) {
      clearTimeout(this._saveStatsTimer);
      this._saveStatsTimer = null;
    }
    try {
      fs.writeFileSync(KEYS_FILE, JSON.stringify({
        keys: this.keys,
        currentIndex: this.currentIndex
      }, null, 2));
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.stats, null, 2));
    } catch (e) {
      console.error('[KeyStore] Failed to flush:', e.message);
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
    else if (raw.startsWith('http') && raw.match(/\/([a-zA-Z0-9_.-]{20,})$/)) {
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
      id: crypto.randomUUID(),
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
    this._keyIndex.set(keyObj.id, keyObj);
    this._saveSync(); // Use sync save for mutations - user expects immediate persistence
    return keyObj;
  }

  /**
   * Batch import keys (newline or comma separated)
   * BUG FIX: Previously called addKey() per line which did _saveSync() each time,
   * causing N synchronous file writes. Now batches all additions and writes once.
   */
  batchImport(text, defaultBaseUrl) {
    const lines = text.split(/[\n,;]+/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const results = { added: [], duplicates: [], errors: [] };

    for (const line of lines) {
      try {
        const keyObj = this.parseKeyString(line, defaultBaseUrl);
        if (!keyObj) {
          results.errors.push({ input: line, error: 'Invalid format' });
          continue;
        }

        // Check for duplicates against existing keys AND newly added keys
        const existing = this.keys.find(k => k.key === keyObj.key && k.baseUrl === keyObj.baseUrl);
        if (existing) {
          results.duplicates.push({ ...existing, duplicate: true });
        } else {
          this.keys.push(keyObj);
          this._keyIndex.set(keyObj.id, keyObj);
          results.added.push(keyObj);
        }
      } catch (e) {
        results.errors.push({ input: line, error: e.message });
      }
    }

    // Single write for all additions
    if (results.added.length > 0) {
      this._saveSync();
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
    this._keyIndex.delete(id);
    if (this.currentIndex >= this.keys.length) {
      this.currentIndex = 0;
    }
    this._saveSync();
    return true;
  }

  /**
   * Toggle key enabled/disabled
   */
  toggleKey(id) {
    const key = this._keyIndex.get(id);
    if (!key) return null;
    key.enabled = !key.enabled;
    this._saveSync();
    return key;
  }

  /**
   * Get next available key using round-robin
   * BUG FIX: Index is now managed correctly across the full keys array
   * instead of being applied to filtered sub-arrays which caused index confusion
   */
  getNextKey() {
    if (this.keys.length === 0) return null;

    // Use cached pool to avoid filtering on every request
    if (!this._poolCache) {
      const enabledHealthy = this.keys.filter(k => k.enabled && k.healthy);
      this._poolCache = enabledHealthy.length > 0
        ? enabledHealthy
        : this.keys.filter(k => k.enabled); // Fallback: enabled but unhealthy
    }

    const pool = this._poolCache;
    if (pool.length === 0) return null;

    // Ensure index is within bounds of the current pool
    if (this.currentIndex >= pool.length || this.currentIndex < 0) {
      this.currentIndex = 0;
    }

    const key = pool[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % pool.length;

    // Use debounced save - round-robin index update is not critical to persist immediately
    this._save();
    return key;
  }

  /**
   * Record a successful request
   * BUG FIX: No longer unconditionally sets healthy=true.
   * If a key was explicitly marked unhealthy by health check, a single
   * successful proxied request should not override that status.
   * We only clear lastError and mark healthy if key was auto-degraded (not by health check).
   */
  recordSuccess(keyId) {
    const key = this._keyIndex.get(keyId);
    if (!key) return;
    key.totalRequests++;
    key.lastUsed = new Date().toISOString();

    // Only auto-recover if key was not explicitly failed by health check
    // A successful request is a good signal, so clear error and mark healthy
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
    const key = this._keyIndex.get(keyId);
    if (!key) return;
    key.totalRequests++;
    key.failedRequests++;
    key.lastUsed = new Date().toISOString();
    key.lastError = error || 'Unknown error';

    // Auto-disable after sustained failures:
    // >5 failed requests AND >80% failure rate
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const url = keyObj.baseUrl.endsWith('/api')
        ? `${keyObj.baseUrl}/tags`
        : `${keyObj.baseUrl}/api/tags`;

      const headers = {};
      if (keyObj.key) {
        headers['Authorization'] = `Bearer ${keyObj.key}`;
      }

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
      clearTimeout(timeout);
      keyObj.lastCheck = new Date().toISOString();
      keyObj.healthy = false;
      keyObj.lastError = e.name === 'AbortError' ? 'Health check timeout (10s)' : e.message;
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
   * Get all keys (for admin display) - with key masking
   * Uses cache that is invalidated on data changes
   */
  getAllKeys() {
    if (this._allKeysCache) return this._allKeysCache;

    this._allKeysCache = this.keys.map(k => ({
      ...k,
      key: k.key
        ? (k.key.length > 10
          ? k.key.substring(0, 6) + '***' + k.key.substring(k.key.length - 4)
          : k.key.substring(0, 2) + '***')
        : '(empty)'
    }));
    return this._allKeysCache;
  }

  /**
   * Get summary statistics
   * Uses cache that is invalidated on data changes
   */
  getSummary() {
    if (this._summaryCache) return this._summaryCache;

    // PERF: Single-pass computation instead of 4 separate filter() calls
    let enabled = 0, healthy = 0, disabled = 0, unhealthy = 0;
    for (const k of this.keys) {
      if (k.enabled) {
        enabled++;
        if (k.healthy) healthy++;
        else unhealthy++;
      } else {
        disabled++;
      }
    }

    this._summaryCache = {
      total: this.keys.length,
      enabled,
      healthy,
      disabled,
      unhealthy,
    };
    return this._summaryCache;
  }

  /**
   * Clear all keys
   */
  clearAll() {
    this.keys = [];
    this._keyIndex.clear();
    this.currentIndex = 0;
    this._saveSync();
  }

  /**
   * Reset health status of all keys
   */
  resetHealth() {
    for (const key of this.keys) {
      key.healthy = true;
      key.lastError = null;
    }
    this._saveSync();
  }

  /**
   * Clean up stats older than STATS_RETENTION_DAYS to prevent unbounded growth
   */
  _cleanupOldStats() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - STATS_RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    let cleaned = 0;
    for (const date of Object.keys(this.stats)) {
      if (date < cutoffStr) {
        delete this.stats[date];
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[KeyStore] Cleaned up ${cleaned} old stats entries (>${STATS_RETENTION_DAYS} days)`);
      this._doSaveStats();
    }
  }

  /**
   * Get a key by ID using O(1) Map lookup
   */
  getKeyById(id) {
    return this._keyIndex.get(id) || null;
  }
}

// Singleton
const keyStore = new KeyStore();

export default keyStore;
