// /worker/src/search.js
// Busca no Google Maps via Serper Places API.

export async function search(body, env) {
  const { query, limit } = body || {};

  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    return {
      status: 400,
      data: { error: 'Parâmetro "query" é obrigatório e deve ter no mínimo 3 caracteres.' }
    };
  }

  const maxResults = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);

  const apiKey = env.SERPER_API_KEY;
  if (!apiKey) {
    return { status: 500, data: { error: 'SERPER_API_KEY não configurada.' } };
  }

  try {
    const response = await fetch('https://google.serper.dev/places', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query.trim(), gl: 'br', hl: 'pt-br' }),
      signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);

    const places = payload.places || [];
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

    return {
      status: 200,
      data: {
        success: true,
        query: query.trim(),
        total: results.length,
        results
      }
    };
  } catch (error) {
    const apiError = error.message || 'Erro desconhecido.';
    console.error('[/api/search] erro:', apiError);
    return {
      status: 502,
      data: {
        success: false,
        error: 'Falha ao consultar a Serper Places.',
        details: apiError
      }
    };
  }
}
