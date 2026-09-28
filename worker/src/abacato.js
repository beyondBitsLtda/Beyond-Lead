// /worker/src/abacato.js
// Cliente da API de integração do Abacato (quadro do CRM).
// O token (secret ABACATO_TOKEN) abre um quadro só; qual é o quadro e em que coluna os leads
// entram é decidido no Abacato, não aqui.

export function abacatoBase(env) {
  return (env.ABACATO_URL || 'https://abacato.beyond.dev.br').replace(/\/+$/, '');
}

export function urlDoCard(env, quadroId, cardId) {
  return `${abacatoBase(env)}/quadros/${quadroId}?card=${cardId}`;
}

export async function abacato(env, caminho, { method = 'GET', body, timeout = 20000 } = {}) {
  if (!env.ABACATO_TOKEN) throw new Error('ABACATO_TOKEN não configurado.');

  const response = await fetch(`${abacatoBase(env)}/api/integracoes${caminho}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.ABACATO_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Abacato HTTP ${response.status}: ${data.error || 'sem detalhe'}`);
  return data;
}
