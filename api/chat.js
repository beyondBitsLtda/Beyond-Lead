// /api/chat.js
// Chat com o Gemini para estratégias de prospecção.
// Recebe uma mensagem do usuário (e opcionalmente o histórico da conversa)
// e responde com sugestões estratégicas.

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

    // Monta o histórico no formato do Gemini
    const contents = [];

    // Primeira "instrução" como mensagem do usuário (Gemini Flash não suporta system role direto)
    contents.push({
      role: 'user',
      parts: [{ text: SYSTEM_PROMPT }]
    });
    contents.push({
      role: 'model',
      parts: [{ text: 'Entendido. Estou pronto para te ajudar com estratégias de prospecção. Em que posso ajudar?' }]
    });

    // Histórico da conversa
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

    // Mensagem atual
    contents.push({
      role: 'user',
      parts: [{ text: message.trim() }]
    });

    const response = await axios.post(
      endpoint,
      {
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1500
        }
      },
      {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const reply =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      'Desculpe, não consegui gerar uma resposta. Tente novamente.';

    return res.status(200).json({
      success: true,
      reply
    });
  } catch (error) {
    const apiError =
      error.response?.data?.error?.message || error.message || 'Erro desconhecido.';
    console.error('[/api/chat] erro:', apiError);

    return res.status(502).json({
      success: false,
      error: 'Falha ao consultar o Gemini.',
      details: apiError
    });
  }
}
