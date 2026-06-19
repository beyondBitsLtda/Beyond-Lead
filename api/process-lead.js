// /api/process-lead.js
// Versão com deduplicação: antes de criar o card, lista os existentes
// na lista do Trello e ignora se já houver um com o mesmo nome ou site.

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
    // 1) DEDUPLICAÇÃO — se o usuário pediu, checa se já existe no Trello
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

    // 2) Monta o lead com dados do Maps
    const lead = {
      nome_empresa: place.nome,
      email: null,
      telefone: place.telefone || null,
      endereco: place.endereco || null,
      nicho: place.categoria || null,
      site: place.site || null,
      rating: place.rating || null,
      reviews: place.reviews || null,
      resumo: null
    };

    // 3) Se tem site, enriquece com e-mail (best-effort)
    if (place.site) {
      try {
        const cleanText = await scrapeSite(place.site);
        if (cleanText && cleanText.length > 80) {
          const enrich = await extractEmailAndSummary(cleanText, place.site);
          lead.email = enrich.email || null;
          lead.resumo = enrich.resumo || null;
        }
      } catch {
        // Scrape falhou? Sem problema, segue com os dados do Maps.
      }
    }

    // 4) Cria card no Trello
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

/* ============================================================
   Deduplicação — consulta a lista do Trello
   ============================================================ */
async function checkDuplicate(place) {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const listId = process.env.TRELLO_LIST_ID;

  if (!apiKey || !token || !listId) return null;

  try {
    const response = await axios.get(
      `https://api.trello.com/1/lists/${listId}/cards`,
      {
        params: {
          key: apiKey,
          token,
          fields: 'name,desc,shortUrl'
        },
        timeout: 10000
      }
    );

    const cards = response.data || [];
    const normalizedName = normalize(place.nome);
    const normalizedSite = place.site ? normalize(place.site) : null;

    for (const card of cards) {
      const cardNameNorm = normalize(card.name);
      const cardDescNorm = normalize(card.desc || '');

      // Match por nome (exato após normalização)
      if (cardNameNorm === normalizedName) {
        return { id: card.id, name: card.name, url: card.shortUrl, match: 'nome' };
      }

      // Match por site (se ambos têm site)
      if (normalizedSite && cardDescNorm.includes(normalizedSite)) {
        return { id: card.id, name: card.name, url: card.shortUrl, match: 'site' };
      }
    }

    return null;
  } catch (err) {
    // Se não conseguiu consultar, segue criando (melhor duplicar do que travar)
    console.error('[dedup] erro ao consultar Trello:', err.message);
    return null;
  }
}

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/* ============================================================
   Scraping do site para enriquecimento
   ============================================================ */
async function scrapeSite(url) {
  const response = await axios.get(url, {
    timeout: 12000,
    maxRedirects: 5,
    httpsAgent,
    headers: BROWSER_HEADERS,
    validateStatus: (s) => s >= 200 && s < 400
  });

  const $ = cheerio.load(response.data);
  $('script, style, noscript, iframe, svg, img, link, meta').remove();
  let text = $('body').text().replace(/\s+/g, ' ').trim();
  if (text.length > 6000) text = text.slice(0, 6000);
  return text;
}

/* ============================================================
   Extração com Gemini
   ============================================================ */
async function extractEmailAndSummary(text, url) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { email: null, resumo: null };

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const prompt = [
    `Extraia do texto abaixo (site ${url}) APENAS:`,
    '- email (primeiro e-mail comercial encontrado, ou null)',
    '- resumo (descrição de 1-2 frases do que a empresa faz, ou null)',
    '',
    'Responda APENAS um JSON: {"email":"...","resumo":"..."}',
    '',
    'Texto:',
    '"""',
    text,
    '"""'
  ].join('\n');

  try {
    const response = await axios.post(endpoint, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 300,
        responseMimeType: 'application/json'
      }
    }, { timeout: 20000, headers: { 'Content-Type': 'application/json' } });

    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { email: null, resumo: null };
  }
}

/* ============================================================
   Card no Trello
   ============================================================ */
async function createTrelloCard(lead, query) {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const listId = process.env.TRELLO_LIST_ID;

  if (!apiKey || !token || !listId) {
    throw new Error('Credenciais do Trello não configuradas.');
  }

  const desc = [
    `**Nicho:** ${lead.nicho || '—'}`,
    `**Telefone:** ${lead.telefone || '—'}`,
    `**E-mail:** ${lead.email || '—'}`,
    `**Endereço:** ${lead.endereco || '—'}`,
    `**Site:** ${lead.site || '—'}`,
    lead.rating
      ? `**Avaliação Google:** ⭐ ${lead.rating} (${lead.reviews || 0} reviews)`
      : '',
    '',
    lead.resumo ? `**Resumo:**\n${lead.resumo}` : '',
    '',
    `---`,
    `**Termo de busca:** ${query || '—'}`,
    `**Prospectado em:** ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
  ].filter(Boolean).join('\n');

  const response = await axios.post('https://api.trello.com/1/cards', null, {
    params: {
      key: apiKey,
      token,
      idList: listId,
      name: lead.nome_empresa,
      desc,
      pos: 'bottom'
    },
    timeout: 10000
  });

  return response.data;
}
