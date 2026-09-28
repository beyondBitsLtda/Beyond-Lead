# Prospect Leads — Central de Operação 🎯

Aplicação de prospecção + central de operação de leads.
Prospecta empresas via Google Maps (Serper), cadastra no Trello,
lê o funil do Trello em tempo real e permite enviar WhatsApp direto do dashboard.

## Como está hospedado

| Parte | Onde | Pasta |
|---|---|---|
| Front-end (HTML/CSS/JS estático) | GitHub Pages | `public/` |
| Back-end (`/api/*`) | Cloudflare Workers | `worker/` |

O GitHub Pages só serve arquivos estáticos, por isso as funções que usam as chaves
(Serper, Gemini, Trello) rodam no Worker. **As chaves nunca vão para o front-end.**

Os dois deploys são automáticos a cada push na `main`, pelos workflows em `.github/workflows/`.

## Configuração (uma vez)

1. **GitHub Pages:** em *Settings → Pages → Build and deployment*, escolha **Source: GitHub Actions**.
2. **Secrets do repositório** (*Settings → Secrets and variables → Actions*):

   | Secret | Descrição |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | Token da Cloudflare com permissão "Edit Cloudflare Workers" |
   | `CLOUDFLARE_ACCOUNT_ID` | ID da conta Cloudflare |
   | `SERPER_API_KEY` | Chave da Serper.dev (busca no Google Maps) |
   | `GEMINI_API_KEY` | Chave do Google Gemini (enriquecimento) |
   | `TRELLO_API_KEY` | API Key do Trello |
   | `TRELLO_TOKEN` | Token do Trello |
   | `TRELLO_LIST_ID` | ID da lista "Alvos (Backlog da Semana)" |
   | `TRELLO_BOARD_ID` | Slug do board (ex: `vNJvgWUR`, tirado da URL do Trello) |

3. Rode o workflow **Deploy Worker (API)** (aba *Actions*) e copie a URL do Worker
   (`https://beyond-lead-api.<sua-conta>.workers.dev`).
4. Coloque essa URL em `apiBase` no arquivo `public/config.js` e faça push.
5. Se o front for servido de outro domínio, inclua-o em `ALLOWED_ORIGINS` no `worker/wrangler.toml` (CORS).

## Estrutura

```
Beyond-Lead/
├── public/                → front-end (GitHub Pages)
│   ├── index.html
│   ├── style.css
│   ├── config.js          → endereço da API (sem chaves!)
│   └── app.js
├── worker/                → back-end (Cloudflare Workers)
│   ├── wrangler.toml
│   └── src/
│       ├── index.js        → rotas /api/* + CORS
│       ├── search.js       → busca Serper Places
│       ├── process-lead.js → scrape + Gemini + Trello
│       └── trello-stats.js → stats do board
├── .github/workflows/
│   ├── pages.yml          → deploy do front
│   └── worker.yml         → deploy da API
└── README.md
```
