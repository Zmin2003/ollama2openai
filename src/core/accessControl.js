/**
 * Access Control - IP whitelist/blacklist management
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ACCESS_FILE = path.join(DATA_DIR, 'access.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

class AccessControl {
  constructor() {
    this.mode = process.env.IP_ACCESS_MODE || 'disabled'; // disabled, whitelist, blacklist
    this.whitelist = new Set();
    this.blacklist = new Set();

    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(ACCESS_FILE)) {
        const data = JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf-8'));
        this.mode = data.mode || this.mode;
        this.whitelist = new Set(data.whitelist || []);
        this.blacklist = new Set(data.blacklist || []);
      }
    } catch (e) {
      console.error('[AccessControl] Failed to load:', e.message);
    }

    // Load from env if present
    if (process.env.IP_WHITELIST) {
      process.env.IP_WHITELIST.split(',').map(ip => ip.trim()).filter(Boolean).forEach(ip => this.whitelist.add(ip));
    }
    if (process.env.IP_BLACKLIST) {
      process.env.IP_BLACKLIST.split(',').map(ip => ip.trim()).filter(Boolean).forEach(ip => this.blacklist.add(ip));
    }
  }

  _save() {
    try {
      fs.writeFileSync(ACCESS_FILE, JSON.stringify({
        mode: this.mode,
        whitelist: [...this.whitelist],
        blacklist: [...this.blacklist],
      }, null, 2));
    } catch (e) {
      console.error('[AccessControl] Failed to save:', e.message);
    }
  }

  /**
   * Check if an IP is allowed
   */
  isAllowed(ip) {
    if (this.mode === 'disabled') return true;

    // Normalize IP
    const normalizedIP = this._normalizeIP(ip);

    if (this.mode === 'whitelist') {
      return this.whitelist.size === 0 || this._matchesSet(normalizedIP, this.whitelist);
    }

    if (this.mode === 'blacklist') {
      return !this._matchesSet(normalizedIP, this.blacklist);
    }

    return true;
  }

  /**
   * Check if IP matches any entry in the set (supports CIDR notation)
   */
  _matchesSet(ip, set) {
    for (const entry of set) {
      if (entry.includes('/')) {
        if (this._matchesCIDR(ip, entry)) return true;
      } else {
        if (ip === entry || ip === this._normalizeIP(entry)) return true;
      }
    }
    return false;
  }

  /**
   * Simple CIDR match for IPv4
   */
  _matchesCIDR(ip, cidr) {
    try {
      const [range, bits] = cidr.split('/');
      const mask = ~(2 ** (32 - parseInt(bits)) - 1);
      const ipNum = this._ipToNum(ip);
      const rangeNum = this._ipToNum(range);
      if (ipNum === null || rangeNum === null) return false;
      return (ipNum & mask) === (rangeNum & mask);
    } catch {
      return false;
    }
  }

  _ipToNum(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
    return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  }

  _normalizeIP(ip) {
    if (!ip) return '';
    // Handle IPv6-mapped IPv4
    if (ip.startsWith('::ffff:')) return ip.substring(7);
    if (ip === '::1') return '127.0.0.1';
    return ip;
  }

  // Management methods
  setMode(mode) {
    if (!['disabled', 'whitelist', 'blacklist'].includes(mode)) return false;
    this.mode = mode;
    this._save();
    return true;
  }

  addToWhitelist(ip) { this.whitelist.add(ip); this._save(); }
  removeFromWhitelist(ip) { this.whitelist.delete(ip); this._save(); }
  addToBlacklist(ip) { this.blacklist.add(ip); this._save(); }
  removeFromBlacklist(ip) { this.blacklist.delete(ip); this._save(); }

  getConfig() {
    return {
      mode: this.mode,
      whitelist: [...this.whitelist],
      blacklist: [...this.blacklist],
    };
  }
}

const accessControl = new AccessControl();
export default accessControl;
