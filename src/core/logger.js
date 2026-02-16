/**
 * Structured Logger - Enterprise-grade logging system
 * Supports: JSON structured logs, log levels, request tracing, audit logging
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const AUDIT_FILE = path.join(LOGS_DIR, 'audit.jsonl');
const REQUEST_LOG_FILE = path.join(LOGS_DIR, 'requests.jsonl');

// Ensure directories exist
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  constructor() {
    this.level = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] || 1;
    this.enableFileLog = process.env.LOG_TO_FILE === 'true';
    this.maxLogFileSize = parseInt(process.env.LOG_MAX_FILE_SIZE || '52428800'); // 50MB
    this._requestLogs = [];
    this._auditLogs = [];
    this._flushTimer = null;
    this._flushDelay = 2000;

    // In-memory ring buffer for recent logs (viewable in admin)
    this._recentLogs = [];
    this._maxRecentLogs = parseInt(process.env.LOG_RECENT_MAX || '500');

    this._startFlushTimer();
  }

  _startFlushTimer() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => this._flush(), this._flushDelay);
    this._flushTimer.unref();
  }

  _formatLog(level, component, message, meta = {}) {
    return {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...meta,
    };
  }

  _output(level, component, message, meta = {}) {
    if (LOG_LEVELS[level] < this.level) return;

    const entry = this._formatLog(level, component, message, meta);

    // Console output
    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${component}]`;
    if (level === 'error') {
      console.error(`${prefix} ${message}`, meta.error || '');
    } else if (level === 'warn') {
      console.warn(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }

    // Ring buffer
    this._recentLogs.push(entry);
    if (this._recentLogs.length > this._maxRecentLogs) {
      this._recentLogs.shift();
    }

    return entry;
  }

  debug(component, message, meta) { return this._output('debug', component, message, meta); }
  info(component, message, meta) { return this._output('info', component, message, meta); }
  warn(component, message, meta) { return this._output('warn', component, message, meta); }
  error(component, message, meta) { return this._output('error', component, message, meta); }

  /**
   * Log an API request (stored in ring buffer + optionally file)
   */
  logRequest(data) {
    const entry = {
      timestamp: new Date().toISOString(),
      type: 'request',
      ...data,
    };

    this._recentLogs.push(entry);
    if (this._recentLogs.length > this._maxRecentLogs) {
      this._recentLogs.shift();
    }

    if (this.enableFileLog) {
      this._requestLogs.push(JSON.stringify(entry));
    }
  }

  /**
   * Log an admin audit event
   */
  audit(action, actor, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      type: 'audit',
      action,
      actor,
      ...details,
    };

    this.info('Audit', `${actor} -> ${action}`, details);

    this._auditLogs.push(JSON.stringify(entry));

    this._recentLogs.push(entry);
    if (this._recentLogs.length > this._maxRecentLogs) {
      this._recentLogs.shift();
    }
  }

  /**
   * Get recent logs (for admin panel)
   */
  getRecentLogs(options = {}) {
    let logs = [...this._recentLogs];

    if (options.type) {
      logs = logs.filter(l => l.type === options.type);
    }
    if (options.level) {
      const minLevel = LOG_LEVELS[options.level] || 0;
      logs = logs.filter(l => LOG_LEVELS[l.level] >= minLevel);
    }
    if (options.component) {
      logs = logs.filter(l => l.component === options.component);
    }
    if (options.limit) {
      logs = logs.slice(-options.limit);
    }

    return logs.reverse(); // Most recent first
  }

  /**
   * Flush logs to disk
   */
  _flush() {
    if (this._requestLogs.length > 0 && this.enableFileLog) {
      const data = this._requestLogs.join('\n') + '\n';
      this._requestLogs = [];
      fs.appendFile(REQUEST_LOG_FILE, data, (err) => {
        if (err) console.error('[Logger] Failed to write request logs:', err.message);
      });
    }

    if (this._auditLogs.length > 0) {
      const data = this._auditLogs.join('\n') + '\n';
      this._auditLogs = [];
      fs.appendFile(AUDIT_FILE, data, (err) => {
        if (err) console.error('[Logger] Failed to write audit logs:', err.message);
      });
    }
  }

  /**
   * Flush synchronously (for graceful shutdown)
   */
  flushSync() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    try {
      if (this._requestLogs.length > 0 && this.enableFileLog) {
        fs.appendFileSync(REQUEST_LOG_FILE, this._requestLogs.join('\n') + '\n');
        this._requestLogs = [];
      }
      if (this._auditLogs.length > 0) {
        fs.appendFileSync(AUDIT_FILE, this._auditLogs.join('\n') + '\n');
        this._auditLogs = [];
      }
    } catch (e) {
      console.error('[Logger] Failed to flush logs:', e.message);
    }
  }

  /**
   * Clear recent logs
   */
  clearRecent() {
    this._recentLogs = [];
  }
}

const logger = new Logger();
export default logger;
