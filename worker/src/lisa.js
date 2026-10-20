// /worker/src/lisa.js
// A Lisa na prospecção: conversa, busca empresas, olha o funil e o CRM, lê o site de um lead
// e PROPÕE leads e templates. Ela não cria card.
//
// Por que só propor: o card nasce pelo mesmo caminho da prospecção manual (/api/process-lead,
// com dedup e enriquecimento), disparado por uma pessoa num botão. Os dados do card vêm do
// resultado da busca, guardado aqui no servidor — nunca do texto do modelo. Assim a Lisa não
// consegue inventar telefone, site ou empresa, e nada entra no CRM sem alguém conferir.

import { conversar, textoDe, chamadasDe, temModelo } from './gemini.js';
import { search } from './search.js';
import { funilStats } from './funil.js';
import { abacato, urlDoCard } from './abacato.js';
import { scrapeSite } from './process-lead.js';

const MAXIMO_DE_RODADAS = 6;
// Idas ao Gemini somadas em todas as rodadas de um pedido. O Worker aceita 50 chamadas de rede
// por pedido, e as ferramentas (Serper, Abacato, sites) precisam da sobra.
const TENTATIVAS_DO_MODELO_POR_PEDIDO = 30;
// Tempo máximo de um pedido. Sem teto, um modelo pendurado em várias rodadas deixava a tela em
// "Pensando…" por minutos; passado o prazo, a Lisa devolve o que já tiver (leads propostos).
const PRAZO_DO_PEDIDO_MS = 70000;
// Com menos que isto de prazo, a rodada seguinte é a última: sem ferramentas, só a resposta.
const FOLGA_PARA_RESPONDER_MS = 25000;
// Limite de saída de cada rodada. Nos modelos Gemini 3 o pensamento sai deste mesmo limite.
const TOKENS_DE_RESPOSTA = 8192;
const MEMORIA = 16;
// Pedido detalhado não é problema: a última mensagem da pessoa entra quase inteira; as antigas,
// cortadas.
const TAMANHO_DA_PERGUNTA = 12000;
const TAMANHO_DO_HISTORICO = 4000;
const MAX_LEADS_EM_TELA = 40;

const INSTRUCOES = `Você é a Lisa, a assistente da Beyond Bits, aqui na área de prospecção do Beyond-Lead.
A Beyond Bits faz sites e sistemas sob medida. Você ajuda a equipe comercial a achar empresas, escolher quem abordar e escrever a abordagem.

Você fala português do Brasil, com frases curtas e diretas. Nada de "claro!", "com certeza!" nem emoji. Um pouco de ironia seca é bem-vinda; enrolação, não.

SEJA FIEL AO PEDIDO
- Antes de buscar, separe os requisitos do pedido: segmento, cidade/região, quantidade, nota mínima, se precisa de telefone, se precisa ter (ou NÃO ter) site, e qualquer outra condição.
- Pedidos longos e detalhados são normais. Não reclame do tamanho: extraia os requisitos e trabalhe.
- O termo de buscar_empresas é CURTO, como se digita no Google Maps: segmento + cidade ("pet shops em Joinville"). Os outros requisitos vão nos parâmetros (nota_minima, exige_telefone, exige_site, sem_site, limite), nunca no termo.
- Se a busca não trouxer o suficiente, tente de novo uma ou duas vezes com variações: sinônimo do segmento, bairro ou cidade vizinha.
- Requisito que nenhuma ferramenta confere (ex.: "que atenda convênio") você não garante: diga que não dá para confirmar só pela busca.
- Ao terminar, confira requisito por requisito. Se algum não foi atendido, diga claramente qual e por quê, e proponha os leads mais próximos do pedido original (a busca devolve em "mais_proximos" o que faltou em cada um). Nunca diga que atendeu algo que não atendeu, e nunca termine sem resposta.
- A busca traz no máximo 20 empresas por termo. Se pedirem mais, faça mais de uma busca ou explique o limite.

COMO VOCÊ TRABALHA
- Use as ferramentas em vez de adivinhar. Empresa, telefone, site e nota só existem se vieram de buscar_empresas. Nunca invente dados.
- Você NÃO cria cards. Para sugerir leads, chame propor_leads com os ids da busca: eles aparecem na tela com caixas de seleção e a pessoa decide se cria no CRM. Diga isso quando propuser.
- Ao propor, explique em uma linha o critério (nota, se tem site, se tem telefone, se o site parece desatualizado). Quem não tem site é um ótimo alvo para quem vende site.
- Antes de propor algo que talvez já esteja no CRM, use procurar_no_crm. O botão também confere duplicados, mas avisar antes poupa tempo.
- Para montar uma abordagem específica, leia o site com ler_site e cite algo concreto da empresa.
- Mensagens de WhatsApp: curtas, pessoais, sem cara de spam, terminando com uma pergunta simples. O envio é sempre manual, pela pessoa.
- Para salvar uma mensagem reutilizável, chame propor_template. A única variável que a tela preenche é {{nome_empresa}}; não use outras.
- Para perguntas sobre metas, faturamento ou como está o funil, use ver_funil.
- Depois de agir, diga em uma ou duas frases o que fez. Não repita listas inteiras que já aparecem na tela.

O QUE VOCÊ NÃO FAZ
- Não move, edita, arquiva nem apaga cards. Isso é feito no Abacato.
- Não pede nem guarda dados pessoais sensíveis (CPF, dados bancários, saúde).
- Se a pergunta não for sobre prospecção, responda normalmente e com brevidade.`;

