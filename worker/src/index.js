// /worker/src/index.js
// Back-end do Beyond-Lead no Cloudflare Workers: roteia /api/* e aplica CORS.
// As chaves (Serper, Gemini, Abacato) chegam em `env` como secrets do Worker.

import { search } from './search.js';
import { processLead } from './process-lead.js';
import { funilStats } from './funil.js';

const ROUTES = {
  '/api/search': { method: 'POST', handler: search },
  '/api/process-lead': { method: 'POST', handler: processLead },
  '/api/funil': { method: 'GET', handler: funilStats }
};

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const { pathname } = new URL(request.url);
    const route = ROUTES[pathname.replace(/\/+$/, '')];

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!route) {
      return json(404, { error: 'Rota não encontrada.' }, cors);
    }
    if (request.method !== route.method) {
      return json(405, { error: `Método não permitido. Use ${route.method}.` }, { ...cors, Allow: route.method });
    }

    const body = route.method === 'POST' ? await request.json().catch(() => ({})) : {};

    try {
      const { status, data } = await route.handler(body, env);
      return json(status, data, cors);
    } catch (error) {
      console.error(`[${pathname}] erro:`, error.message);
      return json(500, { success: false, error: 'Erro interno.' }, cors);
    }
  }
};

// ALLOWED_ORIGINS: lista separada por vírgula (ex.: "https://beyondbitsltda.github.io").
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}
