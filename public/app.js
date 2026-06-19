// /public/app.js
// Orquestrador da prospecção + chat de estratégia com Gemini.

(() => {
  // ============================================================
  // Sistema de abas
  // ============================================================
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = `tab-${btn.dataset.tab}`;
      tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
      tabContents.forEach((c) => c.classList.toggle('active', c.id === targetId));
    });
  });

  // ============================================================
  // ABA 1: Prospecção
  // ============================================================
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

  function applyFilters(items, filters) {
    return items.filter((item) => {
      const p = item.place || {};
      if (filters.requirePhone && !p.telefone) return false;
      if (filters.requireWebsite && !p.site) return false;
      if (filters.minRating > 0 && (!p.rating || p.rating < filters.minRating)) return false;
      return true;
    });
  }

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
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

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

    let ok = 0, fail = 0, duplicated = 0;
    setProgress(0, items.length, 'Processando fila de leads…');

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const idx = i + 1;
      const nomePreview = item.place?.nome || item.title || item.link;

      log(`[${idx}/${items.length}] 🌐 Processando: ${nomePreview}`, 'info');
      if (item.place?.telefone) log(`   ↳ 📞 ${item.place.telefone}`, 'muted');
      if (item.place?.rating) {
        log(`   ↳ ⭐ ${item.place.rating} (${item.place.reviews || 0} reviews)`, 'muted');
      }

      try {
        const result = await callProcessLead(item, query, filters.dedup);
        if (result.success) {
          ok++;
          const nome = result.lead?.nome_empresa || 'sem nome';
          const emailInfo = result.lead?.email ? ` · ${result.lead.email}` : '';
          log(`   ↳ ✅ Card criado: "${nome}"${emailInfo} → ${result.trello?.url || 'Trello'}`, 'success');
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

  // ============================================================
  // ABA 2: Chat de estratégia
  // ============================================================
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatWindow = document.getElementById('chat-window');
  const chatClear = document.getElementById('chat-clear');
  const chatSuggestions = document.querySelectorAll('.suggestion');

  let chatHistory = [];
  let chatLoading = false;

  function appendMessage(role, text) {
    const empty = chatWindow.querySelector('.chat-empty');
    if (empty) empty.remove();

    const msg = document.createElement('div');
    msg.className = `chat-message ${role}`;

    // Simples conversão de **bold** para <strong>
    const formatted = text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    msg.innerHTML = formatted;

    chatWindow.appendChild(msg);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return msg;
  }

  function appendTyping() {
    const msg = document.createElement('div');
    msg.className = 'chat-message typing';
    msg.id = 'typing-indicator';
    msg.textContent = 'Pensando…';
    chatWindow.appendChild(msg);
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }

  function removeTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  async function sendChatMessage(text) {
    if (!text || chatLoading) return;

    chatLoading = true;
    chatSend.disabled = true;
    chatInput.disabled = true;

    appendMessage('user', text);
    appendTyping();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: chatHistory
        })
      });

      const data = await res.json().catch(() => ({}));
      removeTyping();

      if (!res.ok || !data.success) {
        appendMessage('assistant', `⚠️ Erro: ${data.error || data.details || 'falha na consulta'}`);
      } else {
        appendMessage('assistant', data.reply);
        chatHistory.push({ role: 'user', text });
        chatHistory.push({ role: 'assistant', text: data.reply });

        // Limita histórico a últimas 20 mensagens pra não estourar tokens
        if (chatHistory.length > 20) {
          chatHistory = chatHistory.slice(-20);
        }
      }
    } catch (err) {
      removeTyping();
      appendMessage('assistant', `⚠️ Erro de rede: ${err.message}`);
    }

    chatLoading = false;
    chatSend.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    sendChatMessage(text);
  });

  // Enter envia, Shift+Enter quebra linha
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.dispatchEvent(new Event('submit'));
    }
  });

  chatSuggestions.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (chatLoading) return;
      const prompt = btn.dataset.prompt;
      sendChatMessage(prompt);
    });
  });

  chatClear.addEventListener('click', () => {
    if (chatLoading) return;
    chatHistory = [];
    chatWindow.innerHTML = `
      <div class="chat-empty">
        👋 Conversa zerada. Como posso ajudar?
      </div>
    `;
  });
})();