const FERRAMENTAS = [
  {
    name: 'buscar_empresas',
    description: 'Busca empresas no Google Maps (Serper). Devolve em "leads" as que atendem a todos os filtros e, se não forem suficientes, em "mais_proximos" as que chegaram perto, com o que faltou em cada uma.',
    parameters: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Curto: segmento + cidade, como no Google Maps. Ex.: "clínicas odontológicas em Curitiba". Filtros NÃO vão aqui.' },
        limite: { type: 'integer', description: 'Quantos leads a pessoa quer, de 1 a 20. Padrão 10.' },
        nota_minima: { type: 'number', description: 'Descarta empresas com nota abaixo disto (0 a 5).' },
        exige_telefone: { type: 'boolean', description: 'Só empresas com telefone.' },
        exige_site: { type: 'boolean', description: 'Só empresas com site.' },
        sem_site: { type: 'boolean', description: 'Só empresas SEM site (bons alvos para vender site).' }
      },
      required: ['termo']
    }
  },
  {
    name: 'propor_leads',
    description: 'Coloca leads na tela como propostas, com caixas de seleção, para a pessoa decidir se cria no CRM. Use os ids devolvidos por buscar_empresas ou os que já estão na tela.',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Ids dos leads a propor.' },
        observacao: { type: 'string', description: 'Critério da escolha, em uma linha.' }
      },
      required: ['ids']
    }
  },
  {
    name: 'ver_funil',
    description: 'Resumo do funil do CRM: quantos leads por etapa, conversão, faturamento do mês contra a meta, meta da semana e quem está em "Abordagem HOJE".',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'procurar_no_crm',
    description: 'Procura cards no quadro do CRM pelo nome da empresa ou por um trecho da descrição (telefone, site). Serve para saber se um lead já existe e em que etapa está.',
    parameters: {
      type: 'object',
      properties: { termo: { type: 'string', description: 'Nome, site ou telefone a procurar.' } },
      required: ['termo']
    }
  },
  {
    name: 'ler_site',
    description: 'Lê o texto visível do site de uma empresa (até 3000 caracteres), para entender o que ela faz e montar uma abordagem.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Endereço do site, com http:// ou https://.' } },
      required: ['url']
    }
  },
  {
    name: 'propor_template',
    description: 'Propõe um template de mensagem de WhatsApp para a pessoa salvar na lista de templates. Use {{nome_empresa}} onde entra o nome da empresa.',
    parameters: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome curto do template. Ex.: "Abordagem clínicas sem site".' },
        texto: { type: 'string', description: 'A mensagem.' }
      },
      required: ['nome', 'texto']
    }
  }
];

