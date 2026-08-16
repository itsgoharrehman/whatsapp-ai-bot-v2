import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { db } from './utils/db.js';
import { AntiBanManager } from './utils/antiBan.js';
import { AIProviderManager } from './ai/provider.js';
import permissionChecker from './utils/permissionChecker.js';
import adminCommands from './commands/admin.js';

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, QRCode, pino;

try {
  const baileys = await import('@whiskeysockets/baileys');
  makeWASocket = baileys.default;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  downloadMediaMessage = baileys.downloadMediaMessage;

  QRCode = (await import('qrcode')).default;
  pino = (await import('pino')).default;
} catch (err) {}

export class BoundedTtlSet {
  constructor(maxSize = 2000, ttlMs = 15 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  has(key) {
    if (!key) return false;
    const ts = this.items.get(key);
    if (!ts) return false;
    if (Date.now() - ts > this.ttlMs) {
      this.items.delete(key);
      return false;
    }
    return true;
  }

  add(key) {
    if (!key) return;
    const now = Date.now();
    this.items.set(key, now);
    if (this.items.size > this.maxSize) {
      const cutoff = now - this.ttlMs;
      for (const [k, v] of this.items.entries()) {
        if (v < cutoff || this.items.size > this.maxSize) {
          this.items.delete(k);
        }
      }
    }
  }

  clear() {
    this.items.clear();
  }
}

export class UserBotSession extends EventEmitter {
  constructor(userId) {
    super();
    this.userId = userId;
    this.sessionDir = path.join(config.sessionDir, userId);
    this.sock = null;
    this.qrCodeDataUrl = null;
    this.status = 'DISCONNECTED';
    this.botJid = null;
    this.botLid = null;
    this.isStopping = false;
    this.sentBotMsgIds = new BoundedTtlSet(2000, 30 * 60 * 1000);
    this.processedInboundMsgIds = new BoundedTtlSet(2000, 15 * 60 * 1000);
    this.reconnectTimer = null;
    this.antiBan = new AntiBanManager(this.userId);
    this.aiProvider = new AIProviderManager(this.userId);
    this.userLogger = logger.forUser(this.userId);
  }

  getOwnerNumber() {
    return db.getOwnerNumber(this.userId) || config.ownerNumber || '';
  }

  async start(forceNewSession = false) {
    if (this.status === 'CONNECTING' || (this.status === 'CONNECTED' && !forceNewSession)) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!makeWASocket) {
      this.status = 'DISCONNECTED';
      this.emit('status', this.status);
      return;
    }

    if (forceNewSession) {
      await this.resetSession();
    }

    if (this.sock) {
      try { await this.sock.end(); } catch (err) {}
      this.sock = null;
    }

    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }

