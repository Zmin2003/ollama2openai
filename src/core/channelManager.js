/**
 * Channel Manager - Multi-backend routing with priority & model mapping
 * 
 * A "channel" groups multiple keys under a named provider with:
 * - Priority-based selection (higher priority channels tried first)
 * - Model mapping (rename models across providers)
 * - Weight-based load balancing within a channel
 * - Per-channel rate limits and concurrency controls
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Channel schema:
 * {
 *   id: string,
 *   name: string,              // Display name (e.g. "Ollama Cloud", "Self-hosted GPU")
 *   enabled: boolean,
 *   priority: number,          // Higher = tried first (default 0)
 *   baseUrl: string,           // Base URL for this channel
 *   keys: string[],            // Array of API keys for this channel
 *   models: string[],          // Models available on this channel (empty = all)
 *   modelMapping: object,      // { "gpt-4": "llama3.2:70b" } - rename models
 *   weight: number,            // Weight for load balancing (1-100, default 10)
 *   maxConcurrent: number,     // Max concurrent requests (0 = unlimited)
 *   currentConcurrent: number, // Current active requests
 *   rateLimit: number|null,    // Requests per minute (null = no limit)
 *   totalRequests: number,
 *   failedRequests: number,
 *   totalTokens: number,
 *   lastUsed: string|null,
 *   lastError: string|null,
 *   healthy: boolean,
 *   createdAt: string,
 *   tags: string[],
 * }
 */

class ChannelManager {
  constructor() {
    this.channels = [];
    this._channelIndex = new Map();
    this._currentKeyIndex = new Map(); // channelId -> current key index for round-robin
    this._saveTimer = null;
    this._saveDelay = 500;

    this._load();
    this._rebuildIndex();
  }

  _load() {
    try {
      if (fs.existsSync(CHANNELS_FILE)) {
        const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
        this.channels = data.channels || [];
      }
    } catch (e) {
      console.error('[ChannelManager] Failed to load:', e.message);
      this.channels = [];
    }
  }

