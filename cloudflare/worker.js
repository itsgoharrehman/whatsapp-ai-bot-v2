/**
 * Cloudflare Worker — Application & Control Plane Gateway
 * Hosts: Frontend Assets via Cloudflare Edge, Secure API Gateway to Alwaysdata Runtime.
 * ZERO Baileys imports.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const alwaysdataUrl = (env.ALWAYSDATA_BASE_URL || 'https://goharrehman.alwaysdata.net').replace(/\/+$/, '');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // API Gateway routing -> Alwaysdata Backend
    if (url.pathname.startsWith('/api/')) {
      const targetUrl = `${alwaysdataUrl}${url.pathname}${url.search}`;
      
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set('Host', new URL(alwaysdataUrl).host);
      forwardHeaders.set('X-Forwarded-Host', url.host);
      forwardHeaders.set('X-Forwarded-Proto', 'https');

      // Special handling for SSE Log Streams
      if (url.pathname === '/api/logs/stream') {
        const response = await fetch(targetUrl, {
          method: 'GET',
          headers: forwardHeaders
        });
        return new Response(response.body, {
          status: response.status,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // Forward request to Alwaysdata
      const init = {
        method: request.method,
        headers: forwardHeaders
      };

      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) {
        init.body = request.body;
      }

      try {
        const response = await fetch(targetUrl, init);
        const resHeaders = new Headers(response.headers);
        resHeaders.set('Access-Control-Allow-Origin', '*');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: resHeaders
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: `Gateway Error: ${err.message}` }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Serve Static Assets (frontend HTML, CSS, JS) via Cloudflare Assets
    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        return assetResponse;
      }
      // SPA Fallback to index.html
      const fallbackUrl = new URL('/index.html', request.url);
      return env.ASSETS.fetch(new Request(fallbackUrl, request));
    }

    return new Response('Cloudflare Control Plane Gateway Active', {
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};
