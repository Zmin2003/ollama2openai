/**
 * Rate Limiter - Enterprise-grade rate limiting
 * Supports: per-IP, per-token, global limits with sliding window
 */

class SlidingWindowCounter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.windows = new Map(); // key -> { count, timestamp }
  }

  /**
   * Check if request is allowed and consume a slot
   * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
   */
  consume(key) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let entry = this.windows.get(key);

    if (!entry || entry.windowStart < windowStart) {
      // Start new window
      entry = { count: 0, windowStart: now, requests: [] };
      this.windows.set(key, entry);
    }

    // Clean old requests within the window
    entry.requests = entry.requests.filter(t => t > windowStart);
    entry.count = entry.requests.length;

    if (entry.count >= this.maxRequests) {
      const oldestInWindow = entry.requests[0] || now;
      const resetAt = oldestInWindow + this.windowMs;
      return {
        allowed: false,
        remaining: 0,
        resetAt: Math.ceil(resetAt / 1000),
        retryAfter: Math.ceil((resetAt - now) / 1000),
      };
    }

    entry.requests.push(now);
    entry.count++;

    return {
      allowed: true,
      remaining: this.maxRequests - entry.count,
      resetAt: Math.ceil((now + this.windowMs) / 1000),
    };
  }

  /**
   * Periodic cleanup of expired windows
   */
  cleanup() {
    const cutoff = Date.now() - this.windowMs * 2;
    for (const [key, entry] of this.windows) {
      if (entry.windowStart < cutoff) {
        this.windows.delete(key);
      }
    }
  }

  getStats() {
    return {
      activeKeys: this.windows.size,
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
    };
  }
}

class RateLimiter {
  constructor() {
    // Global rate limit
    this.globalEnabled = process.env.RATE_LIMIT_GLOBAL_ENABLED !== 'false';
    this.globalLimit = new SlidingWindowCounter(
      parseInt(process.env.RATE_LIMIT_GLOBAL_WINDOW || '60000'),  // 1 min
      parseInt(process.env.RATE_LIMIT_GLOBAL_MAX || '500')         // 500 req/min
    );

    // Per-IP rate limit
    this.ipEnabled = process.env.RATE_LIMIT_IP_ENABLED !== 'false';
    this.ipLimit = new SlidingWindowCounter(
      parseInt(process.env.RATE_LIMIT_IP_WINDOW || '60000'),       // 1 min
      parseInt(process.env.RATE_LIMIT_IP_MAX || '60')              // 60 req/min per IP
    );

    // Per-token rate limit
    this.tokenEnabled = process.env.RATE_LIMIT_TOKEN_ENABLED !== 'false';
    this.tokenLimit = new SlidingWindowCounter(
      parseInt(process.env.RATE_LIMIT_TOKEN_WINDOW || '60000'),    // 1 min
      parseInt(process.env.RATE_LIMIT_TOKEN_MAX || '120')          // 120 req/min per token
    );

    // Cleanup every 5 minutes
    this._cleanupTimer = setInterval(() => {
      this.globalLimit.cleanup();
      this.ipLimit.cleanup();
      this.tokenLimit.cleanup();
    }, 300000);
    this._cleanupTimer.unref();
  }

  /**
   * Check all rate limits for a request
   * @returns {{ allowed: boolean, limitType?: string, remaining?: number, resetAt?: number, retryAfter?: number }}
   */
  check(ip, tokenId) {
    // Global limit
    if (this.globalEnabled) {
      const globalResult = this.globalLimit.consume('global');
      if (!globalResult.allowed) {
        return { allowed: false, limitType: 'global', ...globalResult };
      }
    }

    // Per-IP limit
    if (this.ipEnabled && ip) {
      const ipResult = this.ipLimit.consume(ip);
      if (!ipResult.allowed) {
        return { allowed: false, limitType: 'ip', ...ipResult };
      }
    }

    // Per-token limit
    if (this.tokenEnabled && tokenId) {
      const tokenResult = this.tokenLimit.consume(tokenId);
      if (!tokenResult.allowed) {
        return { allowed: false, limitType: 'token', ...tokenResult };
      }
    }

    return { allowed: true };
  }

  /**
   * Update limits for a specific token (custom per-token limits)
   */
  setTokenLimit(tokenId, maxRequests, windowMs) {
    // For custom per-token limits, we'd need a separate counter per token
    // This is handled by the tokenManager which stores per-token rate limits
  }

  getStats() {
    return {
      global: this.globalEnabled ? this.globalLimit.getStats() : 'disabled',
      ip: this.ipEnabled ? this.ipLimit.getStats() : 'disabled',
      token: this.tokenEnabled ? this.tokenLimit.getStats() : 'disabled',
    };
  }

  shutdown() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }
  }
}

const rateLimiter = new RateLimiter();
export default rateLimiter;