  _rebuildIndex() {
    this._channelIndex.clear();
    for (const ch of this.channels) {
      this._channelIndex.set(ch.id, ch);
      if (!this._currentKeyIndex.has(ch.id)) {
        this._currentKeyIndex.set(ch.id, 0);
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
      fs.writeFile(CHANNELS_FILE, JSON.stringify({ channels: this.channels }, null, 2), (err) => {
        if (err) console.error('[ChannelManager] Failed to save:', err.message);
      });
    } catch (e) {
      console.error('[ChannelManager] Failed to serialize:', e.message);
    }
  }

  _saveSync() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      fs.writeFileSync(CHANNELS_FILE, JSON.stringify({ channels: this.channels }, null, 2));
    } catch (e) {
      console.error('[ChannelManager] Failed to save:', e.message);
    }
  }

  flushSync() { this._saveSync(); }

  /**
   * Create a new channel
   */
  createChannel(options = {}) {
    const channel = {
      id: crypto.randomUUID(),
      name: options.name || 'New Channel',
      enabled: options.enabled !== false,
      priority: options.priority || 0,
      baseUrl: options.baseUrl || process.env.OLLAMA_BASE_URL || 'https://ollama.com/api',
      keys: options.keys || [],
      models: options.models || [],
      modelMapping: options.modelMapping || {},
      weight: options.weight || 10,
      maxConcurrent: options.maxConcurrent || 0,
      currentConcurrent: 0,
      rateLimit: options.rateLimit || null,
      totalRequests: 0,
      failedRequests: 0,
      totalTokens: 0,
      lastUsed: null,
      lastError: null,
      healthy: true,
      createdAt: new Date().toISOString(),
      tags: options.tags || [],
    };

    this.channels.push(channel);
    this._channelIndex.set(channel.id, channel);
    this._currentKeyIndex.set(channel.id, 0);
    this._saveSync();
    return channel;
  }

  /**
   * Update a channel
   */
  updateChannel(id, updates) {
    const ch = this._channelIndex.get(id);
    if (!ch) return null;

    const allowedFields = [
      'name', 'enabled', 'priority', 'baseUrl', 'keys', 'models',
      'modelMapping', 'weight', 'maxConcurrent', 'rateLimit', 'tags'
    ];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        ch[field] = updates[field];
      }
    }

    this._saveSync();
    return ch;
  }

  /**
   * Delete a channel
   */
  deleteChannel(id) {
    const idx = this.channels.findIndex(c => c.id === id);
    if (idx === -1) return false;
    this.channels.splice(idx, 1);
    this._channelIndex.delete(id);
    this._currentKeyIndex.delete(id);
    this._saveSync();
    return true;
  }

  /**
   * Select the best channel for a model request
   * Strategy: priority-based with weighted random within same priority
   */
  selectChannel(model) {
    // Filter eligible channels
    const eligible = this.channels.filter(ch => {
      if (!ch.enabled || !ch.healthy) return false;
      if (ch.maxConcurrent > 0 && ch.currentConcurrent >= ch.maxConcurrent) return false;

      // Check model support
      if (ch.models.length > 0) {
        const hasModel = ch.models.some(m => {
          if (m.includes('*')) {
            return new RegExp('^' + m.replace(/\*/g, '.*') + '$').test(model);
          }
          return m === model;
        });
        // Also check modelMapping
        const hasMappedModel = Object.keys(ch.modelMapping).includes(model);
        if (!hasModel && !hasMappedModel) return false;
      }

      return true;
    });

    if (eligible.length === 0) return null;

    // Sort by priority (highest first)
    eligible.sort((a, b) => b.priority - a.priority);

    // Get highest priority group
    const highestPriority = eligible[0].priority;
    const topChannels = eligible.filter(ch => ch.priority === highestPriority);

    // Weighted random selection within the top priority group
    if (topChannels.length === 1) return topChannels[0];

    const totalWeight = topChannels.reduce((sum, ch) => sum + ch.weight, 0);
    let random = Math.random() * totalWeight;
    for (const ch of topChannels) {
      random -= ch.weight;
      if (random <= 0) return ch;
    }

    return topChannels[0];
  }

  /**
   * Get the next key for a channel (round-robin within channel)
   */
  getNextKey(channelId) {
    const ch = this._channelIndex.get(channelId);
    if (!ch || ch.keys.length === 0) return { key: '', baseUrl: ch?.baseUrl || '' };

    let idx = this._currentKeyIndex.get(channelId) || 0;
    if (idx >= ch.keys.length) idx = 0;

    const key = ch.keys[idx];
    this._currentKeyIndex.set(channelId, (idx + 1) % ch.keys.length);

    return { key, baseUrl: ch.baseUrl };
  }

  /**
   * Resolve model name through channel's model mapping
   */
  resolveModel(channel, requestedModel) {
    if (channel.modelMapping && channel.modelMapping[requestedModel]) {
      return channel.modelMapping[requestedModel];
    }
    return requestedModel;
  }

  /**
   * Record channel usage
   */
  recordSuccess(channelId, tokens = 0) {
    const ch = this._channelIndex.get(channelId);
    if (!ch) return;
    ch.totalRequests++;
    ch.totalTokens += tokens;
    ch.lastUsed = new Date().toISOString();
    ch.lastError = null;
    ch.healthy = true;
    if (ch.currentConcurrent > 0) ch.currentConcurrent--;
    this._save();
  }

  recordFailure(channelId, error) {
    const ch = this._channelIndex.get(channelId);
    if (!ch) return;
    ch.totalRequests++;
    ch.failedRequests++;
    ch.lastUsed = new Date().toISOString();
    ch.lastError = error;
    if (ch.currentConcurrent > 0) ch.currentConcurrent--;

    // Auto-degrade if failure rate > 80% with > 5 requests
    if (ch.failedRequests > 5 && (ch.failedRequests / ch.totalRequests) > 0.8) {
      ch.healthy = false;
    }
    this._save();
  }

  acquireConcurrency(channelId) {
    const ch = this._channelIndex.get(channelId);
    if (!ch) return;
    ch.currentConcurrent++;
  }

  releaseConcurrency(channelId) {
    const ch = this._channelIndex.get(channelId);
    if (!ch) return;
    if (ch.currentConcurrent > 0) ch.currentConcurrent--;
  }

  /**
   * Get all channels (for admin)
   */
  getAllChannels() {
    return this.channels.map(ch => ({
      ...ch,
      keys: ch.keys.map(k => k.length > 10 ? k.substring(0, 6) + '***' + k.substring(k.length - 4) : '***'),
    }));
  }

  /**
   * Get channel by ID
   */
  getChannelById(id) {
    return this._channelIndex.get(id) || null;
  }

  /**
   * Get summary
   */
  getSummary() {
    let total = this.channels.length;
    let enabled = 0, healthy = 0, disabled = 0;
    for (const ch of this.channels) {
      if (!ch.enabled) disabled++;
      else if (ch.healthy) { enabled++; healthy++; }
      else enabled++;
    }
    return { total, enabled, healthy, disabled };
  }

  /**
   * Check if channel system is active (any channels configured)
   */
  isActive() {
    return this.channels.length > 0;
  }

  /**
   * Health check all channels
   */
  async checkAllHealth() {
    const results = [];
    for (const ch of this.channels) {
      if (!ch.enabled) continue;
      try {
        const url = ch.baseUrl.endsWith('/api')
          ? `${ch.baseUrl}/tags`
          : `${ch.baseUrl}/api/tags`;

        const headers = {};
        if (ch.keys.length > 0) {
          headers['Authorization'] = `Bearer ${ch.keys[0]}`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        clearTimeout(timeout);

        ch.healthy = res.ok;
        ch.lastError = res.ok ? null : `HTTP ${res.status}`;
      } catch (e) {
        ch.healthy = false;
        ch.lastError = e.name === 'AbortError' ? 'Timeout' : e.message;
      }
      results.push({ id: ch.id, name: ch.name, healthy: ch.healthy });
    }
    this._save();
    return results;
  }

  resetHealth() {
    for (const ch of this.channels) {
      ch.healthy = true;
      ch.lastError = null;
      ch.currentConcurrent = 0;
    }
    this._saveSync();
  }
}

const channelManager = new ChannelManager();
export default channelManager;
