/**
 * Token Manager - Multi-user API token management
 * Supports: multiple API tokens, per-token usage tracking, quotas, permissions
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Token object schema:
 * {
 *   id: string,
 *   name: string,           // Display name
 *   token: string,          // The actual API token (hashed for storage, plain for lookup)
 *   tokenHash: string,      // SHA-256 hash for secure storage
 *   enabled: boolean,
 *   createdAt: string,
 *   expiresAt: string|null, // null = never expires
 *   rateLimit: number|null, // Custom rate limit (req/min), null = use default
 *   quotaLimit: number|null,// Monthly token quota, null = unlimited
 *   quotaUsed: number,      // Tokens used this month
 *   quotaResetAt: string,   // When quota resets
 *   allowedModels: string[],// Empty = all models allowed
 *   allowedIPs: string[],   // Empty = all IPs allowed
 *   totalRequests: number,
 *   totalTokens: number,    // Total tokens consumed
 *   lastUsed: string|null,
 *   metadata: object,       // Custom metadata
 * }
 */

class TokenManager {
  constructor() {
    this.tokens = [];
    this._tokenIndex = new Map();  // id -> token obj
    this._tokenLookup = new Map(); // plain token -> token obj (for O(1) auth)
    this._usageStats = {};         // tokenId -> { date -> { requests, promptTokens, completionTokens } }

    this._saveTimer = null;
    this._saveDelay = 500;

    this._load();
    this._rebuildIndex();
    this._checkQuotaReset();
  }

  _load() {
    try {
      if (fs.existsSync(TOKENS_FILE)) {
        const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
        this.tokens = data.tokens || [];
        this._usageStats = data.usageStats || {};
      }
    } catch (e) {
      console.error('[TokenManager] Failed to load tokens:', e.message);
      this.tokens = [];
    }
  }

  _rebuildIndex() {
    this._tokenIndex.clear();
    this._tokenLookup.clear();
    for (const t of this.tokens) {
      this._tokenIndex.set(t.id, t);
      if (t.token) {
        this._tokenLookup.set(t.token, t);
      }
    }
  }

