// /api/trello-stats.js
// Puxa todo o board do Trello, categoriza por estágio do funil,
// parseia valores R$, monta séries temporais e devolve tudo para o dashboard.

import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método não permitido. Use GET.' });
  }

  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const boardId = process.env.TRELLO_BOARD_ID;

  if (!apiKey || !token || !boardId) {
    return res.status(500).json({
      error: 'Faltando TRELLO_API_KEY, TRELLO_TOKEN ou TRELLO_BOARD_ID.'
    });
  }

  try {
    const url = `https://api.trello.com/1/boards/${boardId}`;
    const { data } = await axios.get(url, {
      params: {
        key: apiKey,
        token,
        lists: 'open',
        list_fields: 'name,pos',
        cards: 'open',
        card_fields: 'name,desc,idList,idLabels,shortUrl,dateLastActivity,due',
        card_checklists: 'all',
        checklist_fields: 'name',
        labels: 'all',
        label_fields: 'name,color'
      },
      timeout: 20000
    });

    const lists = data.lists || [];
    const cards = data.cards || [];
    const labels = data.labels || [];

    const labelMap = {};
    labels.forEach((l) => { labelMap[l.id] = { name: l.name, color: l.color }; });

    const listStage = {};
    lists.forEach((l) => {
      listStage[l.id] = { name: l.name, stage: classifyStage(l.name) };
    });

    const STAGES = ['alvos', 'abordagem', 'diagnostico', 'proposta', 'fechado', 'perdido', 'followup', 'tickets'];
    const funnel = {};
    STAGES.forEach((s) => { funnel[s] = { count: 0, revenue: 0, cards: [] }; });

    const byLabel = {};
    const revenueByMonth = {};
    const cardsByWeek = {};

    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const currentYear = now.getFullYear();

    let revenueCurrentMonth = 0;
    let revenueCurrentYear = 0;

    const abordagemHoje = [];

    for (const card of cards) {
      const meta = listStage[card.idList];
      if (!meta) continue;

      const stage = meta.stage;
      if (stage === 'metas') continue;

      (card.idLabels || []).forEach((lid) => {
        const l = labelMap[lid];
        if (!l || !l.name) return;
        byLabel[l.name] = (byLabel[l.name] || 0) + 1;
      });

      const value = extractValue(card);

      if (funnel[stage]) {
        funnel[stage].count += 1;
        funnel[stage].revenue += value;
      }

      if (stage === 'fechado' && value > 0) {
        const activityDate = card.dateLastActivity ? new Date(card.dateLastActivity) : null;
        if (activityDate) {
          const monthKey = `${activityDate.getFullYear()}-${String(activityDate.getMonth() + 1).padStart(2, '0')}`;
          revenueByMonth[monthKey] = (revenueByMonth[monthKey] || 0) + value;
          if (monthKey === currentMonthKey) revenueCurrentMonth += value;
          if (activityDate.getFullYear() === currentYear) revenueCurrentYear += value;
        } else {
          revenueCurrentYear += value;
        }
      }

      if (card.dateLastActivity) {
        const wk = weekKey(new Date(card.dateLastActivity));
        cardsByWeek[wk] = (cardsByWeek[wk] || 0) + 1;
      }

      if (stage === 'abordagem') {
        abordagemHoje.push({
          id: card.id,
          name: card.name,
          url: card.shortUrl,
          phone: extractPhone(card.desc || ''),
          labels: (card.idLabels || []).map((lid) => labelMap[lid]?.name).filter(Boolean)
        });
      }
    }

    const totalAlvos = funnel.alvos.count;
    const totalAbordagem = funnel.abordagem.count;
    const totalDiagnostico = funnel.diagnostico.count;
    const totalProposta = funnel.proposta.count;
    const totalFechado = funnel.fechado.count;
    const totalPerdido = funnel.perdido.count;

    const totalEmFunil = totalAlvos + totalAbordagem + totalDiagnostico + totalProposta;
    const totalEncerrados = totalFechado + totalPerdido;
    const conversionRate = totalEncerrados > 0
      ? (totalFechado / totalEncerrados) * 100
      : 0;

    const weeklySeries = buildWeeklySeries(cardsByWeek, 8);
    const monthlyRevenueSeries = buildMonthlySeries(revenueByMonth, 6);

    const metasList = lists.find((l) => classifyStage(l.name) === 'metas');
    let metaSemana = null;
    if (metasList) {
      const metaCard = cards.find(
        (c) => c.idList === metasList.id && normalize(c.name).includes('semana')
      );
      if (metaCard) metaSemana = extractChecklistProgress(metaCard);
    }

    return res.status(200).json({
      success: true,
      updatedAt: now.toISOString(),

      totals: {
        emFunil: totalEmFunil,
        alvos: totalAlvos,
        abordagem: totalAbordagem,
        diagnostico: totalDiagnostico,
        proposta: totalProposta,
        fechado: totalFechado,
        perdido: totalPerdido,
        followup: funnel.followup.count,
        tickets: funnel.tickets.count
      },

      revenue: {
        currentMonth: revenueCurrentMonth,
        currentYear: revenueCurrentYear,
        allTimeFechado: funnel.fechado.revenue,
        monthlySeries: monthlyRevenueSeries
      },

      conversion: {
        rate: Math.round(conversionRate * 10) / 10,
        won: totalFechado,
        lost: totalPerdido
      },

      byLabel,
      weeklySeries,
      abordagemHoje,
      metaSemana,

      lists: lists.map((l) => ({
        id: l.id, name: l.name, stage: listStage[l.id].stage
      }))
    });
  } catch (error) {
    console.error('[/api/trello-stats] erro:', error.message);
    return res.status(502).json({
      success: false,
      error: 'Falha ao consultar o Trello.',
      details: error.response?.data || error.message
    });
  }
}