    this.isStopping = false;
    this.status = 'CONNECTING';
    this.emit('status', this.status);

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Mark Zuckerberg', 'Chrome', '1.0.0']
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && this.status !== 'CONNECTED') {
          this.status = 'QR_READY';
          if (QRCode) this.qrCodeDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
          this.emit('qr', this.qrCodeDataUrl);
          this.emit('status', this.status);
        }

        if (connection === 'open') {
          this.status = 'CONNECTED';
          this.qrCodeDataUrl = null;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.botJid = this.sock.user?.id || null;
          this.botLid = this.sock.user?.lid || this.sock.authState?.creds?.me?.lid || null;
          this.userLogger.info(`[SYSTEM] WhatsApp Bot Connected! JID: ${this.botJid} (LID: ${this.botLid})`);
          this.emit('status', this.status);
        }

        if (connection === 'close') {
          this.qrCodeDataUrl = null;
          this.status = 'DISCONNECTED';
          this.emit('status', this.status);
          if (!this.isStopping) {
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.start(), 5000);
          }
        }
      });

      this.sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
          await this.handleIncomingMessage(msg);
        }
      });

    } catch (err) {
      this.userLogger.error('Failed to initialize WhatsApp socket:', err.message);
      this.status = 'DISCONNECTED';
      this.emit('status', this.status);
    }
  }

  async stop() {
    this.isStopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try { await this.sock.end(); } catch (err) {}
      this.sock = null;
    }
    this.status = 'DISCONNECTED';
    this.qrCodeDataUrl = null;
    this.emit('status', this.status);
  }

  async resetSession() {
    this.userLogger.info('Resetting session & purging local credentials directory...');
    await this.stop();
    try {
      if (fs.existsSync(this.sessionDir)) {
        fs.rmSync(this.sessionDir, { recursive: true, force: true });
      }
    } catch (err) {
      this.userLogger.error('Error clearing session dir:', err.message);
    }
    this.qrCodeDataUrl = null;
    this.status = 'DISCONNECTED';
    this.emit('status', this.status);
  }

  async dispatchMessage(chatJid, content, isGroup = false, originalMsg = null) {
    if (!this.sock) return false;
    try {
      const options = isGroup && originalMsg ? { quoted: originalMsg } : {};
      const res = await this.sock.sendMessage(chatJid, content, options);
      if (res?.key?.id) {
        this.sentBotMsgIds.add(res.key.id);
      }
      return true;
    } catch (err) {
      this.userLogger.error(`Send message to ${chatJid} failed:`, err.message);
      return false;
    }
  }

  async handleIncomingMessage(m) {
    try {
      if (!m || !m.message || !m.key) return;
      const chatJid = m.key.remoteJid;
      const isFromMe = m.key.fromMe;
      const msgId = m.key.id;
      const senderJid = m.key.participant || m.key.remoteJid;

      if (!msgId || !chatJid) return;
      if (permissionChecker.isBroadcastOrNewsletter(chatJid)) return;

      const dedupeKey = `${chatJid}:${msgId}`;
      if (this.processedInboundMsgIds.has(dedupeKey) || this.processedInboundMsgIds.has(msgId)) {
        return;
      }
      this.processedInboundMsgIds.add(dedupeKey);
      this.processedInboundMsgIds.add(msgId);

      if (isFromMe && this.sentBotMsgIds.has(msgId)) {
        return;
      }

      const unwrapped = permissionChecker.unwrapMessage(m);
      if (!unwrapped) return;

      const hasMedia = permissionChecker.hasMedia(unwrapped);
      const mediaType = permissionChecker.detectMediaType(unwrapped);
      const rawText = permissionChecker.extractMessageText(unwrapped);
      const messageText = rawText || (hasMedia ? `[${mediaType.toUpperCase()} Message]` : '');
      if (!messageText || !messageText.trim()) return;

      const isGroup = permissionChecker.isGroup(chatJid);
      const isOwner = isFromMe || adminCommands.isOwner(senderJid, isFromMe, this.userId);
      const senderLabel = isOwner ? 'OWNER' : 'USER';

      // Admin commands (/help, /status, /auto, etc.)
      if (messageText.trim().startsWith('/')) {
        const commandResponse = await adminCommands.handleCommand(messageText, senderJid, isFromMe, this.userId, this.aiProvider);
        if (commandResponse) {
          this.userLogger.info(`[COMMAND] Source: ${isGroup ? 'GROUP' : 'DM'} (${chatJid}) | Sender: ${senderLabel} (${senderJid}) | Command: "${messageText.trim()}" | Status: EXECUTED`);
          await this.dispatchMessage(chatJid, { text: commandResponse }, isGroup, m);
          return;
        }
      }

      const botPhoneNum = permissionChecker.normalizeJid(this.botJid) || permissionChecker.normalizeJid(this.getOwnerNumber());

      // DM Self-Chat Rule: Only reply if explicitly triggered with @mark or @<botPhoneNum>
      if (!isGroup && isFromMe) {
        const cleanMsg = messageText.toLowerCase();
        const hasExplicitTrigger = cleanMsg.includes('@mark') || (botPhoneNum && cleanMsg.includes(`@${botPhoneNum}`));
        if (!hasExplicitTrigger) {
          return;
        }
      }

      // Group Message Trigger Logic
      if (isGroup) {
        const isMentioned = permissionChecker.isBotMentionedInGroup(m, this.botJid, this.botLid, messageText);
        if (!isMentioned) return;

        const canWrite = await permissionChecker.hasGroupWritePermission(this.sock, chatJid, this.botJid);
        if (!canWrite) return;
      }

      if (!db.getAutoReply(this.userId)) return;
      if (!this.antiBan.checkRateLimit(chatJid)) return;

      this.userLogger.info(`[INPUT] Source: ${isGroup ? 'GROUP' : 'DM'} (${chatJid}) | Sender: ${senderLabel} (${senderJid || 'me'}) | Prompt: "${messageText.substring(0, 100)}"${hasMedia ? ` [Media: ${mediaType}]` : ''}`);

      const history = db.getConversationHistory(this.userId, chatJid);

      const quotedText = permissionChecker.extractQuotedText(m);
      let promptToSend = rawText || '';
      if (quotedText && quotedText.trim()) {
        this.userLogger.info(`[CONTEXT] Quoted message detected: "${quotedText.substring(0, 100)}"`);
        promptToSend = `[Replying to quoted message]: "${quotedText.trim()}"\n${promptToSend || messageText}`;
      }

      let mediaBase64 = null;
      let mediaMimeType = null;
      if (hasMedia) {
        if (mediaType === 'video' && unwrapped.videoMessage?.jpegThumbnail) {
          mediaBase64 = Buffer.from(unwrapped.videoMessage.jpegThumbnail).toString('base64');
          mediaMimeType = 'image/jpeg';
        } else if (typeof downloadMediaMessage === 'function') {
          try {
            const buffer = await downloadMediaMessage(m, 'buffer', {});
            if (buffer && Buffer.isBuffer(buffer)) {
              mediaBase64 = buffer.toString('base64');
              mediaMimeType = unwrapped.imageMessage?.mimetype || unwrapped.audioMessage?.mimetype || unwrapped.videoMessage?.mimetype || 'image/jpeg';
            }
          } catch (mediaErr) {
            this.userLogger.warn(`Media download warning (${mediaErr.message}). Continuing with prompt metadata.`);
          }
        }
      }

      await this.antiBan.applyHumanDelay(this.sock, chatJid);

      let aiReply = '';
      try {
        aiReply = await this.aiProvider.generateResponse(promptToSend || messageText, history, {
          messageId: msgId,
          chatId: chatJid,
          isOwner: isOwner,
          isMedia: hasMedia,
          mediaType: mediaType,
          mediaBase64: mediaBase64,
          mediaMimeType: mediaMimeType
        });
      } catch (aiErr) {
        this.userLogger.error(`AI generation error for ${chatJid}:`, aiErr.message);
      }

      if (this.sock && aiReply && typeof aiReply === 'string' && aiReply.trim()) {
        const validatedReply = aiReply.trim();
        const sent = await this.dispatchMessage(chatJid, { text: validatedReply }, isGroup, m);
        if (sent) {
          db.addMessage(this.userId, chatJid, 'user', messageText, senderJid, isOwner);
          db.addMessage(this.userId, chatJid, 'assistant', validatedReply, this.botJid, false);
          this.antiBan.recordReply(chatJid);
          this.userLogger.info(`[DISPATCH] Target: ${chatJid} | Status: DELIVERED`);
        }
      } else {
        this.userLogger.warn(`No valid user-facing AI reply generated for ${chatJid}. Conversation history left unchanged.`);
      }

    } catch (err) {
      this.userLogger.error('Message handling error:', err.stack || err.message);
    }
  }

  getStatus() {
    const analytics = db.getAnalytics(this.userId) || { totalMessages: 0, totalReplies: 0 };
    const autoReply = db.getAutoReply(this.userId);
    return {
      userId: this.userId,
      status: this.status,
      connection: this.status.toLowerCase(),
      connected: this.status === 'CONNECTED',
      qrCodeDataUrl: this.qrCodeDataUrl,
      qr: this.qrCodeDataUrl,
      botJid: this.botJid,
      botLid: this.botLid,
      autoReply: autoReply,
      auto_reply: autoReply,
      operating_mode: 'Multi-Tenant Standard',
      mode: 'Standard',
      active_key_index: this.aiProvider.groqKeyIndex || 0,
      key_index: this.aiProvider.groqKeyIndex || 0,
      messages_processed: analytics.totalMessages || 0,
      total_messages: analytics.totalMessages || 0,
      ai_replies: analytics.totalReplies || 0,
      total_replies: analytics.totalReplies || 0,
      analytics: analytics,
      aiStatus: this.aiProvider.getStatus(),
      groqStatus: this.aiProvider.getStatus(),
      ownerNumber: this.getOwnerNumber()
    };
  }
}

