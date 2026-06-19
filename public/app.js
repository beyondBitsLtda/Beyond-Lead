// /public/app.js
// Orquestrador da prospecção. Faz UMA chamada ao /api/search,
// e depois processa cada resultado SEQUENCIALMENTE via /api/process-lead.
// Agora trabalha com dados do Google Maps (Serper Places) — passa o objeto
// "place" inteiro adiante para o backend.

(() => {
  // ----------------------------------------------------------
  // Elementos
  // ----------------------------------------------------------
  const form = document.getElementById('search-form');
  const queryInput = document.getElementById('query');
  const startBtn = document.getElementById('start-btn');
  const logEl = document.getElementById('log');
  const clearLogBtn = document.getElementById('clear-log');

  const progressEl = document.getElementById('progress');
  const progressLabel = document.getElementById('progress-label');
  const progressCount = document.getElementById('progress-count');
  const progressFill = document.getElementById('progress-fill');

  const summaryEl = document.getElementById('summary');
  const sumOk = document.getElementById('sum-ok');
  const sumFail = document.getElementById('sum-fail');
  const sumTime = document.getElementById('sum-time');

  let running = false;

  // ----------------------------------------------------------
  // Utilitários
  // ----------------------------------------------------------
  function log(message, type = 'info') {
    const empty = logEl.querySelector('.log-empty');
    if (empty) empty.remove();

    const time = new Date().toLocaleTimeString('pt-BR');
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.innerHTML =
      `<span class="log-time">[${time}]</span>` +
      `<span class="log-msg"></span>`;
    line.querySelector('.log-msg').textContent = message;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setProgress(current, total, label) {
    progressEl.hidden = false;
    progressLabel.textContent = label || 'Processando…';
    progressCount.textContent = `${current} / ${total}`;
    const pct = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${pct}%`;
  }

  function fmtElapsed(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return `${m}m ${rs}s`;
  }

  function lockUI(lock) {
    queryInput.disabled = lock;
    startBtn.disabled = lock;
    startBtn.textContent = lock ? 'Prospectando…' : 'Iniciar Prospecção';
  }

  // ----------------------------------------------------------
  // Chamadas ao backend
  // ----------------------------------------------------------
  async function callSearch(query) {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.details || `HTTP ${res.status}`);
    }
    return data;
  }

  async function callProcessLead(item, query) {
    // item contém { title, link, snippet, place: { ... } }
    const res = await fetch('/api/process-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: item.link,
        query,
        place: item.place
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  // ----------------------------------------------------------
  // Fluxo principal
  // ----------------------------------------------------------
  async function runProspect(query) {
    running = true;
    lockUI(true);
    summaryEl.hidden = true;
    const startedAt = Date.now();

    log(`🔎 Buscando no Google Maps: "${query}"`, 'info');

    let searchResult;
    try {
      searchResult = await callSearch(query);
    } catch (err) {
      log(`❌ Falha na busca: ${err.message}`, 'error');
      lockUI(false);
      running = false;
      return;
    }

    const items = searchResult.results || [];
    log(`✅ ${items.length} negócios encontrados no Maps.`, 'success');

    if (items.length === 0) {
      log('Sem resultados para processar. Tente outro termo de busca.', 'warn');
      lockUI(false);
      running = false;
      return;
    }

    let ok = 0;
    let fail = 0;

    setProgress(0, items.length, 'Processando fila de leads…');

    // FILA SEQUENCIAL: um lead por vez para respeitar o timeout do Vercel.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const idx = i + 1;
      const nomePreview = item.place?.nome || item.title || item.link;

      log(`[${idx}/${items.length}] 🌐 Processando: ${nomePreview}`, 'info');

      // Mostra telefone e site quando disponíveis (dados já vindos do Maps)
      if (item.place?.telefone) {
        log(`   ↳ 📞 ${item.place.telefone}`, 'muted');
      }
      if (item.place?.site) {
        log(`   ↳ 🌍 ${item.place.site}`, 'muted');
      } else {
        log(`   ↳ (sem site cadastrado no Maps)`, 'muted');
      }

      try {
        const result = await callProcessLead(item, query);

        if (result.success) {
          ok++;
          const nome = result.lead?.nome_empresa || 'sem nome';
          const emailInfo = result.lead?.email
            ? ` · e-mail: ${result.lead.email}`
            : '';
          log(
            `   ↳ ✅ Card criado: "${nome}"${emailInfo} → ${result.trello?.url || 'Trello'}`,
            'success'
          );
        } else {
          fail++;
          const reason = result.error || result.reason || 'motivo não informado';
          log(`   ↳ ⚠️ Pulado: ${reason}`, 'warn');
        }
      } catch (err) {
        fail++;
        log(`   ↳ ❌ Erro: ${err.message}`, 'error');
      }

      setProgress(idx, items.length, 'Processando fila de leads…');
    }

    const elapsed = Date.now() - startedAt;
    setProgress(items.length, items.length, 'Concluído ✓');

    log(
      `🏁 Finalizado. ${ok} sucesso(s), ${fail} falha(s) em ${fmtElapsed(elapsed)}.`,
      'success'
    );

    // Resumo
    sumOk.textContent = ok;
    sumFail.textContent = fail;
    sumTime.textContent = fmtElapsed(elapsed);
    summaryEl.hidden = false;

    lockUI(false);
    running = false;
  }

  // ----------------------------------------------------------
  // Eventos
  // ----------------------------------------------------------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (running) return;
    const query = queryInput.value.trim();
    if (query.length < 3) {
      log('Digite um termo de busca com pelo menos 3 caracteres.', 'warn');
      return;
    }
    runProspect(query);
  });

  clearLogBtn.addEventListener('click', () => {
    if (running) {
      log('Não é possível limpar o log durante uma prospecção em andamento.', 'warn');
      return;
    }
    logEl.innerHTML =
      '<div class="log-empty">Nada por aqui ainda. Inicie uma busca para ver o andamento.</div>';
    summaryEl.hidden = true;
    progressEl.hidden = true;
    progressFill.style.width = '0%';
  });
})();
