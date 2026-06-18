// /api/search.js
// Recebe um termo de busca e devolve até 10 URLs da Google Custom Search API.
// Roda como Vercel Serverless Function (Node.js).

import axios from 'axios';

export default async function handler(req, res) {
  // Aceita apenas POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { query } = req.body || {};

  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    return res.status(400).json({
      error: 'Parâmetro "query" é obrigatório e deve ter no mínimo 3 caracteres.'
    });
  }

  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;

  if (!apiKey || !cx) {
    return res.status(500).json({
      error: 'Variáveis GOOGLE_SEARCH_API_KEY e/ou GOOGLE_SEARCH_CX não configuradas.'
    });
  }

  try {
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: apiKey,
        cx: cx,
        q: query.trim(),
        num: 10,          // Máximo permitido em uma chamada
        hl: 'pt-BR',      // Idioma de interface
        gl: 'br'          // País de busca (Brasil)
      },
      timeout: 15000
    });

    const items = response.data.items || [];

    // Normaliza saída — só o necessário para a fila do frontend
    const results = items.map((item) => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet || ''
    }));

    return res.status(200).json({
      success: true,
      query: query.trim(),
      total: results.length,
      results
    });
  } catch (error) {
    const apiError =
      error.response?.data?.error?.message ||
      error.message ||
      'Erro desconhecido na Google Custom Search.';

    console.error('[/api/search] erro:', apiError);

    return res.status(502).json({
      success: false,
      error: 'Falha ao consultar a Google Custom Search.',
      details: apiError
    });
  }
}
