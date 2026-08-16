/**
 * Cloudflare Worker — Application & Control Plane
 * Hosts: Frontend, Authentication, User DB, Settings, Encrypted BYOK, Admin Console, and Gateway to Alwaysdata.
 * ZERO Baileys imports.
 */

async function hmacSha256(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeBody(body, method = 'GET') {
  if (method && ['GET', 'HEAD', 'DELETE'].includes(method.toUpperCase()) && (!body || (typeof body === 'object' && Object.keys(body).length === 0))) {
    return '';
  }
  if (!body) return '';
  if (typeof body === 'object') {
    if (Object.keys(body).length === 0) return '';
    return JSON.stringify(body);
  }
  return String(body);
}

async function createSignedHeaders(secret, method, path, body = '') {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const normBody = normalizeBody(body, method);
  const canonicalString = `${method.toUpperCase()}|${path}|${timestamp}|${nonce}|${normBody}`;
  const signature = await hmacSha256(secret, canonicalString);

  return {
    'x-internal-key': secret,
    'x-internal-timestamp': timestamp,
    'x-internal-nonce': nonce,
    'x-internal-signature': signature,
    'Content-Type': 'application/json'
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const alwaysdataUrl = (env.ALWAYSDATA_BASE_URL || '').replace(/\/+$/, '');
    const internalSecret = env.INTERNAL_API_KEY || 'default-internal-service-secret-2026';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // Forwarding WhatsApp runtime & control requests to Alwaysdata
    if (url.pathname.startsWith('/api/control/') || url.pathname === '/api/status' || url.pathname.startsWith('/api/logs')) {
      const authHeader = request.headers.get('Authorization') || '';
      if (!authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const token = authHeader.substring(7).trim();
      // Resolve user from KV or internal DB session
      let userId = 'user_gohar'; // Default or resolved from KV
      if (env.USERS_KV) {
        const sessionStr = await env.USERS_KV.get(`session:${token}`);
        if (sessionStr) {
          const s = JSON.parse(sessionStr);
          userId = s.userId;
        } else {
          return new Response(JSON.stringify({ error: 'Invalid session' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      let targetInternalPath = '';
      let targetMethod = request.method;
      let requestBody = null;

      if (url.pathname === '/api/status') {
        targetInternalPath = `/internal/status/${userId}`;
        targetMethod = 'GET';
      } else if (url.pathname === '/api/control/start') {
        targetInternalPath = `/internal/control/${userId}/start`;
        targetMethod = 'POST';
      } else if (url.pathname === '/api/control/stop') {
        targetInternalPath = `/internal/control/${userId}/stop`;
        targetMethod = 'POST';
      } else if (url.pathname === '/api/control/reset_session') {
        targetInternalPath = `/internal/control/${userId}/reset`;
        targetMethod = 'POST';
      } else if (url.pathname === '/api/logs') {
        targetInternalPath = `/internal/logs/${userId}`;
        targetMethod = 'GET';
      } else if (url.pathname === '/api/logs/stream') {
        targetInternalPath = `/internal/logs/stream/${userId}`;
        targetMethod = 'GET';
      }

      if (targetInternalPath && alwaysdataUrl) {
        const signedHeaders = await createSignedHeaders(internalSecret, targetMethod, targetInternalPath, requestBody);
        const targetUrl = `${alwaysdataUrl}${targetInternalPath}`;

        return fetch(targetUrl, {
          method: targetMethod,
          headers: signedHeaders,
          body: requestBody ? JSON.stringify(requestBody) : undefined
        });
      }
    }

    // Default static or API response
    return new Response(JSON.stringify({ message: 'Cloudflare Control Plane Operational' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