/* ============================================================
   Helpers
   ============================================================ */
function classifyStage(name) {
  const n = normalize(name);
  if (n.includes('meta')) return 'metas';
  if (n.includes('alvo') || n.includes('backlog')) return 'alvos';
  if (n.includes('abordagem') || n.includes('hoje')) return 'abordagem';
  if (n.includes('followup') || n.includes('follow')) return 'followup';
  if (n.includes('diagnostico') || n.includes('respondera')) return 'diagnostico';
  if (n.includes('proposta')) return 'proposta';
  if (n.includes('fechado') || n.includes('faturamento')) return 'fechado';
  if (n.includes('perdido') || n.includes('geladeira')) return 'perdido';
  if (n.includes('ticke')) return 'tickets';
  return 'outros';
}

function normalize(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function extractValue(card) {
  const texts = [card.name || '', card.desc || ''];
  (card.checklists || []).forEach((cl) => {
    (cl.checkItems || []).forEach((ci) => texts.push(ci.name || ''));
  });
  const combined = texts.join(' \n ');

  const regex = /R\$\s*([\d.]+(?:,\d{2})?)/gi;
  let total = 0;
  let match;
  while ((match = regex.exec(combined)) !== null) {
    const raw = match[1].replace(/\./g, '').replace(',', '.');
    const num = parseFloat(raw);
    if (!isNaN(num) && num > 0 && num < 10000000) total += num;
  }
  return total;
}

function extractPhone(desc) {
  const match = desc.match(/(?:Telefone|WhatsApp|Tel)[^0-9]*(\+?\d[\d\s().-]{8,})/i);
  if (match) return match[1].trim();
  const generic = desc.match(/\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}/);
  return generic ? generic[0] : null;
}

function extractChecklistProgress(card) {
  const checklists = card.checklists || [];
  let done = 0, total = 0;
  const items = [];
  checklists.forEach((cl) => {
    (cl.checkItems || []).forEach((ci) => {
      total += 1;
      if (ci.state === 'complete') done += 1;
      items.push({ name: ci.name, done: ci.state === 'complete' });
    });
  });
  return { name: card.name, done, total, items };
}

function weekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function buildWeeklySeries(map, n) {
  const now = new Date();
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    keys.push(weekKey(d));
  }
  return keys.map((k) => ({ label: k.slice(5), value: map[k] || 0 }));
}

function buildMonthlySeries(map, n) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
    out.push({ label, value: map[key] || 0 });
  }
  return out;
}
