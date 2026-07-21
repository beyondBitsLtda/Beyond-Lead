// /api/process-lead.js
// Processa 1 lead: dedup no Trello + scrape + Gemini + cria card.

import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Referer: 'https://www.google.com/'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { url, query, place, dedup } = req.body || {};

  if (!place || !place.nome) {
    return res.status(400).json({
      error: 'Dados do place ausentes. Reenvie com o campo "place" preenchido.'
    });
  }

  try {
    if (dedup) {
      const isDuplicate = await checkDuplicate(place);
      if (isDuplicate) {
        return res.status(200).json({
          success: false,
          stage: 'dedup',
          reason: 'Lead já cadastrado no Trello.',
          duplicate_of: isDuplicate
        });
      }
    }

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

    if (place.site) {
      try {
        const cleanText = await scrapeSite(place.site);
        if (cleanText && cleanText.length > 80) {
          const enrich = await extractEmailAndSummary(cleanText, place.site);
          lead.email = enrich.email || null;
          lead.resumo = enrich.resumo || null;
        }
      } catch {
        // segue sem enriquecer
      }
    }

    const card = await createTrelloCard(lead, query);

    return res.status(200).json({
      success: true,
      lead,
      trello: {
        id: card.id,
        name: card.name,
        url: card.shortUrl || card.url
      }
    });
  } catch (error) {
    console.error(`[/api/process-lead] erro:`, error.message);
    return res.status(200).json({
      success: false,
      error: error.message || 'Erro desconhecido ao processar lead.'
    });
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
async function checkDuplicate(place) {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const listId = process.env.TRELLO_LIST_ID;
  if (!apiKey || !token || !listId) return null;

  try {
    const response = await axios.get(
      `https://api.trello.com/1/lists/${listId}/cards`,
      { params: { key: apiKey, token, fields: 'name,desc,shortUrl' }, timeout: 10000 }
    );
    const cards = response.data || [];
    const nName = normalize(place.nome);
    const nSite = place.site ? normalize(place.site) : null;
    for (const card of cards) {
      if (normalize(card.name) === nName) return { id: card.id, name: card.name, url: card.shortUrl, match: 'nome' };
      if (nSite && normalize(card.desc || '').includes(nSite)) return { id: card.id, name: card.name, url: card.shortUrl, match: 'site' };
    }
    return null;
  } catch (err) {
    console.error('[dedup] erro:', err.message);
    return null;
  }
}
function normalize(t) { return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'').trim(); }

/* ========== Scrape + Gemini ========== */
async function scrapeSite(url) {
  const response = await axios.get(url, {
    timeout: 12000, maxRedirects: 5, httpsAgent, headers: BROWSER_HEADERS,
    validateStatus: (s) => s >= 200 && s < 400
  });
  const $ = cheerio.load(response.data);
  $('script, style, noscript, iframe, svg, img, link, meta').remove();
  let text = $('body').text().replace(/\s+/g, ' ').trim();
  if (text.length > 6000) text = text.slice(0, 6000);
  return text;
}

async function extractEmailAndSummary(text, url) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { email: null, resumo: null };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const prompt = [
    `Extraia do texto abaixo (site ${url}) APENAS:`,
    '- email (primeiro e-mail comercial encontrado, ou null)',
    '- resumo (descrição de 1-2 frases do que a empresa faz, ou null)',
    '', 'Responda APENAS um JSON: {"email":"...","resumo":"..."}',
    '', 'Texto:', '"""', text, '"""'
  ].join('\n');
  try {
    const response = await axios.post(endpoint, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 300, responseMimeType: 'application/json' }
    }, { timeout: 20000, headers: { 'Content-Type': 'application/json' } });
    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { email: null, resumo: null };
  }
}

/* ========== Trello card ========== */
async function createTrelloCard(lead, query) {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const listId = process.env.TRELLO_LIST_ID;
  if (!apiKey || !token || !listId) throw new Error('Credenciais do Trello não configuradas.');

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
  sections.push(`🕒 **Prospectado em:** ${new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })}`);

  const desc = sections.join('\n');
  const response = await axios.post('https://api.trello.com/1/cards', null, {
    params: { key: apiKey, token, idList: listId, name: lead.nome_empresa, desc, pos: 'bottom' },
    timeout: 10000
  });
  return response.data;
}
