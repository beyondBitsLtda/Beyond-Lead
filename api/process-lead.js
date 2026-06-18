// /api/process-lead.js
// Para UMA URL: faz scraping com cheerio, extrai dados com Gemini 1.5 Flash
// e cria um card no Trello.

import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';

// Agent que ignora certificados SSL inválidos.
// Muitos sites brasileiros pequenos têm certificados expirados/auto-assinados.
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// Redes sociais que sempre bloqueiam scrapers — descartamos automaticamente.
const SOCIAL_DOMAINS = [
  'instagram.com',
  'facebook.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'youtube.com',
  'pinterest.com',
  'wa.me',
  'whatsapp.com'
];

// Headers de browser real — reduz bloqueios anti-bot.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
};

/* ============================================================
   Handler principal
   ============================================================ */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { url, query } = req.body || {};

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Parâmetro "url" inválido ou ausente.' });
  }

  // Filtra redes sociais antes de gastar tempo
  if (isSocialNetwork(url)) {
    return res.status(200).json({
      success: false,
      url,
      stage: 'filter',
      reason: 'URL de rede social — bloqueia scrapers automatizados.'
    });
  }

  try {
    const cleanText = await scrapeSite(url);

    if (!cleanText || cleanText.length < 80) {
      return res.status(200).json({
        success: false,
        url,
        stage: 'scrape',
        reason: 'Conteúdo insuficiente extraído do site.'
      });
    }

    const lead = await extractWithGemini(cleanText, url);
    const card = await createTrelloCard(lead, url, query);

    return res.status(200).json({
      success: true,
      url,
      lead,
      trello: {
        id: card.id,
        name: card.name,
        url: card.shortUrl || card.url
      }
    });
  } catch (error) {
    console.error(`[/api/process-lead] erro em ${url}:`, error.message);
    return res.status(200).json({
      success: false,
      url,
      error: error.message || 'Erro desconhecido ao processar lead.'
    });
  }
}

/* ============================================================
   1) Scraping
   ============================================================ */
async function scrapeSite(url) {
  const response = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    httpsAgent,
    headers: BROWSER_HEADERS,
    validateStatus: (status) => status >= 200 && status < 400
  });

  const $ = cheerio.load(response.data);

  $(
    'script, style, noscript, iframe, svg, img, link, meta, ' +
      'header nav, footer, .cookie, .cookies, .modal, .popup, ' +
      '[class*="banner"], [class*="advert"]'
  ).remove();

  let text = $('body').text().replace(/\s+/g, ' ').trim();
  if (text.length > 8000) text = text.slice(0, 8000);

  return text;
}

/* ============================================================
   2) Extração com Gemini
   ============================================================ */
async function extractWithGemini(text, url) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada.');

  const model = 'gemini-1.5-flash';
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const prompt = [
    'Você é um assistente de extração de dados para prospecção comercial B2B.',
    `A seguir está o texto bruto extraído do site ${url}.`,
    'Identifique as informações abaixo e responda EXCLUSIVAMENTE com um JSON válido,',
    'sem markdown, sem comentários, sem texto antes ou depois.',
    '',
    'Campos:',
    '- nome_empresa (string|null): nome comercial da empresa',
    '- email (string|null): primeiro e-mail comercial encontrado',
    '- telefone (string|null): telefone com DDD, no formato (XX) XXXXX-XXXX se possível',
    '- nicho (string|null): segmento de atuação em uma frase curta',
    '- resumo (string|null): descrição de 1-2 frases do que a empresa faz',
    '',
    'Use null quando a informação não estiver clara. Não invente dados.',
    '',
    'Texto do site:',
    '"""',
    text,
    '"""'
  ].join('\n');

  const response = await axios.post(
    endpoint,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 600,
        responseMimeType: 'application/json'
      }
    },
    {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    }
  );

  const raw =
    response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

  if (!raw) throw new Error('Gemini retornou resposta vazia.');

  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('JSON inválido retornado pelo Gemini: ' + cleaned.slice(0, 120));
  }

  return {
    nome_empresa: parsed.nome_empresa || null,
    email: parsed.email || null,
    telefone: parsed.telefone || null,
    nicho: parsed.nicho || null,
    resumo: parsed.resumo || null
  };
}

/* ============================================================
   3) Card no Trello
   ============================================================ */
async function createTrelloCard(lead, url, query) {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const listId = process.env.TRELLO_LIST_ID;

  if (!apiKey || !token || !listId) {
    throw new Error(
      'Credenciais do Trello (TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_LIST_ID) não configuradas.'
    );
  }

  const cardName = lead.nome_empresa || safeHostname(url);

  const desc = [
    `**Nicho:** ${lead.nicho || '—'}`,
    `**E-mail:** ${lead.email || '—'}`,
    `**Telefone:** ${lead.telefone || '—'}`,
    `**Site:** ${url}`,
    '',
    `**Resumo:**`,
    lead.resumo || '—',
    '',
    `---`,
    `**Termo de busca:** ${query || '—'}`,
    `**Prospectado em:** ${new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo'
    })}`
  ].join('\n');

  const response = await axios.post('https://api.trello.com/1/cards', null, {
    params: {
      key: apiKey,
      token: token,
      idList: listId,
      name: cardName,
      desc: desc,
      pos: 'bottom'
    },
    timeout: 10000
  });

  return response.data;
}

/* ============================================================
   Utilitários
   ============================================================ */
function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSocialNetwork(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return SOCIAL_DOMAINS.some((d) => hostname.includes(d));
  } catch {
    return false;
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
