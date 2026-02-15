/**
 * LRU Cache for API responses
 * Caches embeddings and chat completions to reduce backend load
 */

import crypto from 'crypto';

/**
 * Simple LRU Cache implementation
 */
class LRUCache {
  constructor(maxSize = 1000, maxAge = 1000 * 60 * 60) { // Default: 1000 items, 1 hour
    this.maxSize = maxSize;
    this.maxAge = maxAge;
    this.cache = new Map(); // Using Map for O(1) access and insertion order
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
    };
  }

  /**
   * Generate cache key from model and input
   */
  static generateKey(model, input) {
    // Normalize input to string for hashing
    let inputStr;
    if (typeof input === 'string') {
      inputStr = input;
    } else if (Array.isArray(input)) {
      inputStr = JSON.stringify(input);
    } else {
      inputStr = JSON.stringify(input);
    }
    
    // Create hash for consistent key length
    const hash = crypto
      .createHash('sha256')
      .update(`${model}:${inputStr}`)
      .digest('hex');
    
    return hash;
  }

  /**
   * Generate cache key for chat messages
   */
  static generateChatKey(model, messages, options = {}) {
    const keyData = {
      model,
      messages,
      // Include relevant options that affect output
      temperature: options.temperature,
      top_p: options.top_p,
      max_tokens: options.max_tokens,
      response_format: options.response_format,
      tools: options.tools,
    };
    
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(keyData))
      .digest('hex');
  }

  /**
   * Get item from cache
   */
  get(key) {
    const item = this.cache.get(key);
    
    if (!item) {
      this.stats.misses++;
      return null;
    }

    // Check expiration
    if (Date.now() - item.timestamp > this.maxAge) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, item);
    this.stats.hits++;
    
    return item.value;
  }

  /**
   * Set item in cache
   */
  set(key, value) {
    // Remove if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if key exists and is not expired
   */
  has(key) {
    const item = this.cache.get(key);
    if (!item) return false;
    
    if (Date.now() - item.timestamp > this.maxAge) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Delete item from cache
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Clear entire cache
   */
  clear() {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Get cache size
   */
  get size() {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(2) + '%' : '0%',
    };
  }

  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > this.maxAge) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}

/**
 * Cache manager - manages separate caches for different endpoint types
 */
class CacheManager {
  constructor() {
    this.enabled = {
      embeddings: process.env.CACHE_EMBEDDINGS !== 'false', // Default: true
      chat: process.env.CACHE_CHAT === 'true', // Default: false
    };

    // Separate caches for different types
    this.embeddingsCache = new LRUCache(
      parseInt(process.env.CACHE_EMBEDDINGS_MAX_SIZE || '5000'),
      parseInt(process.env.CACHE_EMBEDDINGS_MAX_AGE || '86400000') // 24 hours
    );

    this.chatCache = new LRUCache(
      parseInt(process.env.CACHE_CHAT_MAX_SIZE || '1000'),
      parseInt(process.env.CACHE_CHAT_MAX_AGE || '3600000') // 1 hour
    );

    // Periodic cleanup (every 10 minutes)
    this._cleanupInterval = setInterval(() => {
      this.embeddingsCache.cleanup();
      this.chatCache.cleanup();
    }, 600000);
  }

  /**
   * Get embeddings cache
   */
  getEmbeddingsCache() {
    return this.enabled.embeddings ? this.embeddingsCache : null;
  }

  /**
   * Get chat cache
   */
  getChatCache() {
    return this.enabled.chat ? this.chatCache : null;
  }

  /**
   * Get combined statistics
   */
  getStats() {
    return {
      enabled: this.enabled,
      embeddings: this.embeddingsCache.getStats(),
      chat: this.chatCache.getStats(),
    };
  }

  /**
   * Clear all caches
   */
  clearAll() {
    this.embeddingsCache.clear();
    this.chatCache.clear();
  }

  /**
   * Shutdown cleanup
   */
  shutdown() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
  }
}

// Singleton
const cacheManager = new CacheManager();

// Graceful shutdown
process.on('SIGINT', () => {
  cacheManager.shutdown();
});
process.on('SIGTERM', () => {
  cacheManager.shutdown();
});

export { LRUCache, CacheManager };
export default cacheManager;