  _save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._doSave();
    }, this._saveDelay);
  }

  _doSave() {
    try {
      const data = JSON.stringify({
        tokens: this.tokens,
        usageStats: this._usageStats,
      }, null, 2);
      fs.writeFile(TOKENS_FILE, data, (err) => {
        if (err) console.error('[TokenManager] Failed to save:', err.message);
      });
    } catch (e) {
      console.error('[TokenManager] Failed to serialize:', e.message);
    }
  }

  _saveSync() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      fs.writeFileSync(TOKENS_FILE, JSON.stringify({
        tokens: this.tokens,
        usageStats: this._usageStats,
      }, null, 2));
    } catch (e) {
      console.error('[TokenManager] Failed to save:', e.message);
    }
  }

  flushSync() {
    this._saveSync();
  }

  /**
   * Generate a new API token string
   */
  _generateToken() {
    return 'sk-o2o-' + crypto.randomBytes(24).toString('hex');
  }

  /**
   * Hash a token for secure storage comparison
   */
  _hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Create a new API token
   */
  createToken(options = {}) {
    const plainToken = options.token || this._generateToken();
    const now = new Date();
    const quotaResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    const tokenObj = {
      id: crypto.randomUUID(),
      name: options.name || 'API Token',
      token: plainToken,
      tokenHash: this._hashToken(plainToken),
      enabled: options.enabled !== false,
      createdAt: now.toISOString(),
      expiresAt: options.expiresAt || null,
      rateLimit: options.rateLimit || null,
      quotaLimit: options.quotaLimit || null,
      quotaUsed: 0,
      quotaResetAt,
      allowedModels: options.allowedModels || [],
      allowedIPs: options.allowedIPs || [],
      totalRequests: 0,
      totalTokens: 0,
      lastUsed: null,
      metadata: options.metadata || {},
    };

    this.tokens.push(tokenObj);
    this._tokenIndex.set(tokenObj.id, tokenObj);
    this._tokenLookup.set(plainToken, tokenObj);
    this._saveSync();

    return tokenObj;
  }

  /**
   * Validate a token and return the token object if valid
   * @returns {{ valid: boolean, token?: object, error?: string }}
   */
  validateToken(plainToken) {
    if (!plainToken) return { valid: false, error: 'Missing token' };

    const tokenObj = this._tokenLookup.get(plainToken);
    if (!tokenObj) return { valid: false, error: 'Invalid token' };
    if (!tokenObj.enabled) return { valid: false, error: 'Token disabled' };

    // Check expiration
    if (tokenObj.expiresAt && new Date(tokenObj.expiresAt) < new Date()) {
      return { valid: false, error: 'Token expired' };
    }

    // Check quota
    if (tokenObj.quotaLimit && tokenObj.quotaUsed >= tokenObj.quotaLimit) {
      return { valid: false, error: 'Token quota exceeded' };
    }

    return { valid: true, token: tokenObj };
  }

  /**
   * Check if a token has access to a specific model
   */
  checkModelAccess(tokenObj, model) {
    if (!tokenObj.allowedModels || tokenObj.allowedModels.length === 0) return true;
    return tokenObj.allowedModels.some(m => {
      if (m.includes('*')) {
        const regex = new RegExp('^' + m.replace(/\*/g, '.*') + '$');
        return regex.test(model);
      }
      return m === model;
    });
  }

  /**
   * Check if a token has access from a specific IP
   */
  checkIPAccess(tokenObj, ip) {
    if (!tokenObj.allowedIPs || tokenObj.allowedIPs.length === 0) return true;
    return tokenObj.allowedIPs.includes(ip);
  }

  /**
   * Record token usage
   */
  recordUsage(tokenId, promptTokens = 0, completionTokens = 0) {
    const tokenObj = this._tokenIndex.get(tokenId);
    if (!tokenObj) return;

    const totalTokens = promptTokens + completionTokens;
    tokenObj.totalRequests++;
    tokenObj.totalTokens += totalTokens;
    tokenObj.quotaUsed += totalTokens;
    tokenObj.lastUsed = new Date().toISOString();

    // Per-day stats
    const today = new Date().toISOString().split('T')[0];
    if (!this._usageStats[tokenId]) this._usageStats[tokenId] = {};
    if (!this._usageStats[tokenId][today]) {
      this._usageStats[tokenId][today] = { requests: 0, promptTokens: 0, completionTokens: 0 };
    }
    this._usageStats[tokenId][today].requests++;
    this._usageStats[tokenId][today].promptTokens += promptTokens;
    this._usageStats[tokenId][today].completionTokens += completionTokens;

    this._save();
  }

  /**
   * Get token by ID
   */
  getTokenById(id) {
    return this._tokenIndex.get(id) || null;
  }

  /**
   * Update a token
   */
  updateToken(id, updates) {
    const tokenObj = this._tokenIndex.get(id);
    if (!tokenObj) return null;

    const allowedFields = ['name', 'enabled', 'expiresAt', 'rateLimit', 'quotaLimit', 'allowedModels', 'allowedIPs', 'metadata'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        tokenObj[field] = updates[field];
      }
    }

    this._saveSync();
    return tokenObj;
  }

  /**
   * Delete a token
   */
  deleteToken(id) {
    const idx = this.tokens.findIndex(t => t.id === id);
    if (idx === -1) return false;

    const tokenObj = this.tokens[idx];
    this._tokenLookup.delete(tokenObj.token);
    this._tokenIndex.delete(id);
    this.tokens.splice(idx, 1);
    delete this._usageStats[id];
    this._saveSync();
    return true;
  }

  /**
   * Get all tokens (masked for display)
   */
  getAllTokens() {
    return this.tokens.map(t => ({
      ...t,
      token: t.token ? t.token.substring(0, 10) + '***' + t.token.substring(t.token.length - 4) : '(empty)',
    }));
  }

  /**
   * Get usage stats for a token
   */
  getTokenUsage(tokenId, days = 30) {
    const stats = this._usageStats[tokenId] || {};
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const result = {};
    for (const [date, data] of Object.entries(stats)) {
      if (date >= cutoffStr) {
        result[date] = data;
      }
    }
    return result;
  }

  /**
   * Get aggregate usage stats across all tokens
   */
  getAggregateUsage(days = 7) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const daily = {};
    for (const [tokenId, dates] of Object.entries(this._usageStats)) {
      for (const [date, data] of Object.entries(dates)) {
        if (date >= cutoffStr) {
          if (!daily[date]) daily[date] = { requests: 0, promptTokens: 0, completionTokens: 0 };
          daily[date].requests += data.requests;
          daily[date].promptTokens += data.promptTokens;
          daily[date].completionTokens += data.completionTokens;
        }
      }
    }
    return daily;
  }

  /**
   * Get summary
   */
  getSummary() {
    let total = this.tokens.length;
    let enabled = 0, disabled = 0, expired = 0;
    const now = new Date();

    for (const t of this.tokens) {
      if (!t.enabled) disabled++;
      else if (t.expiresAt && new Date(t.expiresAt) < now) expired++;
      else enabled++;
    }

    return { total, enabled, disabled, expired };
  }

  /**
   * Check and reset monthly quotas
   */
  _checkQuotaReset() {
    const now = new Date();
    for (const t of this.tokens) {
      if (t.quotaResetAt && new Date(t.quotaResetAt) <= now) {
        t.quotaUsed = 0;
        t.quotaResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
      }
    }
  }

  /**
   * Check if multi-token mode is enabled
   * If no tokens exist and legacy API_TOKEN is set, we operate in legacy mode
   */
  isMultiTokenMode() {
    return this.tokens.length > 0;
  }
}

const tokenManager = new TokenManager();
export default tokenManager;
