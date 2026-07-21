// /api/search.js
// Busca no Google Maps via Serper Places API.

import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { query, limit } = req.body || {};

  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    return res.status(400).json({
      error: 'Parâmetro "query" é obrigatório e deve ter no mínimo 3 caracteres.'
    });
  }

  const maxResults = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'SERPER_API_KEY não configurada.' });
  }

  try {
    const response = await axios.post(
      'https://google.serper.dev/places',
      { q: query.trim(), gl: 'br', hl: 'pt-br' },
      {
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );

    const places = response.data?.places || [];
    const results = places.slice(0, maxResults).map((p) => ({
      title: p.title,
      link: p.website || (p.placeId
        ? `https://www.google.com/maps/place/?q=place_id:${p.placeId}`
        : ''),
      snippet: p.address || '',
      place: {
        nome: p.title,
        endereco: p.address || null,
        telefone: p.phoneNumber || null,
        site: p.website || null,
        categoria: p.category || null,
        rating: p.rating || null,
        reviews: p.ratingCount || null,
        latitude: p.latitude || null,
        longitude: p.longitude || null,
        placeId: p.placeId || null
      }
    }));

    return res.status(200).json({
      success: true,
      query: query.trim(),
      total: results.length,
      results
    });
  } catch (error) {
    const apiError = error.response?.data?.message || error.message || 'Erro desconhecido.';
    console.error('[/api/search] erro:', apiError);
    return res.status(502).json({
      success: false,
      error: 'Falha ao consultar a Serper Places.',
      details: apiError
    });
  }
}
