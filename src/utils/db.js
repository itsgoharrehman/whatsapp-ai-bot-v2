import fs from 'fs';
import path from 'path';
import { config, getSystemPrompt as getDefaultSystemPrompt } from '../config.js';
import { logger } from './logger.js';
import { encrypt, decrypt, hashPassword, verifyPassword, generateToken, generateRandomPassword } from './crypto.js';

class JsonDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      users: {},
      user_settings: {},
      user_api_keys: {},
      user_conversations: {},
      user_analytics: {},
      web_sessions: {}
    };
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);

        // Check if legacy schema format
        if (parsed.conversations || (parsed.settings && !parsed.user_settings)) {
          logger.warn('Legacy single-user database detected. Starting automatic migration...');
          this.migrateLegacyData(parsed);
        } else {
          this.data = {
            users: parsed.users || {},
            user_settings: parsed.user_settings || {},
            user_api_keys: parsed.user_api_keys || {},
            user_conversations: parsed.user_conversations || {},
            user_analytics: parsed.user_analytics || {},
            web_sessions: parsed.web_sessions || {}
          };
        }
        this.sanitizeAllStoredConversations();
      } else {
        this.seedInitialUsers();
        this.save();
      }
    } catch (err) {
      logger.error('Database initialization error:', err.message);
      this.seedInitialUsers();
      this.save();
    }

    this.ensureAdminUser();
    this.cleanupExpiredSessions();
  }

  seedInitialUsers() {
    this.data = {
      users: {},
      user_settings: {},
      user_api_keys: {},
      user_conversations: {},
      user_analytics: {},
      web_sessions: {}
    };

    // Default primary user (Gohar)
    const goharId = 'user_gohar';
    const goharPass = hashPassword(process.env.DEFAULT_USER_PASSWORD || 'gohar123');
    this.data.users[goharId] = {
      id: goharId,
      username: 'gohar',
      passwordHash: goharPass.hash,
      salt: goharPass.salt,
      role: 'user',
      enabled: true,
      createdAt: new Date().toISOString()
    };

    this.data.user_settings[goharId] = {
      provider: config.defaultProvider || 'nvidia',
      ownerNumber: config.ownerNumber || '',
      autoReply: config.autoReplyEnabled !== false,
      systemPrompt: ''
    };

    const groqEnc = (config.groqKeys || []).map(k => encrypt(k)).filter(Boolean);
    const nvidiaEnc = (config.nvidiaKeys || []).map(k => encrypt(k)).filter(Boolean);
    this.data.user_api_keys[goharId] = {
      groqKeysEncrypted: groqEnc,
      nvidiaKeysEncrypted: nvidiaEnc
    };

    this.data.user_conversations[goharId] = {};
    this.data.user_analytics[goharId] = {
      totalMessagesProcessed: 0,
      totalRepliesSent: 0,
      rateLimitedCount: 0,
      keyRotationsCount: 0
    };
  }

  migrateLegacyData(parsed) {
    this.seedInitialUsers();
    const goharId = 'user_gohar';

    if (parsed.conversations && typeof parsed.conversations === 'object') {
      this.data.user_conversations[goharId] = parsed.conversations;
    }
    if (parsed.settings && typeof parsed.settings === 'object') {
      this.data.user_settings[goharId] = {
        ...this.data.user_settings[goharId],
        provider: parsed.settings.provider || config.defaultProvider || 'nvidia',
        autoReply: typeof parsed.settings.autoReply === 'boolean' ? parsed.settings.autoReply : true,
        ownerNumber: config.ownerNumber || ''
      };
    }
    if (parsed.analytics && typeof parsed.analytics === 'object') {
      this.data.user_analytics[goharId] = {
        ...this.data.user_analytics[goharId],
        ...parsed.analytics
      };
    }

    this.save();
    logger.info('[MIGRATION] Legacy database data successfully migrated to user: gohar');
  }

  ensureAdminUser() {
    const adminUser = Object.values(this.data.users).find(u => u.role === 'admin');

    if (config.adminPassword) {
      if (adminUser) {
        const pass = hashPassword(config.adminPassword);
        adminUser.passwordHash = pass.hash;
        adminUser.salt = pass.salt;
        this.save();
        return;
      }
    } else if (adminUser) {
      return;
    }

    const adminId = 'user_admin';
    const username = config.adminUsername || 'admin';
    let rawPassword = config.adminPassword;
    let isGenerated = false;

    if (!rawPassword) {
      rawPassword = generateRandomPassword(16);
      isGenerated = true;
    }

    const pass = hashPassword(rawPassword);
    this.data.users[adminId] = {
      id: adminId,
      username,
      passwordHash: pass.hash,
      salt: pass.salt,
      role: 'admin',
      enabled: true,
      createdAt: new Date().toISOString()
    };

    this.data.user_settings[adminId] = {
      provider: config.defaultProvider || 'nvidia',
      ownerNumber: '',
      autoReply: true,
      systemPrompt: ''
    };
    this.data.user_api_keys[adminId] = {
      groqKeysEncrypted: [],
      nvidiaKeysEncrypted: []
    };
    this.data.user_conversations[adminId] = {};
    this.data.user_analytics[adminId] = {
      totalMessagesProcessed: 0,
      totalRepliesSent: 0,
      rateLimitedCount: 0,
      keyRotationsCount: 0
    };

    this.save();

    if (isGenerated) {
      logger.warn(`[SECURITY] No ADMIN_PASSWORD in .env. Generated secure temporary password: ${rawPassword}`);
      logger.warn(`[SECURITY] Set ADMIN_PASSWORD in your .env to define your own private password.`);
    } else {
      logger.info(`[SECURITY] Admin account initialized with configured credentials for '${username}'.`);
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      try {
        fs.renameSync(tempPath, this.filePath);
      } catch (renameErr) {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
        try { fs.unlinkSync(tempPath); } catch (_) {}
      }
    } catch (err) {
      logger.error('Error saving database:', err.message);
    }
  }

  sanitizeAllStoredConversations() {
    let modified = false;
    for (const userId of Object.keys(this.data.user_conversations || {})) {
      const convs = this.data.user_conversations[userId];
      if (!convs) continue;
      for (const jid of Object.keys(convs)) {
        const conv = convs[jid];
        if (conv && Array.isArray(conv.messages)) {
          const cleanedMsgs = [];
          for (const msg of conv.messages) {
            if (!msg || !msg.content || typeof msg.content !== 'string') continue;
            if (msg.role === 'assistant') {
              let cleaned = msg.content
                .replace(/<(think|thought|reasoning|reflection)>[\s\S]*?<\/\1>/gi, '')
                .replace(/<(think|thought|reasoning|reflection)>[\s\S]*/gi, '')
                .replace(/(?:^|\n)(?:Draft\s+Response|Refine\s*(?:\([^)]*\))?|Final\s+Check)[\s\S]*?(?=\n\n|$)/gi, '')
                .trim();
              if (cleaned) {
                cleanedMsgs.push({ ...msg, content: cleaned });
              } else {
                modified = true;
              }
            } else {
              cleanedMsgs.push(msg);
            }
          }
          if (cleanedMsgs.length !== conv.messages.length) modified = true;
          conv.messages = cleanedMsgs;
        }
      }
    }
    if (modified) {
      this.save();
    }
  }

  // ==========================================
  // User Management & Authentication
  // ==========================================

  getUser(userId) {
    return this.data.users[userId] || null;
  }

  getUserByUsername(username) {
    if (!username) return null;
    const clean = username.trim().toLowerCase();
    for (const u of Object.values(this.data.users)) {
      if (u.username.toLowerCase() === clean) return u;
    }
    return null;
  }

  authenticate(username, password) {
    const user = this.getUserByUsername(username);
    if (!user || !user.enabled) return null;
    const valid = verifyPassword(password, user.salt, user.passwordHash);
    if (!valid) return null;
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      enabled: user.enabled,
      createdAt: user.createdAt
    };
  }

  createUser(username, password, role = 'user', initialSettings = {}) {
    const existing = this.getUserByUsername(username);
    if (existing) throw new Error(`Username '${username}' already exists.`);

    const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const pass = hashPassword(password);

    this.data.users[userId] = {
      id: userId,
      username: username.trim(),
      passwordHash: pass.hash,
      salt: pass.salt,
      role: role === 'admin' ? 'admin' : 'user',
      enabled: true,
      createdAt: new Date().toISOString()
    };

    this.data.user_settings[userId] = {
      provider: initialSettings.provider || config.defaultProvider || 'nvidia',
      ownerNumber: (initialSettings.ownerNumber || '').trim().replace(/[^0-9]/g, ''),
      autoReply: initialSettings.autoReply !== false,
      systemPrompt: initialSettings.systemPrompt || ''
    };

    const groqKeys = Array.isArray(initialSettings.groqKeys) ? initialSettings.groqKeys : [];
    const nvidiaKeys = Array.isArray(initialSettings.nvidiaKeys) ? initialSettings.nvidiaKeys : [];

    this.data.user_api_keys[userId] = {
      groqKeysEncrypted: groqKeys.map(k => encrypt(k)).filter(Boolean),
      nvidiaKeysEncrypted: nvidiaKeys.map(k => encrypt(k)).filter(Boolean)
    };

    this.data.user_conversations[userId] = {};
    this.data.user_analytics[userId] = {
      totalMessagesProcessed: 0,
      totalRepliesSent: 0,
      rateLimitedCount: 0,
      keyRotationsCount: 0
    };

    this.save();
    return this.getUserSafe(userId);
  }

  updateUser(userId, updates = {}) {
    const user = this.data.users[userId];
    if (!user) throw new Error('User not found.');

    if (updates.password) {
      const pass = hashPassword(updates.password);
      user.passwordHash = pass.hash;
      user.salt = pass.salt;
    }
    if (typeof updates.enabled === 'boolean') {
      user.enabled = updates.enabled;
    }
    if (updates.role && ['admin', 'user'].includes(updates.role)) {
      user.role = updates.role;
    }
    if (updates.username && updates.username.trim() !== user.username) {
      const exist = this.getUserByUsername(updates.username.trim());
      if (exist && exist.id !== userId) throw new Error('Username already taken.');
      user.username = updates.username.trim();
    }

    this.save();
    return this.getUserSafe(userId);
  }

  deleteUser(userId) {
    if (!this.data.users[userId]) return false;
    delete this.data.users[userId];
    delete this.data.user_settings[userId];
    delete this.data.user_api_keys[userId];
    delete this.data.user_conversations[userId];
    delete this.data.user_analytics[userId];

    // Invalidate any active sessions for this user
    for (const [token, s] of Object.entries(this.data.web_sessions)) {
      if (s.userId === userId) {
        delete this.data.web_sessions[token];
      }
    }

    this.save();
    return true;
  }

  getUserSafe(userId) {
    const u = this.data.users[userId];
    if (!u) return null;
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      enabled: u.enabled,
      createdAt: u.createdAt
    };
  }

  getAllUsersSafe() {
    return Object.values(this.data.users).map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      enabled: u.enabled,
      createdAt: u.createdAt,
      settings: this.data.user_settings[u.id] || {},
      analytics: this.data.user_analytics[u.id] || { totalMessagesProcessed: 0, totalRepliesSent: 0 },
      hasKeys: Boolean(
        (this.data.user_api_keys[u.id]?.groqKeysEncrypted?.length || 0) > 0 ||
        (this.data.user_api_keys[u.id]?.nvidiaKeysEncrypted?.length || 0) > 0
      )
    }));
  }

  // ==========================================
  // Web Sessions (Authentication Tokens)
  // ==========================================

  createWebSession(userId, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const token = generateToken();
    const expiresAt = Date.now() + maxAgeMs;
    this.data.web_sessions[token] = {
      userId,
      createdAt: new Date().toISOString(),
      expiresAt
    };
    this.save();
    return token;
  }

  getWebSession(token) {
    if (!token) return null;
    const session = this.data.web_sessions[token];
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      delete this.data.web_sessions[token];
      this.save();
      return null;
    }
    const user = this.getUser(session.userId);
    if (!user || !user.enabled) return null;
    return this.getUserSafe(session.userId);
  }

  deleteWebSession(token) {
    if (this.data.web_sessions[token]) {
      delete this.data.web_sessions[token];
      this.save();
      return true;
    }
    return false;
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    let cleaned = false;
    for (const [token, s] of Object.entries(this.data.web_sessions || {})) {
      if (now > s.expiresAt) {
        delete this.data.web_sessions[token];
        cleaned = true;
      }
    }
    if (cleaned) this.save();
  }

  // ==========================================
  // BYOK API Keys & User Settings (Encrypted)
  // ==========================================

  getUserApiKeys(userId) {
    const keysObj = this.data.user_api_keys[userId] || { groqKeysEncrypted: [], nvidiaKeysEncrypted: [] };
    const groqKeys = (keysObj.groqKeysEncrypted || []).map(enc => decrypt(enc)).filter(Boolean);
    const nvidiaKeys = (keysObj.nvidiaKeysEncrypted || []).map(enc => decrypt(enc)).filter(Boolean);

    // If user has not configured custom keys, fallback to system config keys if present
    const finalGroq = groqKeys.length > 0 ? groqKeys : (config.groqKeys || []);
    const finalNvidia = nvidiaKeys.length > 0 ? nvidiaKeys : (config.nvidiaKeys || []);

    return {
      groqKeys: finalGroq,
      nvidiaKeys: finalNvidia,
      isCustomGroq: groqKeys.length > 0,
      isCustomNvidia: nvidiaKeys.length > 0
    };
  }

  setUserApiKeys(userId, { groqKeys = null, nvidiaKeys = null }) {
    if (!this.data.user_api_keys[userId]) {
      this.data.user_api_keys[userId] = { groqKeysEncrypted: [], nvidiaKeysEncrypted: [] };
    }
    if (Array.isArray(groqKeys)) {
      this.data.user_api_keys[userId].groqKeysEncrypted = groqKeys
        .map(k => (k || '').trim())
        .filter(Boolean)
        .map(k => encrypt(k));
    }
    if (Array.isArray(nvidiaKeys)) {
      this.data.user_api_keys[userId].nvidiaKeysEncrypted = nvidiaKeys
        .map(k => (k || '').trim())
        .filter(Boolean)
        .map(k => encrypt(k));
    }
    this.save();
  }

  getMaskedUserApiKeys(userId) {
    const { groqKeys, nvidiaKeys, isCustomGroq, isCustomNvidia } = this.getUserApiKeys(userId);
    const mask = k => (!k || k.length < 8 ? '[CONFIGURED]' : `${k.slice(0, 6)}...${k.slice(-4)}`);
    return {
      groqKeysConfigured: groqKeys.length,
      nvidiaKeysConfigured: nvidiaKeys.length,
      groqKeysMasked: groqKeys.map(mask),
      nvidiaKeysMasked: nvidiaKeys.map(mask),
      isCustomGroq,
      isCustomNvidia
    };
  }

  getUserSettings(userId) {
    if (!this.data.user_settings[userId]) {
      this.data.user_settings[userId] = {
        provider: config.defaultProvider || 'nvidia',
        ownerNumber: '',
        autoReply: true,
        systemPrompt: ''
      };
      this.save();
    }
    return { ...this.data.user_settings[userId] };
  }

  updateUserSettings(userId, settings = {}) {
    if (!this.data.user_settings[userId]) {
      this.data.user_settings[userId] = {
        provider: config.defaultProvider || 'nvidia',
        ownerNumber: '',
        autoReply: true,
        systemPrompt: ''
      };
    }
    if (typeof settings.autoReply === 'boolean') {
      this.data.user_settings[userId].autoReply = settings.autoReply;
    }
    if (settings.provider && ['groq', 'nvidia', 'auto'].includes(settings.provider.toLowerCase())) {
      this.data.user_settings[userId].provider = settings.provider.toLowerCase();
    }
    if (typeof settings.ownerNumber === 'string') {
      this.data.user_settings[userId].ownerNumber = settings.ownerNumber.trim().replace(/[^0-9]/g, '');
    }
    if (typeof settings.systemPrompt === 'string') {
      this.data.user_settings[userId].systemPrompt = settings.systemPrompt.trim();
    }
    this.save();
    return this.getUserSettings(userId);
  }

  getSystemPrompt(userId) {
    const custom = this.data.user_settings[userId]?.systemPrompt;
    if (custom && custom.trim()) {
      return custom.trim();
    }
    return getDefaultSystemPrompt();
  }

  getAutoReply(userId) {
    return this.getUserSettings(userId).autoReply !== false;
  }

  setAutoReply(userId, enabled) {
    this.updateUserSettings(userId, { autoReply: Boolean(enabled) });
  }

  getProvider(userId) {
    return (this.getUserSettings(userId).provider || config.defaultProvider || 'nvidia').toLowerCase();
  }

  setProvider(userId, provider) {
    const valid = ['groq', 'nvidia', 'auto'];
    const p = (provider || '').toLowerCase();
    if (!valid.includes(p)) throw new Error(`Invalid provider '${provider}'. Choices: ${valid.join(', ')}`);
    this.updateUserSettings(userId, { provider: p });
    return p;
  }

  getOwnerNumber(userId) {
    return this.getUserSettings(userId).ownerNumber || '';
  }

  // ==========================================
  // Conversations & Context Management
  // ==========================================

  getConversationHistory(userId, jid) {
    if (!this.data.user_conversations[userId]) {
      this.data.user_conversations[userId] = {};
    }
    return this.data.user_conversations[userId][jid]?.messages || [];
  }

  addMessage(userId, jid, role, content, senderJid = null, isOwner = false) {
    if (!content || typeof content !== 'string' || !content.trim()) return;
    if (!this.data.user_conversations[userId]) {
      this.data.user_conversations[userId] = {};
    }
    if (!this.data.user_conversations[userId][jid]) {
      this.data.user_conversations[userId][jid] = { updatedAt: new Date().toISOString(), messages: [] };
    }
    const messages = this.data.user_conversations[userId][jid].messages;
    messages.push({
      role,
      content: content.trim(),
      senderJid: senderJid || null,
      isOwner: Boolean(isOwner),
      timestamp: new Date().toISOString()
    });
    if (messages.length > 20) {
      this.data.user_conversations[userId][jid].messages = messages.slice(-20);
    }
    this.data.user_conversations[userId][jid].updatedAt = new Date().toISOString();

    if (role === 'user') {
      this.incrementMetric(userId, 'totalMessagesProcessed');
    }
    this.save();
  }

  clearContext(userId, jid) {
    if (this.data.user_conversations[userId]?.[jid]) {
      delete this.data.user_conversations[userId][jid];
      this.save();
      return true;
    }
    return false;
  }

  resetUserData(userId) {
    this.data.user_conversations[userId] = {};
    this.data.user_analytics[userId] = {
      totalMessagesProcessed: 0,
      totalRepliesSent: 0,
      rateLimitedCount: 0,
      keyRotationsCount: 0
    };
    this.save();
    return true;
  }

  // ==========================================
  // Analytics & Metrics
  // ==========================================

  getAnalytics(userId) {
    if (!this.data.user_analytics[userId]) {
      this.data.user_analytics[userId] = {
        totalMessagesProcessed: 0,
        totalRepliesSent: 0,
        rateLimitedCount: 0,
        keyRotationsCount: 0
      };
    }
    return { ...this.data.user_analytics[userId] };
  }

  incrementMetric(userId, key) {
    if (!this.data.user_analytics[userId]) {
      this.data.user_analytics[userId] = {
        totalMessagesProcessed: 0,
        totalRepliesSent: 0,
        rateLimitedCount: 0,
        keyRotationsCount: 0
      };
    }
    if (typeof this.data.user_analytics[userId][key] === 'number') {
      this.data.user_analytics[userId][key] += 1;
    } else {
      this.data.user_analytics[userId][key] = 1;
    }
    this.save();
  }
}

export const db = new JsonDatabase(config.dbFilePath);
export { JsonDatabase };
