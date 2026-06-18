// /api/search.js
// Recebe um termo de busca e devolve até 10 URLs via Serper.dev (proxy do Google).
// Substitui a antiga Google Custom Search API (fechada para novos clientes).

import axios from 'axios';

export default async function handler(req, res) {
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

  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'Variável SERPER_API_KEY não configurada.'
    });
  }

  try {
    const response = await axios.post(
      'https://google.serper.dev/search',
      {
        q: query.trim(),
        gl: 'br',         // Brasil
        hl: 'pt-br',      // Português do Brasil
        num: 10
      },
      {
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const organic = response.data?.organic || [];

    // Normaliza saída no mesmo formato que o frontend já espera
    const results = organic.slice(0, 10).map((item) => ({
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
      error.response?.data?.message ||
      error.message ||
      'Erro desconhecido ao consultar Serper.';

    console.error('[/api/search] erro:', apiError);

    return res.status(502).json({
      success: false,
      error: 'Falha ao consultar a Serper Search.',
      details: apiError
    });
  }
}
