// /public/app.js
// Central de Operação: Trello stats + dashboard + WhatsApp templates + prospecção.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  /* ============================================================
     Sistema de abas
     ============================================================ */
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = `tab-${btn.dataset.tab}`;
      $$('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      $$('.tab-content').forEach((c) => c.classList.toggle('active', c.id === target));
      if (btn.dataset.tab === 'dashboard') loadDashboard();
    });
  });

  /* ============================================================
     Formatação
     ============================================================ */
  const fmtBRL = (v) =>
    v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const fmtNum = (v) => v.toLocaleString('pt-BR');

  /* ============================================================
     DASHBOARD
     ============================================================ */
  const refreshBtn = $('#refresh-btn');
  refreshBtn.addEventListener('click', loadDashboard);

  let dashState = null;

  async function loadDashboard() {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '↻ Sincronizando…';
    $('#last-update').textContent = 'Sincronizando com o Trello…';

    try {
      const res = await fetch('/api/trello-stats');
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Falha');
      dashState = data;
      renderDashboard(data);
      const t = new Date(data.updatedAt).toLocaleTimeString('pt-BR');
      $('#last-update').textContent = `Última sincronização: ${t}`;
    } catch (err) {
      $('#last-update').textContent = `⚠ Erro: ${err.message}`;
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ Atualizar';
    }
  }

  function renderDashboard(d) {
    // KPIs
    $('#kpi-funil').textContent = fmtNum(d.totals.emFunil);
    $('#kpi-abordagem').textContent = fmtNum(d.totals.abordagem);
    $('#kpi-fechados').textContent = fmtNum(d.totals.fechado);
    $('#kpi-mes').textContent = fmtBRL(d.revenue.currentMonth);
    $('#kpi-mes-hint').textContent = `Ano: ${fmtBRL(d.revenue.currentYear)}`;

    // Funil
    renderFunnel(d.totals);

    // Taxa de conversão
    $('#conv-tag').textContent = `Conv. ${d.conversion.rate}%`;

    // Meta da semana
    renderMeta(d.metaSemana);

    // Meta mensal (faturamento)
    renderMetaMensal(d.metaMensal);

    // Faturamento mensal
    renderRevenue(d.revenue.monthlySeries);
    $('#revenue-total').textContent = fmtBRL(d.revenue.allTimeFechado);

    // Etiquetas
    renderLabels(d.byLabel);

    // Semanal
    renderWeekly(d.weeklySeries);

    // Abordagem HOJE
    renderToday(d.abordagemHoje);
  }

  function renderFunnel(t) {
    const stages = [
      { key: 'alvos', label: 'Alvos', count: t.alvos },
      { key: 'abordagem', label: 'Abordagem', count: t.abordagem },
      { key: 'diagnostico', label: 'Diagnóstico', count: t.diagnostico },
      { key: 'proposta', label: 'Proposta', count: t.proposta },
      { key: 'fechado', label: 'Fechado', count: t.fechado },
      { key: 'perdido', label: 'Perdido', count: t.perdido }
    ];
    const max = Math.max(...stages.map((s) => s.count), 1);
    const el = $('#funnel-chart');
    el.innerHTML = stages.map((s) => `
      <div class="funnel-row">
        <div class="funnel-label">${s.label}</div>
        <div class="funnel-bar-wrap">
          <div class="funnel-bar" style="width:${(s.count / max) * 100}%">
            ${s.count > 0 ? s.count : ''}
          </div>
        </div>
      </div>
    `).join('');
  }

  function renderMeta(meta) {
    const el = $('#meta-widget');
    if (!meta || meta.total === 0) {
      el.innerHTML = '<div class="meta-empty">Sem meta cadastrada.</div>';
      return;
    }
    const pct = Math.round((meta.done / meta.total) * 100);
    const items = meta.items.slice(0, 5).map((i) =>
      `<li class="${i.done ? 'done' : ''}">${i.done ? '✓' : '○'} ${escapeHtml(i.name)}</li>`
    ).join('');
    el.innerHTML = `
      <div class="meta-title">${escapeHtml(meta.name)}</div>
      <div class="meta-progress"><div class="meta-progress-fill" style="width:${pct}%"></div></div>
      <div class="meta-pct">${meta.done} de ${meta.total} · ${pct}%</div>
      <ul class="meta-items">${items}</ul>
    `;
  }

  function renderMetaMensal(meta) {
    const el = $('#meta-mensal-widget');
    const pctTag = $('#meta-mensal-pct');
    if (!meta || meta.target === 0) {
      el.innerHTML = '<div class="meta-empty">Sem meta mensal cadastrada.<br><small>Crie um card "Meta Mensal" na coluna Metas com um item de checklist tipo "Fechar Serviços de R$ 5.000".</small></div>';
      pctTag.textContent = '—';
      return;
    }
    const remain = Math.max(0, meta.target - meta.current);
    const isComplete = meta.pct >= 100;
    pctTag.textContent = `${meta.pct}%`;
    pctTag.style.background = isComplete ? 'rgba(74, 222, 128, 0.15)' : 'rgba(251, 191, 36, 0.12)';
    pctTag.style.color = isComplete ? 'var(--success)' : '#facc15';
    pctTag.style.borderColor = isComplete ? 'rgba(74, 222, 128, 0.3)' : 'rgba(251, 191, 36, 0.3)';

    el.innerHTML = `
      <div class="meta-mensal-values">
        <span class="meta-mensal-current">${fmtBRL(meta.current)}</span>
        <span class="meta-mensal-target">de ${fmtBRL(meta.target)}</span>
      </div>
      <div class="meta-mensal-bar">
        <div class="meta-mensal-bar-fill ${isComplete ? 'complete' : ''}" style="width:${meta.pct}%"></div>
      </div>
      <div class="meta-mensal-remain">
        ${isComplete
          ? `🎉 Meta batida! Excedeu em ${fmtBRL(meta.current - meta.target)}.`
          : `Faltam ${fmtBRL(remain)} para bater a meta.`}
      </div>
    `;
  }

  function renderRevenue(series) {
    const max = Math.max(...series.map((s) => s.value), 1);
    const el = $('#revenue-chart');
    el.innerHTML = series.map((s) => {
      const h = (s.value / max) * 100;
      return `
        <div class="chart-bar-col">
          <div class="chart-bar-wrap">
            <div class="chart-bar" style="height:${h}%">
              ${s.value > 0 ? `<span class="chart-bar-value">${fmtBRL(s.value)}</span>` : ''}
            </div>
          </div>
          <div class="chart-bar-label">${s.label}</div>
        </div>
      `;
    }).join('');
  }

  function renderWeekly(series) {
    const max = Math.max(...series.map((s) => s.value), 1);
    const el = $('#weekly-chart');
    el.className = 'chart-bars';
    el.innerHTML = series.map((s) => {
      const h = (s.value / max) * 100;
      return `
        <div class="chart-bar-col">
          <div class="chart-bar-wrap">
            <div class="chart-bar" style="height:${h}%">
              ${s.value > 0 ? `<span class="chart-bar-value">${s.value}</span>` : ''}
            </div>
          </div>
          <div class="chart-bar-label">${s.label}</div>
        </div>
      `;
    }).join('');
  }

  function renderLabels(byLabel) {
    const entries = Object.entries(byLabel).sort((a, b) => b[1] - a[1]);
    const el = $('#labels-chart');
    if (entries.length === 0) {
      el.innerHTML = '<div class="empty">Sem etiquetas.</div>';
      return;
    }
    const max = entries[0][1];
    el.innerHTML = entries.slice(0, 8).map(([name, count]) => `
      <div class="label-row">
        <div class="label-swatch" style="background:${labelColor(name)};color:${labelColor(name)}"></div>
        <div class="label-name">${escapeHtml(name)}</div>
        <div class="label-bar-wrap"><div class="label-bar" style="width:${(count / max) * 100}%"></div></div>
        <div class="label-count">${count}</div>
      </div>
    `).join('');
  }

  function labelColor(name) {
    const n = name.toLowerCase();
    if (n.includes('site') || n.includes('sistema')) return '#60a5fa';
    if (n.includes('designer') || n.includes('portfolio')) return '#c084fc';
    if (n.includes('quente')) return '#ef4444';
    if (n.includes('contato')) return '#10b981';
    if (n.includes('julho') || n.includes('mês')) return '#eab308';
    if (n.includes('indicação')) return '#facc15';
    if (n.includes('exemplo')) return '#f97316';
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return `hsl(${Math.abs(h) % 360}, 70%, 65%)`;
  }

  function renderToday(items) {
    $('#today-count').textContent = items.length;
    const el = $('#today-list');
    if (!items || items.length === 0) {
      el.innerHTML = '<div class="empty">Nenhum lead na coluna "Abordagem HOJE".</div>';
      return;
    }
    el.innerHTML = items.map((c) => `
      <div class="today-card">
        <h4 class="today-name">${escapeHtml(c.name)}</h4>
        ${c.labels.length ? `<div class="today-labels">${c.labels.map((l) => `<span>${escapeHtml(l)}</span>`).join('')}</div>` : ''}
        <div class="today-meta">
          ${c.phone ? `📞 ${escapeHtml(c.phone)}` : '<em>sem telefone</em>'}
        </div>
        <div class="today-actions">
          <a href="${c.url}" target="_blank" rel="noopener">Trello</a>
          ${c.phone
            ? `<button class="wa-btn" data-action="send" data-name="${escapeAttr(c.name)}" data-phone="${escapeAttr(c.phone)}">💬 WhatsApp</button>`
            : `<button disabled>Sem fone</button>`}
        </div>
      </div>
    `).join('');
    el.querySelectorAll('[data-action="send"]').forEach((btn) => {
      btn.addEventListener('click', () => openSendModal(btn.dataset.name, btn.dataset.phone));
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  /* ============================================================
     TEMPLATES DE MENSAGEM (localStorage)
     ============================================================ */
  const TPL_KEY = 'prospect_leads_templates_v1';

  function loadTemplates() {
    try {
      const raw = localStorage.getItem(TPL_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return [
      { id: 't1', name: 'Primeira abordagem', body: 'Olá! Sou {seu_nome} da Beyond Bits. Vi o site da {{nome_empresa}} e gostei do trabalho de vocês com {{nicho}}. Trabalho com sites e sistemas sob medida e queria entender se faria sentido trocarmos uma ideia. Faz sentido pra vocês?' },
      { id: 't2', name: 'Follow-up 3 dias', body: 'Oi! Só passando aqui pra saber se conseguiu ver a mensagem sobre a {{nome_empresa}}. Se preferir, posso te mandar um resumo rápido do que a gente faz.' }
    ];
  }
  function saveTemplates(list) { localStorage.setItem(TPL_KEY, JSON.stringify(list)); }
  let templates = loadTemplates();

  function renderTemplates() {
    const el = $('#templates-list');
    if (templates.length === 0) {
      el.innerHTML = '<div class="empty">Nenhum template. Crie o primeiro.</div>';
      return;
    }
    el.innerHTML = templates.map((t) => `
      <div class="tpl-row">
        <div class="tpl-info">
          <h4>${escapeHtml(t.name)}</h4>
          <p>${escapeHtml(t.body.slice(0, 90))}${t.body.length > 90 ? '…' : ''}</p>
        </div>
        <div class="tpl-actions">
          <button class="btn-ghost small" data-action="edit" data-id="${t.id}">Editar</button>
          <button class="btn-ghost small" data-action="delete" data-id="${t.id}">Excluir</button>
        </div>
      </div>
    `).join('');
    el.querySelectorAll('[data-action="edit"]').forEach((b) =>
      b.addEventListener('click', () => openTemplateModal(b.dataset.id)));
    el.querySelectorAll('[data-action="delete"]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!confirm('Excluir este template?')) return;
        templates = templates.filter((t) => t.id !== b.dataset.id);
        saveTemplates(templates);
        renderTemplates();
      }));
  }

  let editingTplId = null;
  const tplModal = $('#template-modal');
  const tplName = $('#tpl-name');
  const tplBody = $('#tpl-body');

  function openTemplateModal(id) {
    editingTplId = id || null;
    if (id) {
      const t = templates.find((x) => x.id === id);
      $('#template-modal-title').textContent = 'Editar template';
      tplName.value = t.name;
      tplBody.value = t.body;
    } else {
      $('#template-modal-title').textContent = 'Novo template';
      tplName.value = '';
      tplBody.value = '';
    }
    tplModal.hidden = false;
    tplName.focus();
  }
  function closeTemplateModal() { tplModal.hidden = true; }

  $('#new-template').addEventListener('click', () => openTemplateModal(null));
  $('#template-close').addEventListener('click', closeTemplateModal);
  $('#tpl-cancel').addEventListener('click', closeTemplateModal);
  $('#tpl-save').addEventListener('click', () => {
    const name = tplName.value.trim();
    const body = tplBody.value.trim();
    if (!name || !body) { alert('Preencha nome e mensagem.'); return; }
    if (editingTplId) {
      templates = templates.map((t) => t.id === editingTplId ? { ...t, name, body } : t);
    } else {
      templates.push({ id: 't' + Date.now(), name, body });
    }
    saveTemplates(templates);
    renderTemplates();
    closeTemplateModal();
  });

  renderTemplates();

  /* ============================================================
     MODAL DE ENVIO WHATSAPP
     ============================================================ */
  const sendModal = $('#send-modal');
  const sendTemplate = $('#send-template');
  const sendBody = $('#send-body');
  const sendOpen = $('#send-open');
  let sendTarget = { name: '', phone: '' };

  function openSendModal(name, phone) {
    sendTarget = { name, phone };
    $('#send-target').innerHTML =
      `Enviando para <strong>${escapeHtml(name)}</strong> · ${escapeHtml(phone)}`;
    sendTemplate.innerHTML = '<option value="">— Escrever do zero —</option>' +
      templates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    sendBody.value = '';
    updateSendLink();
    sendModal.hidden = false;
    sendBody.focus();
  }
  function closeSendModal() { sendModal.hidden = true; }

  sendTemplate.addEventListener('change', () => {
    const tpl = templates.find((t) => t.id === sendTemplate.value);
    if (tpl) sendBody.value = applyVars(tpl.body, sendTarget);
    else sendBody.value = '';
    updateSendLink();
  });
  sendBody.addEventListener('input', updateSendLink);

  function applyVars(text, target) {
    return text
      .replace(/\{\{nome_empresa\}\}/gi, target.name)
      .replace(/\{\{nicho\}\}/gi, '');
  }

  function updateSendLink() {
    const digits = sendTarget.phone.replace(/\D/g, '');
    let intl = digits;
    if (digits.length === 10 || digits.length === 11) intl = '55' + digits;
    const text = encodeURIComponent(sendBody.value.trim());
    sendOpen.href = `https://wa.me/${intl}${text ? '?text=' + text : ''}`;
  }

  $('#send-close').addEventListener('click', closeSendModal);
  $('#send-cancel').addEventListener('click', closeSendModal);
  sendOpen.addEventListener('click', () => setTimeout(closeSendModal, 200));

  /* ============================================================
     PROSPECÇÃO (fluxo original)
     ============================================================ */
  const form = $('#search-form');
  const queryInput = $('#query');
  const limitInput = $('#limit');
  const minRatingInput = $('#min-rating');
  const requirePhoneInput = $('#require-phone');
  const requireWebsiteInput = $('#require-website');
  const dedupInput = $('#dedup');
  const startBtn = $('#start-btn');
  const logEl = $('#log');

  const progressEl = $('#progress');
  const progressLabel = $('#progress-label');
  const progressCount = $('#progress-count');
  const progressFill = $('#progress-fill');
  const summaryEl = $('#summary');
  const sumOk = $('#sum-ok');
  const sumFail = $('#sum-fail');
  const sumTime = $('#sum-time');

  let running = false;

  function log(message, type = 'info') {
    const empty = logEl.querySelector('.log-empty');
    if (empty) empty.remove();
    const time = new Date().toLocaleTimeString('pt-BR');
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.innerHTML = `<span class="log-time">[${time}]</span><span class="log-msg"></span>`;
    line.querySelector('.log-msg').textContent = message;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setProgress(current, total, label) {
    progressEl.hidden = false;
    progressLabel.textContent = label || 'Processando…';
    progressCount.textContent = `${current} / ${total}`;
    progressFill.style.width = `${total > 0 ? (current / total) * 100 : 0}%`;
  }

  function fmtElapsed(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function lockUI(lock) {
    [queryInput, limitInput, minRatingInput, requirePhoneInput,
     requireWebsiteInput, dedupInput, startBtn].forEach((el) => el.disabled = lock);
    startBtn.textContent = lock ? 'Prospectando…' : 'Iniciar Prospecção';
  }

  function applyFilters(items, f) {
    return items.filter((it) => {
      const p = it.place || {};
      if (f.requirePhone && !p.telefone) return false;
      if (f.requireWebsite && !p.site) return false;
      if (f.minRating > 0 && (!p.rating || p.rating < f.minRating)) return false;
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
    if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function callProcessLead(item, query, dedup) {
    const res = await fetch('/api/process-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: item.link, query, place: item.place, dedup })
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

    log(`🔎 Buscando: "${query}" (até ${filters.limit})`, 'info');

    let searchResult;
    try { searchResult = await callSearch(query, filters.limit); }
    catch (err) {
      log(`❌ ${err.message}`, 'error');
      lockUI(false); running = false; return;
    }

    const rawItems = searchResult.results || [];
    log(`✓ ${rawItems.length} negócios encontrados.`, 'success');
    const items = applyFilters(rawItems, filters);
    const filteredOut = rawItems.length - items.length;
    if (filteredOut > 0) log(`${filteredOut} descartado(s) pelos filtros.`, 'muted');
    if (items.length === 0) {
      log('Nenhum lead passou nos filtros.', 'warn');
      lockUI(false); running = false; return;
    }
    log(`▸ ${items.length} entrando na fila.`, 'info');

    let ok = 0, fail = 0, duplicated = 0;
    setProgress(0, items.length);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const idx = i + 1;
      const nome = item.place?.nome || item.link;
      log(`[${idx}/${items.length}] ${nome}`, 'info');
      try {
        const result = await callProcessLead(item, query, filters.dedup);
        if (result.success) {
          ok++;
          log(`  ✓ Card criado → ${result.trello?.url || 'Trello'}`, 'success');
        } else if (result.stage === 'dedup') {
          duplicated++;
          log('  ↻ Duplicado — pulado.', 'muted');
        } else {
          fail++;
          log(`  ⚠ ${result.error || result.reason}`, 'warn');
        }
      } catch (err) {
        fail++;
        log(`  ❌ ${err.message}`, 'error');
      }
      setProgress(idx, items.length);
    }
    const elapsed = Date.now() - startedAt;
    setProgress(items.length, items.length, 'Concluído');
    log(`🏁 ${ok} criado(s), ${duplicated} duplicado(s), ${fail} falha(s) em ${fmtElapsed(elapsed)}.`, 'success');

    sumOk.textContent = ok;
    sumFail.textContent = fail + duplicated;
    sumTime.textContent = fmtElapsed(elapsed);
    summaryEl.hidden = false;

    lockUI(false); running = false;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (running) return;
    if (queryInput.value.trim().length < 3) {
      log('Termo com pelo menos 3 caracteres.', 'warn'); return;
    }
    runProspect();
  });

  $('#clear-log').addEventListener('click', () => {
    if (running) return;
    logEl.innerHTML = '<div class="log-empty">Aguardando o início de uma busca.</div>';
    summaryEl.hidden = true;
    progressEl.hidden = true;
    progressFill.style.width = '0%';
  });

  /* ============================================================
     Boot
     ============================================================ */
  loadDashboard();
})();
