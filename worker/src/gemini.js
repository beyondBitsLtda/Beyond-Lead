// /worker/src/gemini.js
// O modelo da Lisa (e do enriquecimento de leads), falado direto pela API REST do Gemini.
// Mesmo desenho da Lisa do Abacato: várias chaves numa fila; a que devolve 429 descansa
// alguns minutos para não gastar uma ida de rede toda vez só para ouvir o mesmo não.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DESCANSO_MS = 5 * 60 * 1000;
const cansadas = new Map();

export const modeloDe = (env) => env.GEMINI_CHAT_MODEL || 'gemini-3.6-flash';

function chaves(env) {
  return String(env.GEMINI_API_KEYS || env.GEMINI_API_KEY || '')
    .split(/[,\s]+/).map((k) => k.trim()).filter(Boolean);
}

export const temModelo = (env) => chaves(env).length > 0;

function disponiveis(env) {
  const agora = Date.now();
  const todas = chaves(env);
  const prontas = todas.filter((k) => (cansadas.get(k) || 0) < agora);
  return prontas.length ? prontas : todas;
}

/**
 * Uma rodada com o modelo. Devolve o `content` da primeira candidata (texto e/ou chamadas
 * de função). `json: true` pede resposta em JSON puro (usado no enriquecimento).
 */
export async function conversar(env, { contents, sistema, ferramentas, maxTokens = 2048, temperatura = 0.3, json = false }) {
  const lista = disponiveis(env);
  if (!lista.length) throw new Error('falta GEMINI_API_KEY no Worker');

  const corpo = {
    contents,
    ...(sistema ? { systemInstruction: { parts: [{ text: sistema }] } } : {}),
    ...(ferramentas?.length ? { tools: [{ functionDeclarations: ferramentas }] } : {}),
    generationConfig: {
      temperature: temperatura,
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: 'application/json' } : {})
    }
  };

  let ultimoErro = null;
  for (const chave of lista) {
    let resposta;
    try {
      resposta = await fetch(`${BASE}/${modeloDe(env)}:generateContent?key=${encodeURIComponent(chave)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(30000)
      });
    } catch (e) {
      ultimoErro = new Error(`não consegui falar com o modelo: ${e.message}`);
      continue;
    }

    if (resposta.status === 429 || resposta.status === 503) {
      cansadas.set(chave, Date.now() + DESCANSO_MS);
      ultimoErro = new Error('a cota do modelo acabou por agora — tente daqui a alguns minutos');
      continue;
    }

    const dados = await resposta.json().catch(() => null);
    if (!resposta.ok) {
      ultimoErro = new Error(dados?.error?.message || `o modelo respondeu ${resposta.status}`);
      continue;
    }

    const candidata = dados?.candidates?.[0];
    if (!candidata?.content) {
      const motivo = candidata?.finishReason;
      throw new Error(
        motivo === 'SAFETY' ? 'o modelo recusou responder a isso'
          : motivo === 'MAX_TOKENS' ? 'a resposta não coube no limite de tamanho'
            : 'o modelo devolveu uma resposta vazia'
      );
    }
    return candidata.content;
  }
  throw ultimoErro || new Error('nenhuma chave do modelo respondeu');
}

export function textoDe(conteudo) {
  return (conteudo?.parts || []).map((p) => p.text).filter(Boolean).join('').trim();
}

export function chamadasDe(conteudo) {
  return (conteudo?.parts || [])
    .map((p) => p.functionCall).filter(Boolean)
    .map((f) => ({ nome: f.name, args: f.args || {} }));
}
