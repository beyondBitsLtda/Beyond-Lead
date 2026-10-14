// /worker/src/gemini.js
// O modelo da Lisa (e do enriquecimento de leads), falado direto pela API REST do Gemini.
// Mesmo desenho da Lisa do beyond-assist: várias chaves numa fila e modelos reserva.
//
// SOBRECARGA NÃO É COTA. O Google responde 503 ("This model is currently experiencing high
// demand") quando o MODELO está sobrecarregado — para todo mundo, com qualquer chave. Medido em
// 14/10/2026: gemini-3.6-flash e gemini-3.5-flash em 503 nas chaves testadas, enquanto o
// gemini-3.5-flash-lite respondia em menos de 1 s. Por isso:
//   429         → cota: a chave descansa 5 min NAQUELE modelo e a próxima tenta;
//   503/500/504 → sobrecarga: ninguém é castigado; depois de 2, passa para o modelo reserva,
//                 e o modelo fica marcado como sobrecarregado por 1 min (as rodadas seguintes
//                 vão direto ao reserva em vez de pagar de novo a espera);
//   404         → modelo desligado: vai direto para o reserva.
//
// TETO DE TENTATIVAS. O Worker gratuito aceita 50 chamadas de rede por pedido; 35 chaves vezes
// 3 modelos vezes 6 rodadas da Lisa passaria muito disso. Cada chamada tem um teto próprio e,
// quando quem chama passa um `orcamento`, as tentativas são descontadas dele.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DESCANSO_COTA_MS = 5 * 60 * 1000;
const SOBRECARGA_MS = 60 * 1000;
const SOBRECARGAS_ANTES_DA_RESERVA = 2;
const TENTATIVAS_POR_CHAMADA = 8;

const cansadas = new Map();          // `${modelo}|${chave}` → até quando descansa (429)
const sobrecarregados = new Map();   // modelo → até quando evitar (503)
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

export const modeloDe = (env) => env.GEMINI_CHAT_MODEL || 'gemini-3.6-flash';

/** Principal primeiro, depois as reservas (GEMINI_CHAT_RESERVAS, separadas por vírgula). */
export function modelosDe(env) {
  const reservas = String(env.GEMINI_CHAT_RESERVAS || 'gemini-3.5-flash-lite,gemini-3.5-flash')
    .split(/[,\s]+/).map((m) => m.trim()).filter(Boolean);
  return [...new Set([modeloDe(env), ...reservas])];
}

function chaves(env) {
  return String(env.GEMINI_API_KEYS || env.GEMINI_API_KEY || '')
    .split(/[,\s]+/).map((k) => k.trim()).filter(Boolean);
}

export const temModelo = (env) => chaves(env).length > 0;

function disponiveis(env, modelo) {
  const agora = Date.now();
  const todas = chaves(env);
  const prontas = todas.filter((k) => (cansadas.get(`${modelo}|${k}`) || 0) < agora);
  // Se todas estão de castigo, tenta assim mesmo: melhor um 429 do que desistir antes da hora.
  return prontas.length ? prontas : todas;
}

/** Os modelos na ordem de tentativa: os marcados como sobrecarregados vão para o fim. */
function ordemDosModelos(env) {
  const agora = Date.now();
  const todos = modelosDe(env);
  const saudaveis = todos.filter((m) => (sobrecarregados.get(m) || 0) < agora);
  return [...saudaveis, ...todos.filter((m) => !saudaveis.includes(m))];
}

/**
 * Uma rodada com o modelo. Devolve o `content` da primeira candidata (texto e/ou chamadas de
 * função), com `content.modelo` dizendo quem respondeu. `json: true` pede JSON puro.
 * `orcamento` ({ restantes }) é opcional e compartilhado entre as rodadas de um pedido.
 */
export async function conversar(env, {
  contents, sistema, ferramentas, maxTokens = 2048, temperatura = 0.3, json = false, orcamento
}) {
  if (!temModelo(env)) throw new Error('falta GEMINI_API_KEY no Worker');

  const corpo = JSON.stringify({
    contents,
    ...(sistema ? { systemInstruction: { parts: [{ text: sistema }] } } : {}),
    ...(ferramentas?.length ? { tools: [{ functionDeclarations: ferramentas }] } : {}),
    generationConfig: {
      temperature: temperatura,
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: 'application/json' } : {})
    }
  });

  let tentativas = 0;
  let ultimoErro = null;
  const podeTentar = () => tentativas < TENTATIVAS_POR_CHAMADA && (!orcamento || orcamento.restantes > 0);

  for (const modelo of ordemDosModelos(env)) {
    let sobrecargas = 0;
    for (const chave of disponiveis(env, modelo)) {
      if (!podeTentar()) break;
      tentativas++;
      if (orcamento) orcamento.restantes--;

      let resposta;
      try {
        resposta = await fetch(`${BASE}/${modelo}:generateContent?key=${encodeURIComponent(chave)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: corpo,
          signal: AbortSignal.timeout(25000)
        });
      } catch (e) {
        // Tempo esgotado conta como sobrecarga: o modelo pendurou, outra chave não muda isso.
        ultimoErro = new Error('o modelo de IA demorou demais para responder — tente de novo em instantes');
        if (++sobrecargas >= SOBRECARGAS_ANTES_DA_RESERVA) break;
        continue;
      }

      if (resposta.status === 429) {
        cansadas.set(`${modelo}|${chave}`, Date.now() + DESCANSO_COTA_MS);
        ultimoErro = new Error('a cota do modelo acabou por agora — tente daqui a alguns minutos');
        continue;
      }
      if (resposta.status === 404) {
        ultimoErro = new Error(`o modelo ${modelo} não está disponível`);
        break;
      }
      if (resposta.status === 503 || resposta.status === 500 || resposta.status === 504) {
        ultimoErro = new Error('o modelo de IA está sobrecarregado agora (pico de uso no Google) — tente de novo em instantes');
        if (++sobrecargas >= SOBRECARGAS_ANTES_DA_RESERVA) {
          sobrecarregados.set(modelo, Date.now() + SOBRECARGA_MS);
          break;
        }
        await esperar(500 * sobrecargas);
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
      sobrecarregados.delete(modelo);
      candidata.content.modelo = modelo;
      return candidata.content;
    }
    if (!podeTentar()) break;
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
