// /api/chat.js
// Chat com o Gemini para estratégias de prospecção.

import axios from 'axios';

const SYSTEM_PROMPT = `Você é um consultor especialista em prospecção comercial B2B e B2C.
Sua função é ajudar o usuário a montar estratégias de abordagem para os leads que ele prospectou.

Você é objetivo, prático e direto. Suas respostas:
- Sempre em português do Brasil
- Focadas em ação prática, não teoria
- Quando o usuário compartilha dados de um lead, você sugere abordagens específicas para aquele negócio
- Quando o usuário pede ideias gerais, você dá frameworks aplicáveis
- Você sugere canais (WhatsApp, e-mail, ligação, Instagram) baseado no perfil do lead
- Você ajuda a redigir mensagens quando solicitado
- Você considera o contexto brasileiro: cultura, formalidade, horários

Evite respostas longas demais. Prefira tópicos e exemplos curtos.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { message, history } = req.body || {};

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Mensagem obrigatória.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY não configurada.' });
  }

  try {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    // Histórico + mensagem atual
    const contents = [];

    if (Array.isArray(history)) {
      history.forEach((msg) => {
        if (msg.role && msg.text) {
          contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.text }]
          });
        }
      });
    }

    contents.push({
      role: 'user',
      parts: [{ text: message.trim() }]
    });

    // Payload no formato correto do Gemini 1.5
    const payload = {
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1500
      }
    };

    const response = await axios.post(endpoint, payload, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });

    const reply =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      'Desculpe, não consegui gerar uma resposta. Tente novamente.';

    return res.status(200).json({
      success: true,
      reply
    });
  } catch (error) {
    // Captura o erro detalhado do Gemini
    const apiError =
      error.response?.data?.error?.message ||
      error.response?.data?.error ||
      error.message ||
      'Erro desconhecido.';

    console.error('[/api/chat] erro:', JSON.stringify(error.response?.data || error.message));

    return res.status(502).json({
      success: false,
      error: 'Falha ao consultar o Gemini.',
      details: typeof apiError === 'string' ? apiError : JSON.stringify(apiError)
    });
  }
}