export class BotSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  getSession(userId) {
    if (!userId) return null;
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, new UserBotSession(userId));
    }
    return this.sessions.get(userId);
  }

  async startSession(userId, forceNewSession = false) {
    const session = this.getSession(userId);
    if (!session) return;
    return await session.start(forceNewSession);
  }

  async stopSession(userId) {
    const session = this.sessions.get(userId);
    if (session) {
      await session.stop();
    }
  }

  async resetSession(userId) {
    const session = this.getSession(userId);
    if (session) {
      await session.resetSession();
    }
  }

  getStatus(userId) {
    const session = this.getSession(userId);
    return session ? session.getStatus() : {
      userId,
      status: 'DISCONNECTED',
      qrCodeDataUrl: null,
      botJid: null,
      autoReply: db.getAutoReply(userId),
      analytics: db.getAnalytics(userId),
      aiStatus: new AIProviderManager(userId).getStatus(),
      groqStatus: new AIProviderManager(userId).getStatus()
    };
  }

  getAllSessionsStatus() {
    const users = db.getAllUsersSafe();
    return users.map(u => {
      const s = this.sessions.get(u.id);
      return {
        ...u,
        botStatus: s ? s.status : 'DISCONNECTED',
        botJid: s ? s.botJid : null
      };
    });
  }

  /**
   * Sequentially restores active sessions on startup with bounded concurrency.
   */
  async restoreSessions() {
    const users = db.getAllUsersSafe().filter(u => u.enabled);
    logger.info(`[STARTUP] Checking session restoration for ${users.length} enabled user(s)...`);

    for (const u of users) {
      const userSessionDir = path.join(config.sessionDir, u.id);
      // Only restore if user has credentials saved
      if (fs.existsSync(userSessionDir) && fs.readdirSync(userSessionDir).length > 0) {
        try {
          logger.info(`[STARTUP] Restoring WhatsApp session for user '${u.username}' (${u.id})...`);
          const s = this.getSession(u.id);
          await s.start(false);
          // 1.5s pacing between session startups to avoid network floods
          await new Promise(r => setTimeout(r, 1500));
        } catch (err) {
          logger.error(`[STARTUP] Failed to restore session for user '${u.username}':`, err.message);
        }
      }
    }
  }

  async stopAll() {
    logger.info('[SHUTDOWN] Stopping all active WhatsApp bot sessions...');
    for (const session of this.sessions.values()) {
      try {
        await session.stop();
      } catch (err) {}
    }
  }

  syncUserSettings(userId, { provider, ownerNumber, autoReply, systemPrompt, groqKeys, nvidiaKeys } = {}) {
    const session = this.getSession(userId);
    if (session) {
      session.syncRuntimeSettings({ provider, ownerNumber, autoReply, systemPrompt, groqKeys, nvidiaKeys });
    }
  }

  // Backward compatibility alias for single-user callers
  start(forceNewSession = false) {
    return this.startSession('user_gohar', forceNewSession);
  }

  stop() {
    return this.stopSession('user_gohar');
  }

  resetSessionSingle() {
    return this.resetSession('user_gohar');
  }
}

UserBotSession.prototype.syncRuntimeSettings = function({ provider, ownerNumber, autoReply, systemPrompt, groqKeys, nvidiaKeys } = {}) {
  if (provider || ownerNumber || systemPrompt) {
    this.aiProvider.setRuntimeSettings({ provider, ownerNumber, systemPrompt });
  }
  if (groqKeys || nvidiaKeys) {
    this.aiProvider.setRuntimeCredentials({ groqKeys, nvidiaKeys });
  }
};

export const sessionManager = new BotSessionManager();
export const botEngine = sessionManager;
