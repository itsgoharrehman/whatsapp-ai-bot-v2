import { config } from '../config.js';
import { logger } from './logger.js';
import { db } from './db.js';

export class AntiBanManager {
  constructor(userId = 'user_gohar') {
    this.userId = userId;
    this.replyTimestamps = new Map();
    this.userLogger = logger.forUser(this.userId);
  }

  checkRateLimit(jid) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxAllowed = config.rateLimitMaxPerMinute;

    if (!this.replyTimestamps.has(jid)) {
      this.replyTimestamps.set(jid, []);
    }

    const timestamps = this.replyTimestamps.get(jid);
    const recentTimestamps = timestamps.filter(ts => (now - ts) < windowMs);
    this.replyTimestamps.set(jid, recentTimestamps);

    if (recentTimestamps.length >= maxAllowed) {
      this.userLogger.warn(`Anti-Ban Rate Limit triggered for ${jid}. (${recentTimestamps.length}/${maxAllowed} msgs in last min)`);
      db.incrementMetric(this.userId, 'rateLimitedCount');
      return false;
    }

    return true;
  }

  recordReply(jid) {
    if (!this.replyTimestamps.has(jid)) {
      this.replyTimestamps.set(jid, []);
    }
    this.replyTimestamps.get(jid).push(Date.now());
    db.incrementMetric(this.userId, 'totalRepliesSent');
  }

  /**
   * Smooth presence sequence:
   * 1. Brief silent pause (2 seconds)
   * 2. Active typing animation (3-5 seconds)
   */
  async applyHumanDelay(sock, jid) {
    const totalMinMs = config.antiBanMinDelayMs || 5000;
    const totalMaxMs = config.antiBanMaxDelayMs || 8000;
    const totalDelay = Math.floor(Math.random() * (totalMaxMs - totalMinMs + 1)) + totalMinMs;

    // Phase 1: Silent thinking phase (2 seconds)
    const silentMs = 2000;
    const typingMs = Math.max(totalDelay - silentMs, 2000);

    this.userLogger.info(`[ANTI-BAN] Chat: ${jid} | Sequence: ${silentMs}ms pause -> ${typingMs}ms typing simulation`);

    await new Promise(resolve => setTimeout(resolve, silentMs));

    // Phase 2: Typing animation phase
    try {
      if (sock && typeof sock.sendPresenceUpdate === 'function') {
        await sock.sendPresenceUpdate('composing', jid);
      }
    } catch (err) {}

    await new Promise(resolve => setTimeout(resolve, typingMs));
  }
}

export const antiBan = new AntiBanManager('user_gohar');
