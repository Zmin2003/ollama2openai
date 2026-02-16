/**
 * Metrics - Prometheus-compatible metrics collection
 * Exposes /metrics endpoint in Prometheus text format
 */

class Counter {
  constructor(name, help, labels = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.values = new Map();
  }

  inc(labelValues = {}, value = 1) {
    const key = this._labelKey(labelValues);
    this.values.set(key, (this.values.get(key) || 0) + value);
  }

  _labelKey(labelValues) {
    if (this.labels.length === 0) return '';
    return this.labels.map(l => `${l}="${labelValues[l] || ''}"`).join(',');
  }

  toPrometheus() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this.values) {
        if (key) lines.push(`${this.name}{${key}} ${val}`);
        else lines.push(`${this.name} ${val}`);
      }
    }
    return lines.join('\n');
  }
}

class Gauge {
  constructor(name, help, labels = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.values = new Map();
  }

  set(labelValues = {}, value) {
    const key = this._labelKey(labelValues);
    this.values.set(key, value);
  }

  inc(labelValues = {}, value = 1) {
    const key = this._labelKey(labelValues);
    this.values.set(key, (this.values.get(key) || 0) + value);
  }

  dec(labelValues = {}, value = 1) {
    const key = this._labelKey(labelValues);
    this.values.set(key, (this.values.get(key) || 0) - value);
  }

  _labelKey(labelValues) {
    if (this.labels.length === 0) return '';
    return this.labels.map(l => `${l}="${labelValues[l] || ''}"`).join(',');
  }

  toPrometheus() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this.values) {
        if (key) lines.push(`${this.name}{${key}} ${val}`);
        else lines.push(`${this.name} ${val}`);
      }
    }
    return lines.join('\n');
  }
}

class Histogram {
  constructor(name, help, labels = [], buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.buckets = buckets.sort((a, b) => a - b);
    this.observations = new Map();
  }

  observe(labelValues = {}, value) {
    const key = this._labelKey(labelValues);
    if (!this.observations.has(key)) {
      this.observations.set(key, { sum: 0, count: 0, buckets: new Array(this.buckets.length).fill(0) });
    }
    const obs = this.observations.get(key);
    obs.sum += value;
    obs.count++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) obs.buckets[i]++;
    }
  }

  _labelKey(labelValues) {
    if (this.labels.length === 0) return '';
    return this.labels.map(l => `${l}="${labelValues[l] || ''}"`).join(',');
  }

  toPrometheus() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, obs] of this.observations) {
      const prefix = key ? `${this.name}{${key}` : `${this.name}{`;
      for (let i = 0; i < this.buckets.length; i++) {
        const cumulative = obs.buckets.slice(0, i + 1).reduce((a, b) => a + b, 0);
        lines.push(`${prefix}${key ? ',' : ''}le="${this.buckets[i]}"} ${cumulative}`);
      }
      lines.push(`${prefix}${key ? ',' : ''}le="+Inf"} ${obs.count}`);
      const sumKey = key ? `${this.name}_sum{${key}}` : `${this.name}_sum`;
      const countKey = key ? `${this.name}_count{${key}}` : `${this.name}_count`;
      lines.push(`${sumKey} ${obs.sum}`);
      lines.push(`${countKey} ${obs.count}`);
    }
    return lines.join('\n');
  }
}

class MetricsCollector {
  constructor() {
    // Request counters
    this.requestsTotal = new Counter(
      'ollama2openai_requests_total',
      'Total number of API requests',
      ['method', 'endpoint', 'status']
    );

    // Active connections
    this.activeConnections = new Gauge(
      'ollama2openai_active_connections',
      'Number of active connections'
    );

    // Request duration
    this.requestDuration = new Histogram(
      'ollama2openai_request_duration_seconds',
      'Request duration in seconds',
      ['method', 'endpoint'],
      [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]
    );

    // Token usage
    this.tokensTotal = new Counter(
      'ollama2openai_tokens_total',
      'Total tokens processed',
      ['type'] // prompt, completion
    );

    // Key health
    this.keysHealthy = new Gauge(
      'ollama2openai_keys_healthy',
      'Number of healthy keys'
    );

    this.keysTotal = new Gauge(
      'ollama2openai_keys_total',
      'Total number of keys'
    );

    // Cache
    this.cacheHits = new Counter(
      'ollama2openai_cache_hits_total',
      'Total cache hits',
      ['cache_type']
    );

    this.cacheMisses = new Counter(
      'ollama2openai_cache_misses_total',
      'Total cache misses',
      ['cache_type']
    );

    // Rate limit hits
    this.rateLimitHits = new Counter(
      'ollama2openai_rate_limit_hits_total',
      'Total rate limit rejections',
      ['limit_type']
    );

    // Upstream errors
    this.upstreamErrors = new Counter(
      'ollama2openai_upstream_errors_total',
      'Total upstream (Ollama) errors',
      ['error_type']
    );

    // Stream metrics
    this.activeStreams = new Gauge(
      'ollama2openai_active_streams',
      'Number of active streaming connections'
    );

    // Uptime
    this._startTime = Date.now();
  }

  /**
   * Generate Prometheus text format output
   */
  toPrometheus() {
    const uptimeGauge = new Gauge('ollama2openai_uptime_seconds', 'Process uptime in seconds');
    uptimeGauge.set({}, Math.floor((Date.now() - this._startTime) / 1000));

    const memGauge = new Gauge('ollama2openai_memory_bytes', 'Process memory usage', ['type']);
    const mem = process.memoryUsage();
    memGauge.set({ type: 'rss' }, mem.rss);
    memGauge.set({ type: 'heap_used' }, mem.heapUsed);
    memGauge.set({ type: 'heap_total' }, mem.heapTotal);

    const parts = [
      this.requestsTotal.toPrometheus(),
      this.activeConnections.toPrometheus(),
      this.requestDuration.toPrometheus(),
      this.tokensTotal.toPrometheus(),
      this.keysHealthy.toPrometheus(),
      this.keysTotal.toPrometheus(),
      this.cacheHits.toPrometheus(),
      this.cacheMisses.toPrometheus(),
      this.rateLimitHits.toPrometheus(),
      this.upstreamErrors.toPrometheus(),
      this.activeStreams.toPrometheus(),
      uptimeGauge.toPrometheus(),
      memGauge.toPrometheus(),
    ];

    return parts.join('\n\n') + '\n';
  }

  /**
   * Get JSON summary for admin panel
   */
  getSummary() {
    const mem = process.memoryUsage();
    return {
      uptime: Math.floor((Date.now() - this._startTime) / 1000),
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      requests: this._sumCounter(this.requestsTotal),
      activeConnections: this._sumGauge(this.activeConnections),
      activeStreams: this._sumGauge(this.activeStreams),
    };
  }

  _sumCounter(counter) {
    let sum = 0;
    for (const val of counter.values.values()) sum += val;
    return sum;
  }

  _sumGauge(gauge) {
    let sum = 0;
    for (const val of gauge.values.values()) sum += val;
    return sum;
  }
}

const metrics = new MetricsCollector();
export default metrics;
