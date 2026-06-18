// /api/process-lead.js
// Versão com limpeza de URL + Referer + Wikipedia filtrada.

import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Domínios filtrados antes do scraping (redes sociais + Wikipedia + Google)
const BLOCKED_DOMAINS = [
  'instagram.com',
  'facebook.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'youtube.com',
  'pinterest.com',
  'wa.me',
  'whatsapp.com',
  'wikipedia.org',
  'google.com',
  'google.com.br',
  'maps.google.com'
];

// Parâmetros de tracking que quebram a URL — sempre removemos antes de acessar
const TRACKING_PARAMS = [
  'srsltid', 'gclid', 'fbclid', 'msclkid',
  'utm_source', 'utm_medium', 'utm_campaign',
  'utm_term', 'utm_content', 'ref', 'source'
];

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  Referer: 'https://www.google.com/'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { url, query } = req.body || {};

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Parâmetro "url" inválido ou ausente.' });
  }

  if (isBlockedDomain(url)) {
    return res.status(200).json({
      success: false,
      url,
      stage: 'filter',
      reason: 'Domínio filtrado (rede social, Wikipedia ou bot-protegido).'
    });
  }

  // Limpa parâmetros de tracking ANTES de qualquer requisição
  const cleanedUrl = cleanUrl(url);

  try {
    const cleanText = await scrapeSite(cleanedUrl);

    if (!cleanText || cleanText.length < 80) {
      return res.status(200).json({
        success: false,
        url: cleanedUrl,
        stage: 'scrape',
        reason: 'Conteúdo insuficiente extraído do site.'
      });
    }

    const lead = await extractWithGemini(cleanText, cleanedUrl);
    const card = await createTrelloCard(lead, cleanedUrl, query);

    return res.status(200).json({
      success: true,
      url: cleanedUrl,
      lead,
      trello: {
        id: card.id,
        name: card.name,
        url: card.shortUrl || card.url
      }
    });
  } catch (error) {
    console.error(`[/api/process-lead] erro em ${cleanedUrl}:`, error.message);
    return res.status(200).json({
      success: false,
      url: cleanedUrl,
      error: error.message || 'Erro desconhecido ao processar lead.'
    });
  }
}

async function scrapeSite(url) {
  const response = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    httpsAgent,
    headers: BROWSER_HEADERS,
    validateStatus: (s) => s >= 200 && s < 400
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

async function extractWithGemini(text, url) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada.');

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const prompt = [
    'Você é um assistente de extração de dados para prospecção comercial B2B.',
    `A seguir está o texto bruto extraído do site ${url}.`,
    'Identifique as informações abaixo e responda EXCLUSIVAMENTE com um JSON válido,',
    'sem markdown, sem comentários, sem texto antes ou depois.',
    '',
    'Campos:',
    '- nome_empresa (string|null)',
    '- email (string|null)',
    '- telefone (string|null) no formato (XX) XXXXX-XXXX se possível',
    '- nicho (string|null) em uma frase curta',
    '- resumo (string|null) de 1-2 frases',
    '',
    'Use null quando não estiver claro. Não invente dados.',
    '',
    'Texto:',
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
    { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
  );

  const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  if (!raw) throw new Error('Gemini retornou resposta vazia.');

  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('JSON inválido do Gemini: ' + cleaned.slice(0, 120));
  }

  return {
    nome_empresa: parsed.nome_empresa || null,
    email: parsed.email || null,
    telefone: parsed.telefone || null,
    nicho: parsed.nicho || null,
    resumo: parsed.resumo || null
  };
}

async function createTrelloCard(lead, url, query) {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const listId = process.env.TRELLO_LIST_ID;

  if (!apiKey || !token || !listId) {
    throw new Error('Credenciais do Trello não configuradas.');
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
    `**Prospectado em:** ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
  ].join('\n');

  const response = await axios.post('https://api.trello.com/1/cards', null, {
    params: { key: apiKey, token, idList: listId, name: cardName, desc, pos: 'bottom' },
    timeout: 10000
  });

  return response.data;
}

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function isBlockedDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return BLOCKED_DOMAINS.some((d) => hostname.includes(d));
  } catch { return false; }
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return url;
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return url; }
}
