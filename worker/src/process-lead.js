// /worker/src/process-lead.js
// Processa 1 lead: dedup no Abacato + scrape + Gemini + cria card no quadro do CRM.

import { abacato, urlDoCard } from './abacato.js';
import { conversar, textoDe, temModelo } from './gemini.js';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Referer: 'https://www.google.com/'
};

export async function processLead(body, env) {
  const { query, place, dedup, sugestaoLisa } = body || {};

  if (!place || !place.nome) {
    return {
      status: 400,
      data: { error: 'Dados do place ausentes. Reenvie com o campo "place" preenchido.' }
    };
  }

  try {
    const telefoneFormatado = formatPhone(place.telefone);
    const lead = {
      nome_empresa: smartTitleCase(place.nome),
      email: null,
      telefone: telefoneFormatado,
      whatsapp_url: buildWhatsappUrl(telefoneFormatado),
      endereco: place.endereco || null,
      nicho: smartTitleCase(place.categoria),
      site: place.site || null,
      maps_url: place.placeId
        ? `https://www.google.com/maps/place/?q=place_id:${place.placeId}`
        : null,
      rating: place.rating || null,
      reviews: place.reviews || null,
      resumo: null
    };

    const cardBase = {
      titulo: lead.nome_empresa,
      site: lead.site,
      origemId: place.placeId || null
    };

    // Confere ANTES do scrape: não gasta cota do Gemini com lead que já está no quadro.
    if (dedup) {
      const conferencia = await abacato(env, '/cards', {
        method: 'POST',
        body: { ...cardBase, apenasConferir: true }
      });
      if (conferencia.duplicado) return duplicado(conferencia.duplicado, env);
    }

    if (place.site) {
      try {
        const cleanText = await scrapeSite(place.site);
        if (cleanText && cleanText.length > 80) {
          const enrich = await extractEmailAndSummary(cleanText, place.site, env);
          lead.email = enrich.email || null;
          lead.resumo = enrich.resumo || null;
        }
      } catch {
        // segue sem enriquecer
      }
    }

    // `dedup` de novo: entre a conferência e aqui, outra rodada pode ter criado o mesmo lead.
    const criado = await abacato(env, '/cards', {
      method: 'POST',
      body: { ...cardBase, descricao: buildDescription(lead, query, Boolean(sugestaoLisa)), dedup: Boolean(dedup) }
    });
    if (criado.duplicado) return duplicado(criado.duplicado, env);

    return {
      status: 200,
      data: {
        success: true,
        lead,
        card: {
          id: criado.card.id,
          name: criado.card.titulo,
          url: urlDoCard(env, criado.card.quadroId, criado.card.id)
        }
      }
    };
  } catch (error) {
    console.error(`[/api/process-lead] erro:`, error.message);
    return {
      status: 200,
      data: {
        success: false,
        error: error.message || 'Erro desconhecido ao processar lead.'
      }
    };
  }
}

/* ========== Formatação ========== */
function smartTitleCase(text) {
  if (!text) return null;
  const lowercase = new Set(['de','da','do','das','dos','e','em','na','no','para','por','a','o','as','os','com','sem']);
  const uppercase = new Set(['me','eireli','ltda','sa','s/a','cnpj','mei','epp']);
  return text.trim().toLowerCase().split(/\s+/).map((word, i) => {
    const clean = word.replace(/[^\wÀ-ÿ]/g, '');
    if (i === 0) return capitalize(word);
    if (uppercase.has(clean)) return word.toUpperCase();
    if (lowercase.has(clean)) return word;
    return capitalize(word);
  }).join(' ');
}
function capitalize(w) { return w ? w[0].toUpperCase() + w.slice(1) : ''; }

function formatPhone(phone) {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  if (d.length === 13 && d.startsWith('55')) return `(${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith('55')) return `(${d.slice(2,4)}) ${d.slice(4,8)}-${d.slice(8)}`;
  return phone.trim();
}

function buildWhatsappUrl(phone) {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (d.length < 12) return null;
  return `https://wa.me/${d}`;
}

