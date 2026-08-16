import { EventEmitter } from 'events';

class LiveLogger extends EventEmitter {
  constructor() {
    super();
    this.logsHistory = [];
    this.maxHistory = 300;
  }

  sanitize(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/(gsk_[a-zA-Z0-9_-]{6})[a-zA-Z0-9_-]+([a-zA-Z0-9_-]{4})/g, '$1...$2')
      .replace(/(nvapi-[a-zA-Z0-9_-]{6})[a-zA-Z0-9_-]+([a-zA-Z0-9_-]{4})/g, '$1...$2')
      .replace(/(Bearer\s+[a-zA-Z0-9._-]{6})[a-zA-Z0-9._-]+/gi, '$1[REDACTED]')
      .replace(/("password"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
      .replace(/("salt"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
      .replace(/("passwordHash"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
      .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]{40,}/gi, '[BASE64_IMAGE_PAYLOAD]');
  }

  log(level, message, details = null, userId = null) {
    const timestamp = new Date().toISOString();
    const cleanMessage = this.sanitize(typeof message === 'string' ? message : JSON.stringify(message));
    let cleanDetails = null;
    if (details) {
      cleanDetails = this.sanitize(typeof details === 'object' ? JSON.stringify(details) : String(details));
    }

    const isTagged = cleanMessage && cleanMessage.startsWith('[');
    const userTag = userId ? `[USER:${userId}] ` : '';
    const formatted = isTagged
      ? `[${timestamp}] ${userTag}${cleanMessage}`
      : `[${timestamp}] [${level.toUpperCase()}] ${userTag}${cleanMessage}`;

    if (level === 'error') {
      console.error(formatted, cleanDetails || '');
    } else if (level === 'warn') {
      console.warn(formatted, cleanDetails || '');
    } else {
      console.log(formatted, cleanDetails || '');
    }

    const logEntry = {
      id: Date.now() + Math.random().toString(36).substr(2, 5),
      timestamp,
      level,
      message: cleanMessage,
      userId: userId || null,
      details: cleanDetails
    };

    this.logsHistory.push(logEntry);
    if (this.logsHistory.length > this.maxHistory) {
      this.logsHistory.shift();
    }

    this.emit('log', logEntry);
  }

  info(msg, details = null, userId = null) { this.log('info', msg, details, userId); }
  warn(msg, details = null, userId = null) { this.log('warn', msg, details, userId); }
  error(msg, details = null, userId = null) { this.log('error', msg, details, userId); }
  success(msg, details = null, userId = null) { this.log('success', msg, details, userId); }

  getHistory(userId = null) {
    if (!userId || userId === 'all') {
      return this.logsHistory;
    }
    return this.logsHistory.filter(l => l.userId === userId);
  }

  clearHistory(userId = null) {
    if (!userId || userId === 'all') {
      this.logsHistory = [];
    } else {
      this.logsHistory = this.logsHistory.filter(l => l.userId !== userId);
    }
  }

  forUser(userId) {
    return {
      info: (msg, details) => this.info(msg, details, userId),
      warn: (msg, details) => this.warn(msg, details, userId),
      error: (msg, details) => this.error(msg, details, userId),
      success: (msg, details) => this.success(msg, details, userId),
      clear: () => this.clearHistory(userId)
    };
  }
}

export const logger = new LiveLogger();
