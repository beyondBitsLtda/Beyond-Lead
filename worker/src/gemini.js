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
// PENSAMENTO. Os modelos Gemini 3 "pensam" antes de responder, e o 3.6-flash vem com nível
// médio por padrão. Esse pensamento é lento e sai do MESMO limite de maxOutputTokens: com 2048
// tokens, ele consumia o limite inteiro e a resposta voltava vazia (MAX_TOKENS) — a Lisa
// demorava e às vezes não respondia nada. Por isso pedimos nível baixo (GEMINI_THINKING;
// "off" não manda o parâmetro). Se um modelo recusar o parâmetro (400), repetimos sem ele.
//
// TETO DE TENTATIVAS. O Worker gratuito aceita 50 chamadas de rede por pedido; 35 chaves vezes
// 3 modelos vezes 6 rodadas da Lisa passaria muito disso. Cada chamada tem um teto próprio e,
// quando quem chama passa um `orcamento`, as tentativas são descontadas dele.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DESCANSO_COTA_MS = 5 * 60 * 1000;
const SOBRECARGA_MS = 60 * 1000;
const SOBRECARGAS_ANTES_DA_RESERVA = 2;
const TENTATIVAS_POR_CHAMADA = 8;
const TEMPO_POR_TENTATIVA_MS = 25000;

const cansadas = new Map();          // `${modelo}|${chave}` → até quando descansa (429)
const sobrecarregados = new Map();   // modelo → até quando evitar (503)
const semPensamento = new Set();     // modelos que recusaram thinkingConfig (400)
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
 * `semFerramentas: true` obriga o modelo a responder em texto, sem chamar ferramentas.
 * `pensamento`: nível de raciocínio (minimal, low, medium, high); padrão GEMINI_THINKING ou low.
 * `orcamento` ({ restantes, prazo? }) é opcional e compartilhado entre as rodadas de um pedido;
 * `prazo` é o instante (ms) depois do qual não se começa nem se espera mais nenhuma tentativa.
 */
export async function conversar(env, {
  contents, sistema, ferramentas, semFerramentas = false, maxTokens = 2048, temperatura = 0.3, json = false,
  orcamento, pensamento
}) {
  if (!temModelo(env)) throw new Error('falta GEMINI_API_KEY no Worker');

  const nivel = String(pensamento || env.GEMINI_THINKING || 'low').trim().toLowerCase();
  const montarCorpo = (comPensamento) => JSON.stringify({
    contents,
    ...(sistema ? { systemInstruction: { parts: [{ text: sistema }] } } : {}),
    ...(ferramentas?.length ? { tools: [{ functionDeclarations: ferramentas }] } : {}),
    // As ferramentas continuam declaradas (o histórico tem chamadas a elas), mas o modelo não
    // pode chamar nenhuma: tem de escrever a resposta.
    ...(ferramentas?.length && semFerramentas ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
    generationConfig: {
      temperature: temperatura,
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: 'application/json' } : {}),
      ...(comPensamento ? { thinkingConfig: { thinkingLevel: nivel } } : {})
    }
  });
  const pedePensamento = nivel && nivel !== 'off';

  let tentativas = 0;
  let ultimoErro = null;
  const restaTempo = () => (orcamento?.prazo ? orcamento.prazo - Date.now() : TEMPO_POR_TENTATIVA_MS);
  const podeTentar = () => tentativas < TENTATIVAS_POR_CHAMADA
    && (!orcamento || orcamento.restantes > 0)
    && restaTempo() > 2000;

  for (const modelo of ordemDosModelos(env)) {
    let sobrecargas = 0;
    let comPensamento = pedePensamento && !semPensamento.has(modelo);
    const chavesDoModelo = disponiveis(env, modelo);
    for (let i = 0; i < chavesDoModelo.length; i++) {
      const chave = chavesDoModelo[i];
      if (!podeTentar()) break;
      tentativas++;
      if (orcamento) orcamento.restantes--;

      let resposta;
      try {
        resposta = await fetch(`${BASE}/${modelo}:generateContent?key=${encodeURIComponent(chave)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: montarCorpo(comPensamento),
          signal: AbortSignal.timeout(Math.min(TEMPO_POR_TENTATIVA_MS, restaTempo()))
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
        const mensagem = dados?.error?.message || `o modelo respondeu ${resposta.status}`;
        // O modelo não aceita o nível de pensamento: lembra disso e repete com a mesma chave.
        if (resposta.status === 400 && comPensamento && /think/i.test(mensagem)) {
          semPensamento.add(modelo);
          comPensamento = false;
          i--;
          continue;
        }
        ultimoErro = new Error(mensagem);
        // 400 é o pedido que está errado, não a chave: trocar de chave só repetiria o erro.
        if (resposta.status === 400) break;
        continue;
      }

      const candidata = dados?.candidates?.[0];
      const motivo = candidata?.finishReason;
      const util = (candidata?.content?.parts || []).some((p) => p.text || p.functionCall);
      if (!util) {
        throw new Error(
          motivo === 'SAFETY' ? 'o modelo recusou responder a isso'
            : motivo === 'MAX_TOKENS' ? 'o modelo gastou o limite de resposta pensando e não respondeu — tente um pedido mais direto'
              : 'o modelo devolveu uma resposta vazia'
        );
      }
      sobrecarregados.delete(modelo);
      candidata.content.modelo = modelo;
      return candidata.content;
    }
    if (!podeTentar()) break;
  }
  if (orcamento?.prazo && restaTempo() <= 2000 && !ultimoErro) {
    ultimoErro = new Error('o modelo de IA demorou demais para responder — tente de novo em instantes');
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
