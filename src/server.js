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
    res.json(sessionManager.getStatus(req.params.userId));
  });

  app.post('/internal/control/:userId/:action', internalAuthMiddleware, async (req, res) => {
    const { userId, action } = req.params;
    try {
      if (action === 'start') {
        sessionManager.startSession(userId);
      } else if (action === 'stop') {
        await sessionManager.stopSession(userId);
      } else if (action === 'reset') {
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
  // =========================================================================

  app.post('/api/auth/login', (req, res) => {
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
    res.json({ success: true, token, user });
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    if (req.sessionToken) {
      db.deleteWebSession(req.sessionToken);
    }
    res.setHeader('Set-Cookie', `session_token=; Path=/; HttpOnly; Max-Age=0`);
    res.json({ success: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // =========================================================================
  // User-Scoped WhatsApp & Dashboard Endpoints (Control Plane -> Alwaysdata Gateway)
  // =========================================================================

  app.get('/api/status', requireAuth, async (req, res) => {
    if (config.alwaysdataBaseUrl) {
      try {
        const response = await forwardToAlwaysdata('GET', `/internal/status/${req.user.id}`);
        if (response && response.ok) {
          const data = await response.json();
          return res.json(data);
        }
      } catch (err) {
        logger.error('Failed to proxy status to Alwaysdata:', err.message);
      }
    }
    res.json(sessionManager.getStatus(req.user.id));
  });

  app.get('/api/logs', requireAuth, async (req, res) => {
    if (config.alwaysdataBaseUrl) {
      try {
        const response = await forwardToAlwaysdata('GET', `/internal/logs/${req.user.id}`);
        if (response && response.ok) {
          const data = await response.json();
          return res.json(data);
        }
      } catch (err) {}
    }
    res.json(logger.getHistory(req.user.id));
  });

  app.get('/api/logs/stream', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'history', logs: logger.getHistory(req.user.id) })}\n\n`);

    const logHandler = (logEntry) => {
      if (logEntry.userId === req.user.id || logEntry.userId === null) {
        res.write(`data: ${JSON.stringify({ type: 'log', log: logEntry })}\n\n`);
      }
    };

    logger.on('log', logHandler);
    req.on('close', () => logger.off('log', logHandler));
  });

  app.post('/api/control/start', requireAuth, async (req, res) => {
    if (config.alwaysdataBaseUrl) {
      try {
        const response = await forwardToAlwaysdata('POST', `/internal/control/${req.user.id}/start`);
        if (response && response.ok) return res.json({ success: true });
      } catch (err) {}
    }
    sessionManager.startSession(req.user.id);
    res.json({ success: true });
  });

  app.post('/api/control/stop', requireAuth, async (req, res) => {
    if (config.alwaysdataBaseUrl) {
      try {
        const response = await forwardToAlwaysdata('POST', `/internal/control/${req.user.id}/stop`);
        if (response && response.ok) return res.json({ success: true });
      } catch (err) {}
    }
    await sessionManager.stopSession(req.user.id);
    res.json({ success: true });
  });

  app.post('/api/control/reset_session', requireAuth, async (req, res) => {
    if (config.alwaysdataBaseUrl) {
      try {
        const response = await forwardToAlwaysdata('POST', `/internal/control/${req.user.id}/reset`);
        if (response && response.ok) return res.json({ success: true, message: 'Session reset.' });
      } catch (err) {}
    }
    logger.forUser(req.user.id).warn('Dashboard: Initiated Session Reset & QR Re-generation');
    await sessionManager.resetSession(req.user.id);
    setTimeout(() => sessionManager.startSession(req.user.id, true), 1000);
    res.json({ success: true, message: 'Session reset. Generating new QR code...' });
  });

  // User Settings & BYOK API Keys (Encrypted at rest)
  app.get('/api/settings', requireAuth, (req, res) => {
    res.json({
      settings: db.getUserSettings(req.user.id),
      keys: db.getMaskedUserApiKeys(req.user.id)
    });
  });

  app.post('/api/settings', requireAuth, async (req, res) => {
    const { settings, groqKeys, nvidiaKeys } = req.body || {};
    if (settings && typeof settings === 'object') {
      db.updateUserSettings(req.user.id, settings);
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

    res.json({
      success: true,
      settings: currentSettings,
      keys: db.getMaskedUserApiKeys(req.user.id)
    });
  });

  // =========================================================================
  // Admin Management Endpoints (Control Plane)
  // =========================================================================

  app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
    res.json({ users: sessionManager.getAllSessionsStatus() });
  });

  app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
    try {
      const { username, password, role, settings, groqKeys, nvidiaKeys } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }
      const newUser = db.createUser(username, password, role, {
        ...(settings || {}),
        groqKeys,
        nvidiaKeys
      });
      res.json({ success: true, user: newUser });
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

  app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const targetUserId = req.params.id;
      if (targetUserId === req.user.id) {
        return res.status(400).json({ error: 'Cannot delete your own admin account' });
      }
      if (config.alwaysdataBaseUrl) {
        try {
          await forwardToAlwaysdata('DELETE', `/internal/users/${targetUserId}`);
        } catch (err) {}
      }
      await sessionManager.stopSession(targetUserId);
      await sessionManager.resetSession(targetUserId);
      const deleted = db.deleteUser(targetUserId);
      res.json({ success: deleted });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

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
