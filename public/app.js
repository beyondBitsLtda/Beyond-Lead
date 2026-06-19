// /public/app.js
// Orquestrador da prospecção. Coleta filtros do usuário, busca no Maps,
// aplica filtros no frontend e processa cada lead sequencialmente.

(() => {
  // Elementos
  const form = document.getElementById('search-form');
  const queryInput = document.getElementById('query');
  const limitInput = document.getElementById('limit');
  const minRatingInput = document.getElementById('min-rating');
  const requirePhoneInput = document.getElementById('require-phone');
  const requireWebsiteInput = document.getElementById('require-website');
  const dedupInput = document.getElementById('dedup');
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

  // Utilitários
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
    limitInput.disabled = lock;
    minRatingInput.disabled = lock;
    requirePhoneInput.disabled = lock;
    requireWebsiteInput.disabled = lock;
    dedupInput.disabled = lock;
    startBtn.disabled = lock;
    startBtn.textContent = lock ? 'Prospectando…' : 'Iniciar Prospecção';
  }

  // Filtros de qualidade aplicados no frontend antes de chamar process-lead
  function applyFilters(items, filters) {
    return items.filter((item) => {
      const p = item.place || {};

      if (filters.requirePhone && !p.telefone) return false;
      if (filters.requireWebsite && !p.site) return false;
      if (filters.minRating > 0 && (!p.rating || p.rating < filters.minRating)) return false;

      return true;
    });
  }

  // Chamadas ao backend
  async function callSearch(query, limit) {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.details || `HTTP ${res.status}`);
    }
    return data;
  }

  async function callProcessLead(item, query, dedup) {
    const res = await fetch('/api/process-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: item.link,
        query,
        place: item.place,
        dedup
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  // Fluxo principal
  async function runProspect() {
    const query = queryInput.value.trim();
    const filters = {
      limit: parseInt(limitInput.value, 10) || 10,
      minRating: parseFloat(minRatingInput.value) || 0,
      requirePhone: requirePhoneInput.checked,
      requireWebsite: requireWebsiteInput.checked,
      dedup: dedupInput.checked
    };

    running = true;
    lockUI(true);
    summaryEl.hidden = true;
    const startedAt = Date.now();

    log(`🔎 Buscando no Google Maps: "${query}" (até ${filters.limit} leads)`, 'info');

    let searchResult;
    try {
      searchResult = await callSearch(query, filters.limit);
    } catch (err) {
      log(`❌ Falha na busca: ${err.message}`, 'error');
      lockUI(false);
      running = false;
      return;
    }

    const rawItems = searchResult.results || [];
    log(`✅ ${rawItems.length} negócios encontrados.`, 'success');

    // Aplicar filtros de qualidade
    const items = applyFilters(rawItems, filters);
    const filteredOut = rawItems.length - items.length;

    if (filteredOut > 0) {
      log(`🔍 ${filteredOut} descartado(s) pelos filtros de qualidade.`, 'muted');
    }

    if (items.length === 0) {
      log('Nenhum lead passou pelos filtros. Tente afrouxar os critérios.', 'warn');
      lockUI(false);
      running = false;
      return;
    }

    log(`📋 ${items.length} lead(s) entram na fila de cadastro.`, 'info');

    let ok = 0;
    let fail = 0;
    let duplicated = 0;

    setProgress(0, items.length, 'Processando fila de leads…');

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const idx = i + 1;
      const nomePreview = item.place?.nome || item.title || item.link;

      log(`[${idx}/${items.length}] 🌐 Processando: ${nomePreview}`, 'info');

      if (item.place?.telefone) {
        log(`   ↳ 📞 ${item.place.telefone}`, 'muted');
      }
      if (item.place?.rating) {
        log(`   ↳ ⭐ ${item.place.rating} (${item.place.reviews || 0} reviews)`, 'muted');
      }

      try {
        const result = await callProcessLead(item, query, filters.dedup);

        if (result.success) {
          ok++;
          const nome = result.lead?.nome_empresa || 'sem nome';
          const emailInfo = result.lead?.email ? ` · ${result.lead.email}` : '';
          log(
            `   ↳ ✅ Card criado: "${nome}"${emailInfo} → ${result.trello?.url || 'Trello'}`,
            'success'
          );
        } else if (result.stage === 'dedup') {
          duplicated++;
          log(`   ↳ 🔁 Já existe no Trello — pulado.`, 'muted');
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
      `🏁 Finalizado: ${ok} criado(s), ${duplicated} duplicado(s), ${fail} falha(s) em ${fmtElapsed(elapsed)}.`,
      'success'
    );

    sumOk.textContent = ok;
    sumFail.textContent = fail + duplicated;
    sumTime.textContent = fmtElapsed(elapsed);
    summaryEl.hidden = false;

    lockUI(false);
    running = false;
  }

  // Eventos
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (running) return;
    const query = queryInput.value.trim();
    if (query.length < 3) {
      log('Digite um termo de busca com pelo menos 3 caracteres.', 'warn');
      return;
    }
    runProspect();
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
