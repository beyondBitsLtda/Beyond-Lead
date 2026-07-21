// /api/trello-stats.js
// Puxa todo o board do Trello, categoriza por estágio do funil,
// parseia valores R$, separa faturamento POR MÊS (etiqueta "MÊS DE X")
// e devolve tudo para o dashboard.

import axios from 'axios';

const MONTH_NAMES = [
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
];

const MONTH_SHORT = [
  'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
  'jul', 'ago', 'set', 'out', 'nov', 'dez'
];

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
    const cardsByWeek = {};

    // mapa mestre de meses: key "YYYY-MM" -> { revenue, count, cards[] }
    const monthBuckets = {};

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthKey = ymKey(currentYear, now.getMonth());

    const abordagemHoje = [];
    let revenueTotal = 0;
    let revenueSemMes = 0; // fechados sem etiqueta de mês e sem data

    for (const card of cards) {
      const meta = listStage[card.idList];
      if (!meta) continue;

      const stage = meta.stage;
      if (stage === 'metas') continue;

      const cardLabels = (card.idLabels || [])
        .map((lid) => labelMap[lid])
        .filter((l) => l && l.name);

      cardLabels.forEach((l) => {
        byLabel[l.name] = (byLabel[l.name] || 0) + 1;
      });

      const value = extractValue(card);

      if (funnel[stage]) {
        funnel[stage].count += 1;
        funnel[stage].revenue += value;
      }

      // ===== FATURAMENTO POR MÊS =====
      if (stage === 'fechado' && value > 0) {
        revenueTotal += value;

        const monthKey = resolveMonthKey(card, cardLabels, now);

        if (monthKey) {
          if (!monthBuckets[monthKey]) {
            monthBuckets[monthKey] = { revenue: 0, count: 0, cards: [] };
          }
          const bucket = monthBuckets[monthKey];
          bucket.revenue += value;
          bucket.count += 1;
          bucket.cards.push({
            id: card.id,
            name: card.name,
            value,
            url: card.shortUrl,
            labels: cardLabels.map((l) => l.name),
            items: extractValueItems(card)
          });
        } else {
          revenueSemMes += value;
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
          labels: cardLabels.map((l) => l.name)
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

    // ====== METAS ======
    const metasList = lists.find((l) => classifyStage(l.name) === 'metas');
    let metaSemana = null;
    let metaDefault = 0;          // meta genérica (card "Meta Mensal")
    const metaByMonth = {};       // meta específica por mês (card "Meta Agosto")

    if (metasList) {
      const metasCards = cards.filter((c) => c.idList === metasList.id);

      const metaSemanaCard = metasCards.find((c) => normalize(c.name).includes('semana'));
      if (metaSemanaCard) metaSemana = extractChecklistProgress(metaSemanaCard);

      for (const c of metasCards) {
        if (normalize(c.name).includes('semana')) continue;
        const target = extractValue(c);
        if (target <= 0) continue;

        // Meta com mês no nome ("Meta de Agosto", "Meta Mensal Julho/2026")
        const parsed = parseMonthFromText(c.name);
        if (parsed) {
          const year = parsed.year || inferYear(now, c);
          metaByMonth[ymKey(year, parsed.month)] = target;
        } else {
          metaDefault = target;
        }
      }
    }

    // ====== MONTA A LISTA DE MESES ======
    // garante que o mês atual sempre apareça, mesmo zerado
    if (!monthBuckets[currentMonthKey]) {
      monthBuckets[currentMonthKey] = { revenue: 0, count: 0, cards: [] };
    }
    // garante que meses com meta cadastrada apareçam
    Object.keys(metaByMonth).forEach((k) => {
      if (!monthBuckets[k]) monthBuckets[k] = { revenue: 0, count: 0, cards: [] };
    });

    const months = Object.keys(monthBuckets)
      .sort()
      .map((key) => {
        const b = monthBuckets[key];
        const target = metaByMonth[key] != null ? metaByMonth[key] : metaDefault;
        const [y, m] = key.split('-');
        const monthIdx = parseInt(m, 10) - 1;
        b.cards.sort((a, c) => c.value - a.value);
        return {
          key,
          year: parseInt(y, 10),
          month: monthIdx,
          label: `${MONTH_SHORT[monthIdx]}/${y.slice(2)}`,
          labelLong: `${capitalize(MONTH_NAMES[monthIdx])} de ${y}`,
          revenue: b.revenue,
          count: b.count,
          cards: b.cards,
          target,
          hasOwnTarget: metaByMonth[key] != null,
          pct: target > 0 ? Math.round((b.revenue / target) * 100) : 0,
          isCurrent: key === currentMonthKey
        };
      });

    const currentMonthData = months.find((m) => m.key === currentMonthKey) || null;
    const revenueCurrentYear = months
      .filter((m) => m.year === currentYear)
      .reduce((acc, m) => acc + m.revenue, 0);

    // série do gráfico: últimos 6 meses da linha do tempo (a partir de hoje)
    const monthlyRevenueSeries = buildMonthlySeries(monthBuckets, 6, now);

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
        currentMonthKey,
        currentMonth: currentMonthData ? currentMonthData.revenue : 0,
        currentYear: revenueCurrentYear,
        allTimeFechado: revenueTotal,
        semMes: revenueSemMes,
        monthlySeries: monthlyRevenueSeries
      },

      // NOVO: tudo separado por mês
      months,
      metaDefault,

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
   Helpers — mês
   ============================================================ */

// Descobre o mês do card: 1º etiqueta "MÊS DE X", 2º nome do card, 3º data.
function resolveMonthKey(card, cardLabels, now) {
  for (const l of cardLabels) {
    const parsed = parseMonthFromText(l.name);
    if (parsed) {
      return ymKey(parsed.year || inferYear(now, card), parsed.month);
    }
  }
  const fromName = parseMonthFromText(card.name || '');
  if (fromName) {
    return ymKey(fromName.year || inferYear(now, card), fromName.month);
  }
  if (card.dateLastActivity) {
    const d = new Date(card.dateLastActivity);
    return ymKey(d.getFullYear(), d.getMonth());
  }
  return null;
}

// Aceita "MÊS DE JULHO", "julho", "Meta Agosto/2026", "mes 08/2026"
function parseMonthFromText(text) {
  const n = normalize(text);
  if (!n) return null;

  const yearMatch = n.match(/(20\d{2})/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  for (let i = 0; i < MONTH_NAMES.length; i++) {
    const re = new RegExp(`\\b${MONTH_NAMES[i]}\\b`);
    if (re.test(n)) return { month: i, year };
  }
  // formato "mes 08" / "mes 08/2026"
  const numeric = n.match(/\bmes\D{0,4}(0?[1-9]|1[0-2])\b/);
  if (numeric) return { month: parseInt(numeric[1], 10) - 1, year };

  return null;
}

// Sem ano explícito na etiqueta: usa o ano da última atividade do card.
function inferYear(now, card) {
  if (card && card.dateLastActivity) {
    return new Date(card.dateLastActivity).getFullYear();
  }
  return now.getFullYear();
}

function ymKey(year, monthIdx) {
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
}

function capitalize(w) { return w ? w[0].toUpperCase() + w.slice(1) : ''; }

/* ============================================================
   Helpers — geral
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

const MONEY_SOURCE = 'R\\$\\s*([\\d.]+(?:,\\d{2})?)';

function parseMoney(raw) {
  const num = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
  return (!isNaN(num) && num > 0 && num < 10000000) ? num : 0;
}

function extractValue(card) {
  const texts = [card.name || '', card.desc || ''];
  (card.checklists || []).forEach((cl) => {
    (cl.checkItems || []).forEach((ci) => texts.push(ci.name || ''));
  });
  const combined = texts.join(' \n ');

  const regex = new RegExp(MONEY_SOURCE, 'gi');
  let total = 0;
  let match;
  while ((match = regex.exec(combined)) !== null) {
    total += parseMoney(match[1]);
  }
  return total;
}

// Detalha de onde veio cada valor (pra mostrar no painel do mês)
function extractValueItems(card) {
  const out = [];
  const push = (label, text) => {
    const regex = new RegExp(MONEY_SOURCE, 'gi');
    let m;
    while ((m = regex.exec(text || '')) !== null) {
      const v = parseMoney(m[1]);
      if (v > 0) out.push({ label: (label || '').trim().slice(0, 90), value: v });
    }
  };
  (card.checklists || []).forEach((cl) => {
    (cl.checkItems || []).forEach((ci) => push(ci.name, ci.name));
  });
  if (out.length === 0) {
    push(card.name, `${card.name || ''} \n ${card.desc || ''}`);
  }
  return out;
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

function buildMonthlySeries(buckets, n, now) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = ymKey(d.getFullYear(), d.getMonth());
    out.push({
      key,
      label: MONTH_SHORT[d.getMonth()],
      value: buckets[key] ? buckets[key].revenue : 0
    });
  }
  return out;
}
