import { EventEmitter } from 'events';

class LiveLogger extends EventEmitter {
  constructor() {
    super();
    this.logsHistory = [];
    this.maxHistory = 300;
  }

  log(level, message, details = null, userId = null) {
    const timestamp = new Date().toISOString();
    const isTagged = message && typeof message === 'string' && message.startsWith('[');
    const userTag = userId ? `[USER:${userId}] ` : '';
    const formatted = isTagged
      ? `[${timestamp}] ${userTag}${message}`
      : `[${timestamp}] [${level.toUpperCase()}] ${userTag}${message}`;

    if (level === 'error') {
      console.error(formatted, details || '');
    } else if (level === 'warn') {
      console.warn(formatted, details || '');
    } else {
      console.log(formatted, details || '');
    }

    const logEntry = {
      id: Date.now() + Math.random().toString(36).substr(2, 5),
      timestamp,
      level,
      message,
      userId: userId || null,
      details: details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null
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
    return this.logsHistory.filter(l => l.userId === userId || l.userId === null);
  }

  forUser(userId) {
    return {
      info: (msg, details) => this.info(msg, details, userId),
      warn: (msg, details) => this.warn(msg, details, userId),
      error: (msg, details) => this.error(msg, details, userId),
      success: (msg, details) => this.success(msg, details, userId)
    };
  }
}

export const logger = new LiveLogger();
