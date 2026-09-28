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
const MEMORIA = 16;
const MAX_LEADS_EM_TELA = 40;

const INSTRUCOES = `Você é a Lisa, a assistente da Beyond Bits, aqui na área de prospecção do Beyond-Lead.
A Beyond Bits faz sites e sistemas sob medida. Você ajuda a equipe comercial a achar empresas, escolher quem abordar e escrever a abordagem.

Você fala português do Brasil, com frases curtas e diretas. Nada de "claro!", "com certeza!" nem emoji. Um pouco de ironia seca é bem-vinda; enrolação, não.

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
    description: 'Busca empresas no Google Maps (Serper). Devolve uma lista resumida com id, nome, categoria, nota, se tem telefone e site.',
    parameters: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'O que buscar e onde. Ex.: "clínicas odontológicas em Curitiba".' },
        limite: { type: 'integer', description: 'Quantos resultados buscar, de 1 a 20. Padrão 10.' },
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

/** Uma conversa: o estado vive só durante o pedido. O que a tela precisa lembrar volta
 *  para ela em `propostas` e ela devolve em `contexto.leadsEmTela` no próximo pedido. */
function criarSessao(contexto) {
  const leads = new Map();
  const emTela = Array.isArray(contexto?.leadsEmTela) ? contexto.leadsEmTela.slice(0, MAX_LEADS_EM_TELA) : [];
  emTela.forEach((item, i) => {
    if (item?.place?.nome) leads.set(idDoLead(item, `tela-${i}`), item);
  });
  return { leads, propostas: { leads: [], template: null, observacao: null } };
}

async function executar(nome, args, sessao, env) {
  try {
    switch (nome) {
      case 'buscar_empresas': {
        const { status, data } = await search({ query: args.termo, limit: args.limite || 10 }, env);
        if (status !== 200) return { erro: data.error || 'a busca falhou' };
        let itens = data.results || [];
        const total = itens.length;
        itens = itens.filter((it) => {
          const p = it.place || {};
          if (args.exige_telefone && !p.telefone) return false;
          if (args.exige_site && !p.site) return false;
          if (args.sem_site && p.site) return false;
          if (args.nota_minima > 0 && (!p.rating || p.rating < args.nota_minima)) return false;
          return true;
        });
        const base = sessao.leads.size;
        const resumo = itens.map((it, i) => {
          const id = idDoLead(it, base + i);
          it.termo = args.termo; // vai para o card como "Termo de busca"
          sessao.leads.set(id, it);
          return resumoDoLead(id, it);
        });
        return { encontrados: total, depois_dos_filtros: resumo.length, leads: resumo };
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
 * POST /api/lisa
 * body: { mensagens: [{ quem: "pessoa"|"lisa", texto }], contexto?: { leadsEmTela: [...] } }
 */
export async function lisa(body, env) {
  if (!temModelo(env)) {
    return { status: 503, data: { error: 'A Lisa não está ligada: falta a chave do Gemini no Worker.' } };
  }

  const mensagens = Array.isArray(body?.mensagens) ? body.mensagens.slice(-MEMORIA) : [];
  const contents = mensagens
    .filter((m) => m && typeof m.texto === 'string' && m.texto.trim())
    .map((m) => ({ role: m.quem === 'lisa' ? 'model' : 'user', parts: [{ text: m.texto.slice(0, 4000) }] }));
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    return { status: 400, data: { error: 'Não veio pergunta nenhuma.' } };
  }

  const sessao = criarSessao(body.contexto);
  const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const naTela = [...sessao.leads.entries()].map(([id, it]) => resumoDoLead(id, it));
  const sistema = `${INSTRUCOES}\n\nHoje é ${hoje}.` +
    (naTela.length ? `\n\nLeads que já estão na tela da pessoa (use estes ids se ela se referir a eles):\n${JSON.stringify(naTela)}` : '');

  const usadas = [];
  for (let rodada = 0; rodada < MAXIMO_DE_RODADAS; rodada++) {
    let resposta;
    try {
      resposta = await conversar(env, { contents, sistema, ferramentas: FERRAMENTAS, maxTokens: 2048 });
    } catch (e) {
      return { status: 502, data: { error: e.message } };
    }

    const chamadas = chamadasDe(resposta);
    if (!chamadas.length) {
      return {
        status: 200,
        data: {
          ok: true,
          texto: textoDe(resposta) || 'Não consegui formular uma resposta para isso.',
          propostas: sessao.propostas,
          ferramentas: usadas
        }
      };
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

  return {
    status: 200,
    data: {
      ok: true,
      texto: 'Dei voltas demais neste pedido sem chegar a uma resposta. Divida em passos menores.',
      propostas: sessao.propostas,
      ferramentas: usadas
    }
  };
}
