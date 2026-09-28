# Prospect Leads — Central de Operação 🎯

Aplicação de prospecção + central de operação de leads.
Prospecta empresas via Google Maps (Serper), cadastra no quadro do **CRM** no Abacato,
lê o funil desse quadro em tempo real e permite enviar WhatsApp direto do dashboard.

## Como está hospedado

| Parte | Onde | Pasta |
|---|---|---|
| Front-end (HTML/CSS/JS estático) | GitHub Pages — `https://beyondbitsltda.github.io/Beyond-Lead/` | raiz do repositório |
| Back-end (`/api/*`) | Cloudflare Workers — `https://beyond-lead-api.beyondbitslisa.workers.dev` | `worker/` |

O GitHub Pages só serve arquivos estáticos, por isso as funções que usam as chaves
(Serper, Gemini, Abacato) rodam no Worker. **As chaves nunca vão para o front-end.**

Não há GitHub Actions: nada depende de acesso às configurações do repositório.

- **Front:** o Pages publica a raiz da `main` ("Deploy from branch"). Basta dar push.
  O arquivo `.nojekyll` impede o GitHub de processar a pasta com Jekyll.
- **API:** publicada daqui da máquina, com o `wrangler` logado na conta **beyondbitsLisa**
  da Cloudflare (a mesma do Abacato):

  ```bash
  npm install            # uma vez: instala o wrangler na pasta do projeto
  npm run api:publicar   # publica worker/ no Cloudflare
  ```

## Chaves da API (secrets do Worker)

Gravadas **uma vez** no Worker, na pasta do projeto. O `wrangler` pede o valor sem mostrar na tela:

```bash
npx wrangler secret put SERPER_API_KEY --config worker/wrangler.toml
npx wrangler secret put GEMINI_API_KEY --config worker/wrangler.toml
npx wrangler secret put ABACATO_TOKEN  --config worker/wrangler.toml
```

| Secret | Descrição |
|---|---|
| `SERPER_API_KEY` | Chave da Serper.dev (busca no Google Maps) |
| `GEMINI_API_KEY` | Chave do Google Gemini (enriquecimento) |
| `ABACATO_TOKEN` | Token de integração do quadro do CRM no Abacato (`abi_...`, ver abaixo) |

O endereço da API fica em `config.js` (`apiBase`). Se o front for servido de outro domínio,
inclua-o em `ALLOWED_ORIGINS` no `worker/wrangler.toml` (CORS) e publique a API de novo.

## O quadro do CRM no Abacato

O Beyond-Lead não tem conta no Abacato: ele usa um **token de integração** que abre só o
quadro do CRM e só cria card na coluna de entrada (a de alvos). Qual quadro e qual coluna
é decidido no Abacato, na criação do token — não neste repositório.

Para gerar o token, na pasta do Abacato (`beyond-assist/Abacatosys/abacato`):

```bash
npm run migrar db/012-integracoes.sql
node scripts/criar-integracao.mjs "Beyond-Lead" "CRM" "Alvos"
npm run migrar <o arquivo .sql que o script indicar>
```

O token fica em `~/token-integracao-beyond-lead.txt`. Grave-o no Worker como o secret
`ABACATO_TOKEN` (comando acima) e apague o arquivo. Para revogar, desligue a integração no Abacato
(`update public.abacato_integracoes set ativo = false where nome = 'Beyond-Lead';`).

O dashboard classifica as colunas **pelo nome** (Alvos/Backlog, Abordagem/Hoje, Diagnóstico,
Proposta, Fechado/Faturamento, Perdido/Geladeira, Follow-up, Tickets, Metas), soma os valores
em R$ dos cards fechados e agrupa por mês pela etiqueta "MÊS DE X". Como o Abacato não guarda
"última atividade" por card, a data de referência é a de **criação** do card.

## Estrutura

```
Beyond-Lead/
├── index.html             → front-end (GitHub Pages, raiz da main)
├── style.css
├── config.js              → endereço da API (sem chaves!)
├── app.js
├── .nojekyll              → o Pages serve os arquivos como estão
├── worker/                → back-end (Cloudflare Workers)
│   ├── wrangler.toml
│   └── src/
│       ├── index.js        → rotas /api/* + CORS
│       ├── search.js       → busca Serper Places
│       ├── abacato.js      → cliente da API de integração do Abacato
│       ├── process-lead.js → dedup + scrape + Gemini + card no CRM
│       └── funil.js        → stats do quadro do CRM
├── package.json           → scripts api:local e api:publicar (wrangler)
└── README.md
```