/* ========== Dedup ========== */
function duplicado(d, env) {
  return {
    status: 200,
    data: {
      success: false,
      stage: 'dedup',
      reason: 'Lead já está no quadro do CRM.',
      duplicate_of: {
        id: d.id || null,
        name: d.titulo,
        url: d.id ? urlDoCard(env, d.quadroId, d.id) : null,
        match: d.motivo
      }
    }
  };
}

/* ========== Scrape + Gemini ========== */
const SCRAPE_MAX_CHARS = 6000;

// Lê o texto visível do <body> com o HTMLRewriter (streaming, nativo do Workers).
export async function scrapeSite(url) {
  const response = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  let text = '';
  let skipDepth = 0;
  const rewriter = new HTMLRewriter()
    .on('script, style, noscript, iframe, svg, template', {
      element(el) {
        skipDepth += 1;
        el.onEndTag(() => { skipDepth -= 1; });
      }
    })
    .on('body', {
      text(chunk) {
        if (skipDepth > 0 || text.length > SCRAPE_MAX_CHARS * 2) return;
        text += chunk.text;
        if (chunk.lastInTextNode) text += ' ';
      }
    });
  await rewriter.transform(response).arrayBuffer();

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > SCRAPE_MAX_CHARS) text = text.slice(0, SCRAPE_MAX_CHARS);
  return text;
}

async function extractEmailAndSummary(text, url, env) {
  if (!temModelo(env)) return { email: null, resumo: null };
  const prompt = [
    `Extraia do texto abaixo (site ${url}) APENAS:`,
    '- email (primeiro e-mail comercial encontrado, ou null)',
    '- resumo (descrição de 1-2 frases do que a empresa faz, ou null)',
    '', 'Responda APENAS um JSON: {"email":"...","resumo":"..."}',
    '', 'Texto:', '"""', text, '"""'
  ].join('\n');
  try {
    const resposta = await conversar(env, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      maxTokens: 300, temperatura: 0.2, json: true
    });
    const cleaned = textoDe(resposta).replace(/^```json\s*/i, '').replace(/```$/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { email: null, resumo: null };
  }
}

/* ========== Descrição do card ========== */
function buildDescription(lead, query, sugestaoLisa = false) {
  const sections = [];
  sections.push('## 📇 Informações de Contato\n');
  const contato = [];
  if (lead.telefone) contato.push(`📞 **Telefone:** ${lead.telefone}`);
  if (lead.whatsapp_url) contato.push(`💬 **WhatsApp:** ${lead.whatsapp_url}`);
  if (lead.email) contato.push(`✉️ **E-mail:** ${lead.email}`);
  if (lead.endereco) contato.push(`📍 **Endereço:** ${lead.endereco}`);
  sections.push(contato.length ? contato.join('\n') : '_Sem dados de contato._');

  sections.push('\n\n## 🔗 Links\n');
  const links = [];
  if (lead.site) links.push(`🌐 **Site:** ${lead.site}`);
  if (lead.maps_url) links.push(`🗺️ **Google Maps:** ${lead.maps_url}`);
  sections.push(links.length ? links.join('\n') : '_Sem links cadastrados._');

  if (lead.rating) {
    sections.push('\n\n## ⭐ Avaliação no Google\n');
    const stars = '★'.repeat(Math.round(lead.rating)) + '☆'.repeat(5 - Math.round(lead.rating));
    sections.push(`${stars} **${lead.rating.toFixed(1)}** (${lead.reviews || 0} ${lead.reviews === 1 ? 'avaliação' : 'avaliações'})`);
  }
  if (lead.nicho) { sections.push('\n\n## 🏷️ Categoria\n'); sections.push(lead.nicho); }
  if (lead.resumo) { sections.push('\n\n## 📝 Sobre o Negócio\n'); sections.push(lead.resumo); }

  sections.push('\n\n---\n');
  sections.push(`🔎 **Termo de busca:** ${query || '—'}`);
  if (sugestaoLisa) sections.push('🤖 **Sugerido pela Lisa** (IA) e confirmado por uma pessoa no Beyond-Lead.');
  sections.push(`🕒 **Prospectado em:** ${new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })}`);

  return sections.join('\n');
}