const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/** O lead como a Lisa enxerga: o mínimo para decidir, sem o endereço completo. */
function resumoDoLead(id, item) {
  const p = item.place || {};
  return {
    id,
    nome: p.nome,
    categoria: p.categoria || null,
    nota: p.rating || null,
    avaliacoes: p.reviews || null,
    tem_telefone: Boolean(p.telefone),
    site: p.site ? p.site.replace(/^https?:\/\//, '').replace(/\/$/, '') : null,
    cidade: p.endereco ? p.endereco.split(',').slice(-2).join(',').trim() : null
  };
}

const idDoLead = (item, i) => item?.place?.placeId || `lead-${i}`;

/** O que falta num lead para atender aos filtros da busca (vazio = atende a tudo). */
function faltasDo(item, filtros) {
  const p = item.place || {};
  const faltou = [];
  if (filtros.exige_telefone && !p.telefone) faltou.push('sem telefone');
  if (filtros.exige_site && !p.site) faltou.push('sem site');
  if (filtros.sem_site && p.site) faltou.push('já tem site');
  if (filtros.nota_minima > 0 && (!p.rating || p.rating < filtros.nota_minima)) {
    faltou.push(p.rating ? `nota ${p.rating}, abaixo de ${filtros.nota_minima}` : 'sem nota');
  }
  return faltou;
}

/** Um termo de busca tirado do próprio pedido, para quando o modelo não respondeu. */
function termoDoPedido(texto) {
  // Corta na primeira frase; o ponto de "nota 4.7" não é fim de frase.
  const linha = String(texto || '').split(/[\n!?]|\.(?=\s|$)/).map((t) => t.trim()).find((t) => t.length >= 3) || '';
  const curto = linha.replace(/\s+/g, ' ').slice(0, 100);
  return curto.length < linha.length ? curto.replace(/\s+\S*$/, '') : curto;
}

/** Uma conversa: o estado vive só durante o pedido. O que a tela precisa lembrar volta
 *  para ela em `propostas` e ela devolve em `contexto.leadsEmTela` no próximo pedido. */
function criarSessao(contexto) {
  const leads = new Map();
  const emTela = Array.isArray(contexto?.leadsEmTela) ? contexto.leadsEmTela.slice(0, MAX_LEADS_EM_TELA) : [];
  emTela.forEach((item, i) => {
    if (item?.place?.nome) leads.set(idDoLead(item, `tela-${i}`), item);
  });
  // buscas: termos já buscados; faltas: id → o que faltou (só para leads que vieram de busca).
  return { leads, buscas: [], faltas: new Map(), propostas: { leads: [], template: null, observacao: null } };
}

async function executar(nome, args, sessao, env) {
  try {
    switch (nome) {
      case 'buscar_empresas': {
        const termo = String(args.termo || '').trim();
        const quer = Math.min(Math.max(parseInt(args.limite, 10) || 10, 1), 20);
        // Busca sempre o máximo: os filtros cortam depois, e quem não passa serve de "mais próximo".
        const { status, data } = await search({ query: termo, limit: 20 }, env);
        if (status !== 200) return { erro: data.error || 'a busca falhou' };
        const itens = data.results || [];
        sessao.buscas.push(termo);
        const atendem = [];
        const quase = [];
        itens.forEach((it, i) => {
          const id = idDoLead(it, `${sessao.buscas.length}-${i}`);
          const faltou = faltasDo(it, args);
          it.termo = termo; // vai para o card como "Termo de busca"
          sessao.leads.set(id, it);
          sessao.faltas.set(id, faltou);
          if (faltou.length) quase.push({ ...resumoDoLead(id, it), faltou });
          else atendem.push(resumoDoLead(id, it));
        });
        quase.sort((x, y) => x.faltou.length - y.faltou.length || (y.nota || 0) - (x.nota || 0));
        const leads = atendem.slice(0, quer);
        return {
          pedidos: quer,
          encontrados: itens.length,
          atendem_a_todos_os_filtros: atendem.length,
          leads,
          ...(leads.length < quer && quase.length
            ? { mais_proximos: quase.slice(0, quer - leads.length) }
            : {}),
          ...(itens.length ? {} : {
            dica: 'Nenhum resultado. Tente um termo mais curto e comum (segmento + cidade), um sinônimo ou uma cidade vizinha.'
          })
        };
      }

      case 'propor_leads': {
        const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
        const achados = [];
        const ignorados = [];
        for (const id of ids) {
          const item = sessao.leads.get(id);
          if (!item) { ignorados.push(id); continue; }
          if (!sessao.propostas.leads.includes(item)) sessao.propostas.leads.push(item);
          achados.push(id);
        }
        if (args.observacao) sessao.propostas.observacao = String(args.observacao).slice(0, 300);
        return {
          propostos: achados.length,
          ignorados,
          aviso: ignorados.length ? 'ids ignorados não vieram de uma busca nem estão na tela' : undefined
        };
      }

      case 'ver_funil': {
        const { status, data } = await funilStats({}, env);
        if (status !== 200) return { erro: data.error || 'não consegui ler o funil' };
        const mes = data.months.find((m) => m.isCurrent);
        return {
          etapas: data.totals,
          conversao_pct: data.conversion.rate,
          mes_atual: mes ? { mes: mes.labelLong, faturado: mes.revenue, meta: mes.target, pct_da_meta: mes.pct } : null,
          faturamento_no_ano: data.revenue.currentYear,
          meta_da_semana: data.metaSemana
            ? { feitos: data.metaSemana.done, total: data.metaSemana.total, itens: data.metaSemana.items }
            : null,
          abordagem_hoje: data.abordagemHoje.map((c) => ({ nome: c.name, tem_telefone: Boolean(c.phone) }))
        };
      }

      case 'procurar_no_crm': {
        const termo = normalizar(args.termo);
        if (termo.length < 3) return { erro: 'termo curto demais' };
        const q = await abacato(env, '/quadro');
        const coluna = new Map(q.colunas.map((c) => [c.id, c.nome]));
        const achados = q.cards
          .filter((c) => normalizar(c.titulo).includes(termo) || normalizar(c.descricao).includes(termo))
          .slice(0, 10)
          .map((c) => ({ titulo: c.titulo, etapa: coluna.get(c.colunaId), url: urlDoCard(env, q.quadro.id, c.id) }));
        return { total: achados.length, cards: achados };
      }

      case 'ler_site': {
        const url = String(args.url || '').trim();
        if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(url)) return { erro: 'endereço inválido; use http:// ou https://' };
        const texto = await scrapeSite(url);
        return { url, texto: (texto || '').slice(0, 3000) || '(o site não tem texto legível)' };
      }

      case 'propor_template': {
        const nomeTpl = String(args.nome || '').trim().slice(0, 80);
        const texto = String(args.texto || '').trim().slice(0, 2000);
        if (!nomeTpl || !texto) return { erro: 'template precisa de nome e texto' };
        sessao.propostas.template = { nome: nomeTpl, texto };
        return { proposto: true };
      }

      default:
        return { erro: `ferramenta desconhecida: ${nome}` };
    }
  } catch (e) {
    return { erro: e.message || 'falhou' };
  }
}

