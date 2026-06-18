# Prospect Leads 🎯

Aplicação de prospecção automatizada de leads. Recebe um termo de busca, varre a web via Google Custom Search, extrai dados estruturados dos sites com Gemini 1.5 Flash e cria um card no Trello para cada lead.

## Arquitetura

```
┌──────────┐   1) POST /api/search   ┌──────────────┐   Google CSE
│ Frontend │ ──────────────────────► │   Vercel     │ ─────────────►
│ (Vanilla │                         │   Function   │
│   JS)    │ ◄────── 10 URLs ─────── │              │
└──────────┘                         └──────────────┘
     │
     │  Loop sequencial — UMA URL por vez (evita timeout):
     │
     │   POST /api/process-lead { url }
     ▼
┌──────────────┐
│   Vercel     │  ──► cheerio (scrape)
│   Function   │  ──► Gemini 1.5 Flash (extrai JSON)
│              │  ──► Trello API (cria card)
└──────────────┘
```

**Por que a fila vive no frontend?** O plano Hobby da Vercel tem timeout de até 60s por requisição. Processar 10 leads no backend síncrono estouraria esse limite. Mantendo o loop no navegador, cada chamada à serverless function processa um único lead e devolve resposta dentro do prazo.

## Stack

- **Frontend:** HTML, CSS e Vanilla JavaScript
- **Backend:** Vercel Serverless Functions (Node.js 18+, ESM)
- **Libs:** `axios`, `cheerio`
- **APIs externas:** Google Custom Search, Gemini 1.5 Flash, Trello

## Estrutura

```
prospect-leads/
├── api/
│   ├── search.js          # POST /api/search       → Google CSE
│   └── process-lead.js    # POST /api/process-lead → scrape + Gemini + Trello
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js             # Orquestrador da fila
├── package.json
├── vercel.json            # maxDuration por função
├── .env.example
└── .gitignore
```

## Pré-requisitos

- Node.js 18 ou superior
- [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`)
- Chaves nas APIs (veja `.env.example`):
  - Google Custom Search API Key + Search Engine ID (CX)
  - Google Gemini API Key
  - Trello API Key + Token + ID da lista de destino

## Teste local

```bash
# 1. Instalar dependências
npm install

# 2. Criar arquivo .env a partir do template
cp .env.example .env
# edite .env e preencha todas as chaves

# 3. Rodar localmente com Vercel CLI
#    (na primeira vez ele pede para vincular ao projeto Vercel — pode pular se quiser só local)
vercel dev
```

A aplicação sobe em `http://localhost:3000`. O `vercel dev` injeta as variáveis do `.env` nas serverless functions automaticamente.

## Deploy

```bash
# Faz upload e publica
vercel deploy --prod
```

Depois do deploy, **configure as variáveis de ambiente no painel da Vercel** (Settings → Environment Variables). As mesmas variáveis do `.env`.

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `GOOGLE_SEARCH_API_KEY` | Chave da Google Custom Search JSON API |
| `GOOGLE_SEARCH_CX`      | Search Engine ID do Programmable Search |
| `GEMINI_API_KEY`        | Chave da Google Gemini API (AI Studio) |
| `TRELLO_API_KEY`        | API Key do Trello |
| `TRELLO_TOKEN`          | Token de usuário do Trello |
| `TRELLO_LIST_ID`        | ID da lista de destino dos cards |

## Notas técnicas

- Scraping limita o texto a **8.000 caracteres** antes de enviar ao Gemini, para reduzir custo de tokens.
- O Gemini é chamado com `responseMimeType: 'application/json'` e `temperature: 0.2` — saída estável e estruturada.
- O endpoint `/api/process-lead` devolve HTTP 200 mesmo em falha de um lead específico, contendo `success: false`. Isso permite ao frontend seguir com a fila sem interromper por erros pontuais.
- A função `search.js` tem `maxDuration: 30`; `process-lead.js` tem `maxDuration: 60` (limite do Hobby).
- O frontend é estático em `/public` — a Vercel serve automaticamente.
