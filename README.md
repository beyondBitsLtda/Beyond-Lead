# Prospect Leads — Central de Operação 🎯

Aplicação de prospecção + central de operação de leads.
Prospecta empresas via Google Maps (Serper), cadastra no Trello,
lê o funil do Trello em tempo real e permite enviar WhatsApp direto do dashboard.

## Passos para deploy

1. **Delete o arquivo antigo** `api/chat.js` do repo (não é mais usado).
2. **Substitua os arquivos** deste pacote no repositório.
3. **Adicione a nova variável de ambiente** na Vercel:

   | Variável | Valor |
   |---|---|
   | `TRELLO_BOARD_ID` | O slug do seu board (ex: `vNJvgWUR`, tirado da URL do Trello) |

4. `git commit`, `git push` e a Vercel faz o deploy.

## Variáveis de ambiente completas

| Variável | Descrição |
|---|---|
| `SERPER_API_KEY` | Chave da Serper.dev (busca no Google Maps) |
| `GEMINI_API_KEY` | Chave do Google Gemini (enriquecimento) |
| `TRELLO_API_KEY` | API Key do Trello |
| `TRELLO_TOKEN` | Token do Trello |
| `TRELLO_LIST_ID` | ID da lista "Alvos (Backlog da Semana)" |
| `TRELLO_BOARD_ID` | **NOVA** — slug do board (ex: `vNJvgWUR`) |

## O que tem de novo

- **Aba Central** com dashboard completo do funil de vendas
- Leitura em tempo real do Trello (todas as colunas)
- Gráficos: funil, faturamento mensal, distribuição por etiqueta, movimentação semanal
- KPIs: leads no funil, em abordagem, fechados, faturamento do mês
- Meta da semana lida direto do card "Metas da Semana"
- Cards de "Abordagem HOJE" com botão **WhatsApp** integrado
- Templates de mensagem com variáveis `{{nome_empresa}}` (salvos no navegador)
- Visual novo — tema dark violet neon
- Chat de IA removido (some o 502 junto)

## Estrutura

```
prospect-leads/
├── api/
│   ├── search.js          → busca Serper Places
│   ├── process-lead.js    → scrape + Gemini + Trello
│   └── trello-stats.js    → NOVO: stats do board
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── package.json
├── vercel.json
└── README.md
```