/**
 * A resposta quando o modelo não chegou ao fim (falhou, estourou o prazo ou deu voltas demais).
 * Nunca volta de mãos vazias: entrega o que as ferramentas já acharam e, se nada foi buscado,
 * busca direto pelo texto do pedido. Sempre diz o que não conseguiu.
 */
async function respostaDeReserva(sessao, env, pedido, motivo) {
  const propostas = sessao.propostas;
  const porque = motivo ? ` (${motivo})` : '';
  if (propostas.leads.length || propostas.template) {
    return `Deixei as propostas na tela, mas não consegui terminar a resposta${porque}. Confira se elas batem com o pedido antes de criar.`;
  }

  let buscouPeloTexto = null;
  if (!sessao.buscas.length) {
    const termo = termoDoPedido(pedido);
    if (termo.length >= 3) {
      buscouPeloTexto = termo;
      const busca = await executar('buscar_empresas', { termo, limite: 20 }, sessao, env);
      if (busca.erro) {
        return `Não consegui atender ao pedido${porque}, e a busca de empresas também falhou (${busca.erro}). Tente de novo em instantes.`;
      }
    }
  }

  const candidatos = [...sessao.leads.entries()]
    .filter(([id]) => sessao.faltas.has(id))
    .sort(([a, x], [b, y]) => sessao.faltas.get(a).length - sessao.faltas.get(b).length
      || (y.place?.rating || 0) - (x.place?.rating || 0))
    .slice(0, 10);
  if (!candidatos.length) {
    const onde = sessao.buscas.length ? ` buscando por "${sessao.buscas.join('", "')}"` : '';
    return `Não consegui atender ao pedido${porque} e não achei nenhuma empresa${onde}. Tente de novo com segmento e cidade, por exemplo "pet shops em Joinville".`;
  }

  propostas.leads = candidatos.map(([, it]) => it);
  const incompletos = candidatos.filter(([id]) => sessao.faltas.get(id).length);
  const faltas = [...new Set(incompletos.flatMap(([id]) => sessao.faltas.get(id)))].slice(0, 3).join('; ');
  propostas.observacao = incompletos.length
    ? `Mais próximos do pedido. ${incompletos.length} de ${candidatos.length} não atendem a todos os filtros (${faltas}).`
    : 'Resultado da busca, sem a conferência final da Lisa.';

  if (buscouPeloTexto) {
    return `Não consegui analisar o pedido${porque}. Busquei direto por "${buscouPeloTexto}", sem os filtros, e deixei ${candidatos.length} lead(s) na tela. Confira se batem com o que você pediu antes de criar.`;
  }
  return incompletos.length
    ? `Não consegui atender ao pedido por completo${porque}. Deixei na tela os ${candidatos.length} leads mais próximos do que você pediu; ${incompletos.length} deles não atendem a todos os requisitos (${faltas}).`
    : `Não consegui terminar a resposta${porque}, mas deixei na tela ${candidatos.length} lead(s) da busca. Confira se batem com o pedido antes de criar.`;
}

