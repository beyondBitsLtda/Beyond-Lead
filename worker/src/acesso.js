// /worker/src/acesso.js
// Chave de acesso da equipe (secret ACESSO_EQUIPE), pedida uma vez pela tela e enviada no
// cabeçalho X-Beyond-Acesso em todo pedido.
//
// O site mora no GitHub Pages, que é público: sem esta porta, qualquer pessoa com o link lê o
// funil (faturamento, telefones dos leads) e conversa com a Lisa gastando a cota do modelo.
// É uma chave só para a equipe inteira — não diz QUEM fez o quê. Trocar o secret derruba o
// acesso de todo mundo de uma vez, que é também como se revoga.

export const CABECALHO_ACESSO = 'X-Beyond-Acesso';

async function digest(texto) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(texto))));
}

/**
 * `{ ok: true }` ou `{ ok: false, status, error }`.
 * Fecha por padrão: sem o secret configurado, ninguém entra — melhor a tela pedir
 * configuração do que a API ficar aberta sem ninguém perceber.
 */
export async function conferirAcesso(request, env) {
  if (!env.ACESSO_EQUIPE) {
    return { ok: false, status: 503, error: 'Acesso da equipe não configurado no servidor.' };
  }
  const enviada = request.headers.get(CABECALHO_ACESSO);
  if (!enviada) return { ok: false, status: 401, error: 'Informe a chave de acesso da equipe.' };

  // Compara os hashes byte a byte, sem sair no primeiro diferente: o tempo de resposta não
  // pode contar quantos caracteres do começo estavam certos.
  const [a, b] = await Promise.all([digest(enviada), digest(env.ACESSO_EQUIPE)]);
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a[i] ^ b[i];
  return diferenca === 0
    ? { ok: true }
    : { ok: false, status: 401, error: 'Chave de acesso inválida.' };
}
