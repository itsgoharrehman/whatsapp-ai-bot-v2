







































































































































































import http from 'http';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { db } from './utils/db.js';
import { sessionManager } from './bot.js';
import { requireInternalAuth, createSignedHeaders } from './utils/internalAuth.js';

function extractToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return urlObj.searchParams.get('token') || null;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const user = db.getWebSession(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permission required' });
  }
  next();
}

async function forwardToAlwaysdata(method, apiPath, body = null) {
  if (!config.alwaysdataBaseUrl) return null;
  const baseUrl = config.alwaysdataBaseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}${apiPath}`;
  const signedHeaders = createSignedHeaders(config.internalApiKey, method, apiPath, body || '');
  const res = await fetch(url, {
    method,
    headers: signedHeaders,
    body: body ? JSON.stringify(body) : undefined
  });
  return res;
}

export function createServer() {
  const ROOT_DIR = process.cwd();
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-internal-key, x-internal-timestamp, x-internal-nonce, x-internal-signature');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  app.use(express.json());
  app.use(express.static(path.join(ROOT_DIR, 'frontend')));

  // =========================================================================
  // Internal Server-to-Server API (Alwaysdata Runtime <-> Cloudflare Control Plane)
  // Protected by HMAC-SHA256 Signature + Nonce + Timestamp
  // =========================================================================
  const internalAuthMiddleware = requireInternalAuth(config.internalApiKey);

  app.get('/internal/health', internalAuthMiddleware, (req, res) => {
    res.json({ status: 'ok', time: Date.now() });
  });

  app.get('/internal/status/:userId', internalAuthMiddleware, (req, res) => {
    const { userId } = req.params;
    const session = sessionManager.getSession(userId);
    if (session.status === 'DISCONNECTED' && !session.isStopping) {
      session.start(false).catch(() => {});
    }
    res.json(sessionManager.getStatus(userId));
  });

  app.post('/internal/control/:userId/:action', internalAuthMiddleware, async (req, res) => {
    const { userId, action } = req.params;
    try {
      if (action === 'start') {
        sessionManager.startSession(userId);
      } else if (action === 'stop') {
        await sessionManager.stopSession(userId);
      } else if (action === 'reset' || action === 'reset_session') {
        logger.forUser(userId).warn('Alwaysdata: Initiated Session Reset & QR Re-generation');
        await sessionManager.resetSession(userId);
        setTimeout(() => sessionManager.startSession(userId, true), 1000);
      }
      res.json({ success: true, status: sessionManager.getStatus(userId) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/internal/sync-settings/:userId', internalAuthMiddleware, (req, res) => {
    const { userId } = req.params;
    const { provider, ownerNumber, autoReply, systemPrompt, groqKeys, nvidiaKeys } = req.body || {};
    sessionManager.syncUserSettings(userId, {
      provider,
      ownerNumber,
      autoReply,
      systemPrompt,
      groqKeys,
      nvidiaKeys
    });
    res.json({ success: true, message: 'Settings synced to runtime in memory' });
  });

  app.delete('/internal/users/:userId', internalAuthMiddleware, async (req, res) => {
    const { userId } = req.params;
    try {
      await sessionManager.stopSession(userId);
      await sessionManager.resetSession(userId);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/internal/logs/:userId', internalAuthMiddleware, (req, res) => {
    res.json(logger.getHistory(req.params.userId));
  });

  app.get('/internal/logs/stream/:userId', internalAuthMiddleware, (req, res) => {
    const { userId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'history', logs: logger.getHistory(userId) })}\n\n`);

    const logHandler = (logEntry) => {
      if (logEntry.userId === userId || logEntry.userId === null) {
        res.write(`data: ${JSON.stringify({ type: 'log', log: logEntry })}\n\n`);
      }
    };

    logger.on('log', logHandler);
    req.on('close', () => logger.off('log', logHandler));
  });

  app.get('/internal/all-status', internalAuthMiddleware, (req, res) => {
    res.json({ users: sessionManager.getAllSessionsStatus() });
  });

  // =========================================================================
  // Public Authentication Endpoints (Control Plane)
  // Supports /api/auth/login, /api/login, /api/auth/logout, /api/logout, /api/auth/me, /api/me
  // =========================================================================

  const handleLogin = (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const user = db.authenticate(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials or account disabled' });
    }
    const token = db.createWebSession(user.id);
    res.setHeader('Set-Cookie', `session_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    res.json({
      success: true,
      token,
      user,
      authenticated: true,
      role: user.role,
      username: user.username,
      is_admin: user.role === 'admin'
    });
  };

  app.post('/api/auth/login', handleLogin);
  app.post('/api/login', handleLogin);

  const handleLogout = (req, res) => {
    if (req.sessionToken) {
      db.deleteWebSession(req.sessionToken);
    }
    res.setHeader('Set-Cookie', `session_token=; Path=/; HttpOnly; Max-Age=0`);
    res.json({ success: true });
  };

  app.post('/api/auth/logout', requireAuth, handleLogout);
  app.post('/api/logout', requireAuth, handleLogout);

  const handleMe = (req, res) => {
    res.json({
      authenticated: true,
      user: req.user,
      role: req.user.role,
      username: req.user.username,
      is_admin: req.user.role === 'admin'
    });
  };

  app.get('/api/auth/me', requireAuth, handleMe);
  app.get('/api/me', requireAuth, handleMe);

  // =========================================================================
  // User-Scoped WhatsApp & Dashboard Endpoints (Control Plane -> Alwaysdata Gateway)
  // =========================================================================

  app.get('/api/status', requireAuth, async (req, res) => {
    let st = null;
    if (config.alwaysdataBaseUrl) {
      try {
        const response = await forwardToAlwaysdata('GET', `/internal/status/${req.user.id}`);
        if (response && response.ok) {
          st = await response.json();
        }
      } catch (err) {
        logger.error('Failed to proxy status to Alwaysdata:', err.message);
      }
    }
    if (!st) {
      st = sessionManager.getStatus(req.user.id);
    }

    const isConnected = st.status === 'CONNECTED';
    res.json({
      ...st,
      connected: isConnected,
      connection: st.status.toLowerCase(),
      status: st.status,
      qr: st.qrCodeDataUrl,
      qr_code: st.qrCodeDataUrl,
      mode: 'Auto',
      operating_mode: 'Auto',
      auto_reply: st.autoReply,
      autoReply: st.autoReply,
      active_key_index: st.keyIndices ? (st.keyIndices.nvidia || st.keyIndices.groq || 0) : 0,
      key_index: st.keyIndices ? (st.keyIndices.nvidia || st.keyIndices.groq || 0) : 0,
      messages_processed: st.analytics ? st.analytics.totalProcessed : 0,
      total_messages: st.analytics ? st.analytics.totalProcessed : 0,
      ai_replies: st.analytics ? st.analytics.totalReplies : 0,
      total_replies: st.analytics ? st.analytics.totalReplies : 0,
      environment: 'Production',
      env: 'Production'
    });
  });

  app.get('/api/logs', requireAuth, async (req, res) => {
    let history = [];
    if (config.alwaysdataBaseUrl) {
      try {
        const response = await forwardToAlwaysdata('GET', `/internal/logs/${req.user.id}`);
        if (response && response.ok) {
          history = await response.json();
        }
      } catch (err) {}
    } else {
      history = logger.getHistory(req.user.id);
    }

    const normalized = (history || []).map((h, idx) => ({
      id: idx + 1,
      msg: typeof h === 'string' ? h : (h.message || ''),
      message: typeof h === 'string' ? h : (h.message || ''),
      text: typeof h === 'string' ? h : (h.message || ''),
      level: typeof h === 'object' && h.level ? h.level.toLowerCase() : 'info',
      type: typeof h === 'object' && h.level ? h.level.toLowerCase() : 'info',
      time: typeof h === 'object' && h.timestamp ? new Date(h.timestamp).toTimeString().slice(0, 8) : new Date().toTimeString().slice(0, 8),
      timestamp: typeof h === 'object' && h.timestamp ? h.timestamp : new Date().toISOString()
    }));

    res.json(normalized);
  });

  app.get('/api/logs/stream', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const history = logger.getHistory(req.user.id);
    res.write(`data: ${JSON.stringify({ type: 'history', logs: history })}\n\n`);

    const logHandler = (logEntry) => {
      if (logEntry.userId === req.user.id || logEntry.userId === null) {
        res.write(`data: ${JSON.stringify({ type: 'log', log: logEntry })}\n\n`);
      }
    };

    logger.on('log', logHandler);
    req.on('close', () => logger.off('log', logHandler));
  });

  // Generic and specific control endpoints
  const executeControl = async (userId, action) => {
    if (config.alwaysdataBaseUrl) {
      try {
        const response = await forwardToAlwaysdata('POST', `/internal/control/${userId}/${action}`);
        if (response && response.ok) return true;
      } catch (err) {}
    }
    if (action === 'start') {
      sessionManager.startSession(userId);
    } else if (action === 'stop') {
      await sessionManager.stopSession(userId);
    } else if (action === 'reset' || action === 'reset_session') {
      logger.forUser(userId).warn('Dashboard: Initiated Session Reset & QR Re-generation');
      await sessionManager.resetSession(userId);
      setTimeout(() => sessionManager.startSession(userId, true), 1000);
    }
    return true;
  };

  app.post('/api/control', requireAuth, async (req, res) => {
    const action = req.body && req.body.action ? req.body.action : 'start';
    await executeControl(req.user.id, action);
    res.json({ success: true, action });
  });

  app.post('/api/control/start', requireAuth, async (req, res) => {
    await executeControl(req.user.id, 'start');
    res.json({ success: true });
  });

  app.post('/api/start', requireAuth, async (req, res) => {
    await executeControl(req.user.id, 'start');
    res.json({ success: true });
  });

  app.post('/api/control/stop', requireAuth, async (req, res) => {
    await executeControl(req.user.id, 'stop');
    res.json({ success: true });
  });

  app.post('/api/stop', requireAuth, async (req, res) => {
    await executeControl(req.user.id, 'stop');
    res.json({ success: true });
  });

  app.post('/api/control/reset_session', requireAuth, async (req, res) => {
    await executeControl(req.user.id, 'reset');
    res.json({ success: true, message: 'Session reset. Generating new QR code...' });
  });

  app.post('/api/reset_session', requireAuth, async (req, res) => {
    await executeControl(req.user.id, 'reset');
    res.json({ success: true, message: 'Session reset. Generating new QR code...' });
  });

  // User Settings & BYOK API Keys (Encrypted at rest)
  app.get('/api/settings', requireAuth, (req, res) => {
    const currentSettings = db.getUserSettings(req.user.id);
    const currentKeys = db.getUserApiKeys(req.user.id);
    const maskedKeys = db.getMaskedUserApiKeys(req.user.id);
    const defaultTag = '@' + (req.user.username || 'bot');

    res.json({
      provider: currentSettings.provider || 'auto',
      ai_provider: currentSettings.provider || 'auto',
      owner_number: currentSettings.ownerNumber || '',
      ownerNumber: currentSettings.ownerNumber || '',
      bot_tag: currentSettings.botTag || defaultTag,
      botTag: currentSettings.botTag || defaultTag,
      nvidia_keys: maskedKeys.nvidiaKeysMasked || [],
      groq_keys: maskedKeys.groqKeysMasked || [],
      system_prompt: currentSettings.systemPrompt || '',
      systemPrompt: currentSettings.systemPrompt || '',
      nvidia_valid: (currentKeys.nvidiaKeys && currentKeys.nvidiaKeys.length > 0),
      groq_valid: (currentKeys.groqKeys && currentKeys.groqKeys.length > 0),
      settings: currentSettings,
      keys: maskedKeys
    });
  });

  app.post('/api/settings', requireAuth, async (req, res) => {
    const body = req.body || {};
    const provider = body.provider || body.ai_provider || (body.settings && body.settings.provider);
    const ownerNumber = body.owner_number || body.ownerNumber || (body.settings && body.settings.ownerNumber);
    const botTag = body.bot_tag !== undefined ? body.bot_tag : (body.botTag !== undefined ? body.botTag : (body.settings && body.settings.botTag));
    const systemPrompt = body.system_prompt !== undefined ? body.system_prompt : (body.systemPrompt !== undefined ? body.systemPrompt : (body.settings && body.settings.systemPrompt));
    
    let groqKeys = body.groq_keys || body.groqKeys || (body.keys && body.keys.groqKeys);
    let nvidiaKeys = body.nvidia_keys || body.nvidiaKeys || (body.keys && body.keys.nvidiaKeys);

    if (typeof groqKeys === 'string') groqKeys = groqKeys.split(',').map(s => s.trim()).filter(Boolean);
    if (typeof nvidiaKeys === 'string') nvidiaKeys = nvidiaKeys.split(',').map(s => s.trim()).filter(Boolean);

    const settingUpdates = {};
    if (provider) settingUpdates.provider = provider;
    if (ownerNumber !== undefined) settingUpdates.ownerNumber = ownerNumber;
    if (botTag !== undefined) settingUpdates.botTag = botTag;
    if (systemPrompt !== undefined) settingUpdates.systemPrompt = systemPrompt;

    if (Object.keys(settingUpdates).length > 0) {
      db.updateUserSettings(req.user.id, settingUpdates);
    }
    if (Array.isArray(groqKeys) || Array.isArray(nvidiaKeys)) {
      db.setUserApiKeys(req.user.id, { groqKeys, nvidiaKeys });
    }

    const currentKeys = db.getUserApiKeys(req.user.id);
    const currentSettings = db.getUserSettings(req.user.id);

    // Sync to in-memory runtime on Alwaysdata
    if (config.alwaysdataBaseUrl) {
      try {
        await forwardToAlwaysdata('POST', `/internal/sync-settings/${req.user.id}`, {
          ...currentSettings,
          groqKeys: currentKeys.groqKeys,
          nvidiaKeys: currentKeys.nvidiaKeys
        });
      } catch (err) {
        logger.error('Failed to sync runtime settings to Alwaysdata:', err.message);
      }
    } else {
      sessionManager.syncUserSettings(req.user.id, {
        ...currentSettings,
        groqKeys: currentKeys.groqKeys,
        nvidiaKeys: currentKeys.nvidiaKeys
      });
    }

    const maskedKeys = db.getMaskedUserApiKeys(req.user.id);
    res.json({
      success: true,
      provider: currentSettings.provider || 'auto',
      ai_provider: currentSettings.provider || 'auto',
      owner_number: currentSettings.ownerNumber || '',
      ownerNumber: currentSettings.ownerNumber || '',
      nvidia_keys: maskedKeys.nvidiaKeysMasked || [],
      groq_keys: maskedKeys.groqKeysMasked || [],
      system_prompt: currentSettings.systemPrompt || '',
      systemPrompt: currentSettings.systemPrompt || '',
      nvidia_valid: (currentKeys.nvidiaKeys && currentKeys.nvidiaKeys.length > 0),
      groq_valid: (currentKeys.groqKeys && currentKeys.groqKeys.length > 0),
      settings: currentSettings,
      keys: maskedKeys
    });
  });

  // =========================================================================
  // Admin Management Endpoints (Control Plane)
  // =========================================================================

  app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
    const rawUsers = sessionManager.getAllSessionsStatus();
    const mappedUsers = rawUsers.map(u => ({
      ...u,
      owner_number: u.ownerNumber || '',
      default_provider: u.provider || 'auto',
      active: u.enabled !== false,
      is_admin: u.role === 'admin'
    }));
    res.json({ users: mappedUsers });
  });

  app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
    try {
      const body = req.body || {};
      const username = body.username;
      const password = body.password;
      const role = body.role || 'user';
      const ownerNumber = body.owner_number || body.ownerNumber || (body.settings && body.settings.ownerNumber) || '';
      const provider = body.default_provider || body.provider || (body.settings && body.settings.provider) || 'nvidia';
      const groqKeys = body.groq_keys || body.groqKeys;
      const nvidiaKeys = body.nvidia_keys || body.nvidiaKeys;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }
      const newUser = db.createUser(username, password, role, {
        ownerNumber,
        provider,
        groqKeys,
        nvidiaKeys
      });
      res.json({
        success: true,
        user: {
          ...newUser,
          owner_number: ownerNumber,
          default_provider: provider,
          active: true,
          is_admin: role === 'admin'
        }
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
    try {
      const targetUserId = req.params.id;
      const updates = req.body || {};
      const updated = db.updateUser(targetUserId, updates);
      if (updates.settings) {
        db.updateUserSettings(targetUserId, updates.settings);
      }
      if (updates.groqKeys || updates.nvidiaKeys) {
        db.setUserApiKeys(targetUserId, { groqKeys: updates.groqKeys, nvidiaKeys: updates.nvidiaKeys });
      }
      res.json({ success: true, user: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  const handleDeleteUser = async (req, res) => {
    try {
      const targetUserId = req.params.id || (req.body && (req.body.id || req.body.username));
      let resolvedId = targetUserId;
      if (!db.data.users[resolvedId]) {
        const found = Object.values(db.data.users).find(u => u.username === targetUserId || u.id === targetUserId);
        if (found) resolvedId = found.id;
      }
      if (resolvedId === req.user.id) {
        return res.status(400).json({ error: 'Cannot delete your own admin account' });
      }
      if (config.alwaysdataBaseUrl) {
        try {
          await forwardToAlwaysdata('DELETE', `/internal/users/${resolvedId}`);
        } catch (err) {}
      }
      await sessionManager.stopSession(resolvedId);
      await sessionManager.resetSession(resolvedId);
      const deleted = db.deleteUser(resolvedId);
      res.json({ success: deleted });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  app.delete('/api/admin/users/:id', requireAuth, requireAdmin, handleDeleteUser);
  app.post('/api/admin/users/delete', requireAuth, requireAdmin, handleDeleteUser);

  app.post('/api/admin/users/:id/action', requireAuth, requireAdmin, async (req, res) => {
    try {
      const targetUserId = req.params.id;
      const { action } = req.body || {};
      if (config.alwaysdataBaseUrl) {
        try {
          const response = await forwardToAlwaysdata('POST', `/internal/control/${targetUserId}/${action}`);
          if (response && response.ok) {
            const data = await response.json();
            return res.json(data);
          }
        } catch (err) {}
      }
      if (action === 'start') {
        sessionManager.startSession(targetUserId);
      } else if (action === 'stop') {
        await sessionManager.stopSession(targetUserId);
      } else if (action === 'reset') {
        await sessionManager.resetSession(targetUserId);
        setTimeout(() => sessionManager.startSession(targetUserId, true), 1000);
      }
      res.json({ success: true, status: sessionManager.getStatus(targetUserId) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('*', (req, res) => res.sendFile(path.join(ROOT_DIR, 'frontend', 'index.html')));
  return app;
}

export function startServer() {
  const server = createServer();
  return server.listen(config.port, config.host, () => {
    logger.info(`[SYSTEM] Multi-User Server running on port ${config.port}`);
  });
}