/**
 * POST /api/lisa
 * body: { mensagens: [{ quem: "pessoa"|"lisa", texto }], contexto?: { leadsEmTela: [...] } }
 * Sempre responde: se o modelo não chegar ao fim, entra a respostaDeReserva.
 */
export async function lisa(body, env) {
  if (!temModelo(env)) {
    return { status: 503, data: { error: 'A Lisa não está ligada: falta a chave do Gemini no Worker.' } };
  }

  const mensagens = (Array.isArray(body?.mensagens) ? body.mensagens.slice(-MEMORIA) : [])
    .filter((m) => m && typeof m.texto === 'string' && m.texto.trim());
  const contents = mensagens.map((m, i) => ({
    role: m.quem === 'lisa' ? 'model' : 'user',
    parts: [{ text: m.texto.slice(0, i === mensagens.length - 1 ? TAMANHO_DA_PERGUNTA : TAMANHO_DO_HISTORICO) }]
  }));
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    return { status: 400, data: { error: 'Não veio pergunta nenhuma.' } };
  }
  const pedido = mensagens[mensagens.length - 1].texto;

  const sessao = criarSessao(body.contexto);
  const usadas = [];
  let modelo = null;
  const responder = (texto) => ({
    status: 200,
    data: { ok: true, texto, propostas: sessao.propostas, ferramentas: usadas, modelo }
  });

  try {
    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const naTela = [...sessao.leads.entries()].map(([id, it]) => resumoDoLead(id, it));
    const sistema = `${INSTRUCOES}\n\nHoje é ${hoje}.` +
      (naTela.length ? `\n\nLeads que já estão na tela da pessoa (use estes ids se ela se referir a eles):\n${JSON.stringify(naTela)}` : '');

    const orcamento = { restantes: TENTATIVAS_DO_MODELO_POR_PEDIDO, prazo: Date.now() + PRAZO_DO_PEDIDO_MS };
    for (let rodada = 0; rodada < MAXIMO_DE_RODADAS; rodada++) {
      // Última rodada (pelo número ou pelo relógio): ferramentas desligadas, o modelo só responde.
      const ultima = rodada === MAXIMO_DE_RODADAS - 1
        || (rodada > 0 && orcamento.prazo - Date.now() < FOLGA_PARA_RESPONDER_MS);
      let resposta;
      try {
        resposta = await conversar(env, {
          contents, sistema, ferramentas: FERRAMENTAS, semFerramentas: ultima,
          maxTokens: TOKENS_DE_RESPOSTA, orcamento
        });
        modelo = resposta.modelo;
      } catch (e) {
        return responder(await respostaDeReserva(sessao, env, pedido, e.message));
      }

      const chamadas = ultima ? [] : chamadasDe(resposta);
      if (!chamadas.length) {
        const texto = textoDe(resposta);
        if (texto) return responder(texto);
        return responder(await respostaDeReserva(sessao, env, pedido, 'o modelo não escreveu a resposta'));
      }

      // A resposta com as chamadas volta ao histórico ANTES dos resultados; sem ela, a rodada
      // seguinte recebe resultados de funções que, para o modelo, ninguém pediu.
      contents.push({ role: 'model', parts: resposta.parts });
      const resultados = [];
      for (const chamada of chamadas) {
        usadas.push(chamada.nome);
        const resultado = await executar(chamada.nome, chamada.args, sessao, env);
        resultados.push({ functionResponse: { name: chamada.nome, response: resultado } });
      }
      contents.push({ role: 'user', parts: resultados });
    }
    return responder(await respostaDeReserva(sessao, env, pedido, 'dei voltas demais neste pedido'));
  } catch (e) {
    // Rede de segurança: qualquer falha inesperada ainda vira resposta com o que já foi achado.
    console.error('[lisa] erro:', e.message);
    try {
      return responder(await respostaDeReserva(sessao, env, pedido, 'tive um erro interno'));
    } catch {
      return responder('Tive um erro interno e não consegui atender a este pedido. Tente de novo em instantes.');
    }
  }
}
