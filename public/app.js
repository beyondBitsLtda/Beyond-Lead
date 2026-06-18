// /public/app.js
// Orquestrador da prospecção. Faz UMA chamada ao /api/search,
// e depois processa URLs SEQUENCIALMENTE chamando /api/process-lead.
// Cada chamada respeita o limite de tempo do Vercel Hobby (até 60s).

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
    // Remove placeholder vazio na primeira inserção
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

  async function callProcessLead(url, query) {
    const res = await fetch('/api/process-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, query })
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

    log(`🔎 Buscando: "${query}"`, 'info');

    let searchResult;
    try {
      searchResult = await callSearch(query);
    } catch (err) {
      log(`❌ Falha na busca: ${err.message}`, 'error');
      lockUI(false);
      running = false;
      return;
    }

    const urls = searchResult.results || [];
    log(`✅ ${urls.length} URLs encontradas.`, 'success');

    if (urls.length === 0) {
      log('Sem resultados para processar. Tente outro termo de busca.', 'warn');
      lockUI(false);
      running = false;
      return;
    }

    let ok = 0;
    let fail = 0;

    setProgress(0, urls.length, 'Processando fila de leads…');

    // FILA SEQUENCIAL: uma URL por vez para respeitar o timeout do Vercel.
    for (let i = 0; i < urls.length; i++) {
      const { link, title } = urls[i];
      const idx = i + 1;

      log(`[${idx}/${urls.length}] 🌐 Processando: ${title || link}`, 'info');
      log(`   ↳ ${link}`, 'muted');

      try {
        const result = await callProcessLead(link, query);

        if (result.success) {
          ok++;
          const nome = result.lead?.nome_empresa || 'sem nome';
          log(
            `   ↳ ✅ Card criado: "${nome}" → ${result.trello?.url || 'Trello'}`,
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

      setProgress(idx, urls.length, 'Processando fila de leads…');
    }

    const elapsed = Date.now() - startedAt;
    setProgress(urls.length, urls.length, 'Concluído ✓');

    log(`🏁 Finalizado. ${ok} sucesso(s), ${fail} falha(s) em ${fmtElapsed(elapsed)}.`, 'success');

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
