let token = null;
let currentOrg = null;

const orgInput = document.getElementById('org');
const authSection = document.getElementById('authSection');
const authStatusEl = document.getElementById('authStatus');
const mainUI = document.getElementById('mainUI');
const valueInput = document.getElementById('valueInput');
const searchBtn = document.getElementById('searchBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const resultsBody = document.getElementById('resultsBody');
const countsRow = document.querySelector('.counts-row');
const unmatchedSection = document.getElementById('unmatchedSection');
const unmatchedList = document.getElementById('unmatchedList');
const rawOutput = document.getElementById('rawOutput');
const addBar = document.getElementById('addBar');
let lastSearchValue = null;
let lastResult = null; // last search response; edits/deletes/reorders update it and re-render

function showAuthStatus(message, type) {
  authStatusEl.textContent = message;
  authStatusEl.className = `status ${type}`;
  authStatusEl.style.display = 'block';
}
function hideAuthStatus() { authStatusEl.style.display = 'none'; }

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.style.display = 'block';
}
function hideStatus() { statusEl.style.display = 'none'; }

async function apiCall(action, data = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch('/api/validate', {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, ...data })
  }).then((r) => r.json());
}

function parseUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const urlOrg = params.get('Organization') || params.get('ORG') || params.get('org');
  // Order/Olpn (and their *Id forms) are kept for existing links; all of
  // them now feed the same Order-first, then-oLPN search.
  const urlValue = params.get('Id') || params.get('Order') || params.get('OrderId') || params.get('Olpn') || params.get('OlpnId');
  if (urlValue && urlValue.trim()) window.urlValue = urlValue.trim();
  return urlOrg && urlOrg.trim() ? urlOrg.trim() : null;
}

function enterMainUI() {
  hideAuthStatus();
  authSection.style.display = 'none';
  mainUI.style.display = 'block';

  if (window.urlValue) {
    const value = window.urlValue;
    valueInput.value = value;
    window.urlValue = null;
    setTimeout(() => runSearch(value), 300);
  }
}

// On load: check for a usable .token file before ever showing the ORG
// prompt. If it exists and hasn't expired, auth passes silently.
async function init() {
  apiCall('app_opened').catch(() => {});

  const urlOrg = parseUrlParams();

  const status = await apiCall('token_status');
  if (status.success) {
    token = status.token;
    currentOrg = String(status.org).toUpperCase();
    orgInput.value = currentOrg;
    enterMainUI();
    return;
  }

  // No usable saved token — fall back to the ORG/password prompt, either
  // auto-submitted from a URL param or left for the user to fill in.
  if (urlOrg) {
    orgInput.value = urlOrg;
    authenticate();
  }
}

async function authenticate() {
  const org = orgInput.value.trim();
  if (!org) {
    showAuthStatus('ORG required', 'error');
    return;
  }

  showAuthStatus('Authenticating...', 'info');

  try {
    const res = await apiCall('auth', { org });
    if (!res.success) {
      showAuthStatus(res.error || 'Authentication failed', 'error');
      mainUI.style.display = 'none';
      return;
    }

    token = res.token;
    currentOrg = org.toUpperCase();
    enterMainUI();
  } catch (error) {
    console.error('Authentication error:', error);
    showAuthStatus('Authentication failed', 'error');
    mainUI.style.display = 'none';
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderResults(res) {
  resultsBody.innerHTML = '';
  unmatchedList.innerHTML = '';
  rawOutput.textContent = '';

  const c = res.counts || {};
  const matchedAs = res.mode === 'order' ? 'Order' : 'oLPN';
  countsRow.innerHTML = [
    `<span class="badge bg-info text-dark">Matched as: ${matchedAs}${res.fellBackToOlpn ? ' (no matching order)' : ''}</span>`,
    `<span class="badge bg-secondary">Task details: ${c.taskDetails ?? 0}</span>`,
    `<span class="badge bg-secondary">oLPNs checked: ${c.olpnsLooked ?? 0}</span>`,
    `<span class="badge bg-secondary">Requestor IDs: ${c.requestorIds ?? 0}</span>`,
    (c.olpnsExcludedCancelled ? `<span class="badge bg-warning text-dark">oLPNs excluded (Cancelled): ${c.olpnsExcludedCancelled}</span>` : ''),
    `<span class="badge bg-primary">Instructions found: ${c.instructions ?? 0}</span>`,
    (c.vasServices ? `<span class="badge bg-success">VAS services: ${c.vasServices}</span>` : '')
  ].join('');

  if (!res.instructions || res.instructions.length === 0) {
    resultsBody.innerHTML = `<tr><td colspan="15" class="text-muted text-center py-3">No instructions found.</td></tr>`;
  } else {
    res.instructions.sort(compareInstructionRows);
    const groups = new Map(); // groupKey -> ordered, de-duplicated PKs
    for (const row of res.instructions) {
      const key = groupKey(row);
      if (!groups.has(key)) groups.set(key, []);
      const pk = String(row.PK);
      if (row.PK != null && !groups.get(key).includes(pk)) groups.get(key).push(pk);
    }

    let prevKey = null;
    for (const row of res.instructions) {
      const key = groupKey(row);
      if (key !== prevKey) resultsBody.appendChild(groupLabelRow(row, groups.get(key).length));
      prevKey = key;
      const tr = document.createElement('tr');
      // Header-level instructions apply to the whole oLPN, not one line.
      const headerLabel = '<span class="header-label">Header</span>';
      tr.innerHTML = [
        '', // Seq cell — filled by renderSequenceCell below
        escapeHtml(row.InstructionType),
        '', // Instruction cell — filled by renderInstructionCell below
        escapeHtml(row.OrderId),
        row.IsHeader ? headerLabel : escapeHtml(row.OrderLineId),
        escapeHtml(row.ItemId),
        escapeHtml(row.OlpnId),
        escapeHtml(row.OlpnStatus),
        row.IsHeader ? headerLabel : escapeHtml(row.OlpnDetailId),
        escapeHtml(row.TaskId),
        escapeHtml(row.TaskDetailId),
        escapeHtml(row.TaskDetailStatus),
        escapeHtml(row.InstructionRequestorTypeId),
        escapeHtml(row.InstructionRequestorId),
        escapeHtml(row.Process)
      ].map((v) => `<td>${v == null || v === '' ? '&mdash;' : v}</td>`).join('');
      renderSequenceCell(tr.children[0], row, groups.get(key));
      const instructionCell = tr.children[2];
      instructionCell.classList.add('instruction-cell');
      instructionCell.dataset.pk = row.PK != null ? String(row.PK) : '';
      renderInstructionCell(instructionCell, row.InstructionText);
      resultsBody.appendChild(tr);
    }
  }

  const u = res.unmatched || {};
  const items = [];
  for (const olpnId of u.olpnsNotFound || []) {
    items.push(`oLPN <strong>${escapeHtml(olpnId)}</strong> referenced by a task detail, but not found by oLPN search.`);
  }
  for (const o of u.olpnsExcludedCancelled || []) {
    items.push(`oLPN <strong>${escapeHtml(o.olpnId)}</strong> is Cancelled (Status ${escapeHtml(o.status)}) — excluded from results (likely left over from an earlier wave/unwave).`);
  }
  for (const d of u.olpnDetailsNoInstruction || []) {
    items.push(`oLPN <strong>${escapeHtml(d.olpnId)}</strong> / detail <strong>${escapeHtml(d.olpnDetailId)}</strong> has an assigned-instruction requestor but no matching runtime instruction row was returned.`);
  }
  for (const td of u.taskDetailsNoOlpnFound || []) {
    items.push(`Task ${escapeHtml(td.TaskId)} / detail ${escapeHtml(td.TaskDetailId)} references oLPN <strong>${escapeHtml(td.OlpnId)}</strong>, which could not be found.`);
  }
  if (items.length > 0) {
    unmatchedSection.style.display = 'block';
    unmatchedList.innerHTML = items.map((i) => `<li>${i}</li>`).join('');
  } else {
    unmatchedSection.style.display = 'none';
  }

  rawOutput.textContent = JSON.stringify(res.raw || {}, null, 2);
  renderVas(res.vasServices || []);
  renderAddBar(res.activeOlpns || []);
  resultsEl.style.display = 'block';
}

// Row order — keep in sync with compareInstructionRows in api/validate.js.
// Per oLPN: header first, then details by number; Pick before Pack; then
// Sequence. Each reorderable group is therefore contiguous.
const INSTRUCTION_TYPE_ORDER = { Pick: 0, Pack: 1 };
function compareInstructionRows(a, b) {
  if (a.OlpnId !== b.OlpnId) return String(a.OlpnId).localeCompare(String(b.OlpnId));
  if (a.IsHeader !== b.IsHeader) return a.IsHeader ? -1 : 1;
  if (a.OlpnDetailId !== b.OlpnDetailId) {
    return String(a.OlpnDetailId).localeCompare(String(b.OlpnDetailId), undefined, { numeric: true });
  }
  if (a.InstructionType !== b.InstructionType) {
    const ta = INSTRUCTION_TYPE_ORDER[a.InstructionType] ?? 9;
    const tb = INSTRUCTION_TYPE_ORDER[b.InstructionType] ?? 9;
    return ta !== tb ? ta - tb : String(a.InstructionType).localeCompare(String(b.InstructionType));
  }
  return (Number(a.Sequence) || 0) - (Number(b.Sequence) || 0);
}

// Full-width label above each group: oLPN · target · type (count).
function targetLabel(row) {
  if (row.IsHeader) return 'oLPN header';
  return `Detail ${escapeHtml(row.OlpnDetailId)}${row.ItemId ? ` – Item ${escapeHtml(row.ItemId)}` : ''}`;
}

function typeBadge(type) {
  const cls = type === 'Pick' ? 'type-pick' : type === 'Pack' ? 'type-pack' : 'type-vas';
  const icon = type === 'Pick' ? 'fa-hand-holding' : type === 'Pack' ? 'fa-box' : 'fa-tools';
  return `<span class="type-badge ${cls}"><i class="fas ${icon}"></i> ${escapeHtml(type)}</span>`;
}

function groupLabelRow(row, count) {
  const tr = document.createElement('tr');
  tr.className = 'group-label';
  tr.innerHTML = `<td colspan="15">${typeBadge(row.InstructionType)}` +
    `<span class="group-target">oLPN ${escapeHtml(row.OlpnId)} · ${targetLabel(row)}</span>` +
    `<span class="group-count">${count} instruction${count === 1 ? '' : 's'}</span></td>`;
  return tr;
}

// VAS services on the same oLPNs — read-only, shown below the Pick/Pack
// table, one card per service with its steps and step instructions.
function renderVas(services) {
  const section = document.getElementById('vasSection');
  const list = document.getElementById('vasList');
  if (!services || services.length === 0) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  document.getElementById('vasCount').textContent = services.length;
  list.innerHTML = services.map((svc) => {
    const where = [
      `oLPN ${escapeHtml(svc.OlpnId)}`,
      targetLabel(svc),
      svc.OrderId ? `Order ${escapeHtml(svc.OrderId)}${svc.OrderLineId ? ` / line ${escapeHtml(svc.OrderLineId)}` : ''}` : ''
    ].filter(Boolean).join(' · ');
    const steps = (svc.Steps || []).map((st) => {
      const ctx = `data-svc="${escapeHtml(svc.PK)}" data-step="${escapeHtml(st.PK)}"`;
      const n = (st.Instructions || []).length;
      const items = (st.Instructions || []).map((i, idx) => `
        <li ${ctx} data-ins="${escapeHtml(i.PK)}">
          ${st.Editable && n > 1 ? `<span class="seq-arrows vas-arrows">` +
            `<button type="button" class="seq-btn" data-vas-action="up" title="Move up"${idx === 0 ? ' disabled' : ''}><i class="fas fa-caret-up"></i></button>` +
            `<button type="button" class="seq-btn" data-vas-action="down" title="Move down"${idx === n - 1 ? ' disabled' : ''}><i class="fas fa-caret-down"></i></button>` +
            `</span>` : ''}
          <span class="vas-ins-text">${escapeHtml(i.InstructionText)}</span>
          ${st.Editable ? `
            <button type="button" class="btn btn-link btn-sm p-0 ms-1 edit-instruction-btn" data-vas-action="edit" title="Edit VAS instruction text"><i class="fas fa-pencil-alt"></i></button><button type="button" class="btn btn-link btn-sm p-0 ms-2 delete-instruction-btn" data-vas-action="delete" title="Delete VAS instruction"><i class="fas fa-trash-alt"></i></button>` : ''}
        </li>`).join('');
      return `
      <li class="vas-step">
        <div><strong>${escapeHtml(st.StepDescription || 'Step')}</strong>
          <span class="vas-status">${escapeHtml(st.Status || '')}</span>
          ${st.RequestedQuantity != null ? `<span class="text-muted small">qty ${escapeHtml(st.CompletedQuantity ?? 0)}/${escapeHtml(st.RequestedQuantity)}</span>` : ''}
          ${st.Editable ? '' : '<span class="text-muted small"><i class="fas fa-lock"></i> read-only (only Created steps can be edited)</span>'}
        </div>
        <ol class="vas-instructions">${items || '<li class="text-muted small vas-empty">No instructions</li>'}</ol>
        ${st.Editable ? `<button type="button" class="btn btn-link btn-sm p-0 vas-add-btn" ${ctx} data-vas-action="add"><i class="fas fa-plus"></i> Add instruction</button>` : ''}
      </li>`;
    }).join('');
    return `
      <div class="vas-card">
        <div class="vas-card-head">
          ${typeBadge('VAS')}
          <span class="vas-name">${escapeHtml(svc.Description || svc.ProvidedServiceId)}</span>
          <span class="vas-status">${escapeHtml(svc.Status || '')}</span>
          <span class="group-target">${where}</span>
        </div>
        <ol class="vas-steps">${steps}</ol>
      </div>`;
  }).join('');
  section.style.display = 'block';
}

// ---- VAS step instructions: edit / add / delete ----
// Writes go through the backend's vas_* actions, which re-read the service,
// only touch Created services/steps, and verify the step's other
// instructions are unchanged. On success the step list in lastResult is
// replaced with the server's fresh copy and everything re-renders.
let vasBusy = false;

function applyVasSteps(servicePk, steps) {
  const svc = lastResult && (lastResult.vasServices || []).find((v) => String(v.PK) === String(servicePk));
  if (svc && steps) svc.Steps = steps;
  if (lastResult) renderResults(lastResult);
}

function vasInstructionText(servicePk, stepPk, pk) {
  const svc = lastResult && (lastResult.vasServices || []).find((v) => String(v.PK) === String(servicePk));
  const step = svc && svc.Steps.find((s) => String(s.PK) === String(stepPk));
  const ins = step && step.Instructions.find((i) => String(i.PK) === String(pk));
  return ins ? ins.InstructionText : '';
}

// Inline text editor inside `host`; resolves with the trimmed text, or
// null when cancelled. With `positionCount` (n existing instructions) it
// also shows a Position dropdown 1..n+1 (default last) and resolves with
// { text, position } instead.
function inlineTextEditor(host, initial, placeholder, positionCount) {
  return new Promise((resolve) => {
    const n = positionCount;
    const positions = n == null ? '' :
      `<select class="form-select form-select-sm vas-position" title="Position" style="width: auto;">` +
      Array.from({ length: n + 1 }, (_, k) => {
        const i = k + 1;
        const note = n === 0 ? '' : i === 1 ? ' (first)' : i === n + 1 ? ' (last)' : '';
        return `<option value="${i}"${i === n + 1 ? ' selected' : ''}>${i}${note}</option>`;
      }).join('') + `</select>`;
    host.innerHTML = `
      <div class="d-flex gap-1 align-items-center instruction-editor">
        ${positions}
        <input type="text" class="form-control form-control-sm" maxlength="500" placeholder="${placeholder || ''}" />
        <button type="button" class="btn btn-success btn-sm save-btn" title="Save"><i class="fas fa-check"></i></button>
        <button type="button" class="btn btn-outline-secondary btn-sm cancel-btn" title="Cancel"><i class="fas fa-times"></i></button>
      </div>`;
    const input = host.querySelector('input');
    input.value = initial || '';
    input.focus();
    input.select();
    const done = (v) => {
      host.querySelectorAll('input, button, select').forEach((el) => { el.disabled = true; });
      if (v !== null) host.querySelector('.save-btn').innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      resolve(v);
    };
    host.querySelector('.save-btn').addEventListener('click', () => {
      const v = input.value.trim();
      if (!v) { showStatus('Instruction text cannot be empty.', 'error'); return; }
      done(n == null ? v : { text: v, position: Number(host.querySelector('.vas-position').value) });
    });
    host.querySelector('.cancel-btn').addEventListener('click', () => done(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') host.querySelector('.save-btn').click();
      else if (e.key === 'Escape') { e.stopPropagation(); done(null); }
    });
  });
}

// Inline "add VAS instruction" editor: Instruction (standard ones for this
// step not already on it, or Custom text), Position 1..n+1 and text.
// Resolves { instructionId|null, text, position } or null when cancelled.
function vasAddEditor(host, n, choices) {
  return new Promise((resolve) => {
    const opts = ['<option value="">— Select an instruction —</option>']
      .concat(choices.map((c) => `<option value="std:${escapeHtml(c.id).replace(/"/g, '&quot;')}">${escapeHtml(c.text || c.id)}</option>`))
      .concat(['<option value="custom">Custom text…</option>']);
    const positions = Array.from({ length: n + 1 }, (_, k) => {
      const i = k + 1;
      const note = n === 0 ? '' : i === 1 ? ' (first)' : i === n + 1 ? ' (last)' : '';
      return `<option value="${i}"${i === n + 1 ? ' selected' : ''}>${i}${note}</option>`;
    }).join('');
    host.innerHTML = `
      <div class="vas-add-editor">
        <div class="d-flex gap-1 align-items-center mb-1">
          <select class="form-select form-select-sm vas-choice">${opts.join('')}</select>
          <select class="form-select form-select-sm vas-position" title="Position" style="width: auto;">${positions}</select>
        </div>
        <div class="d-flex gap-1 align-items-center instruction-editor">
          <input type="text" class="form-control form-control-sm" maxlength="500" placeholder="Choose an instruction above, or Custom text" />
          <button type="button" class="btn btn-success btn-sm save-btn" title="Save" disabled><i class="fas fa-check"></i></button>
          <button type="button" class="btn btn-outline-secondary btn-sm cancel-btn" title="Cancel"><i class="fas fa-times"></i></button>
        </div>
      </div>`;
    const choice = host.querySelector('.vas-choice');
    const input = host.querySelector('input');
    const saveBtn = host.querySelector('.save-btn');
    const sync = () => { saveBtn.disabled = !choice.value || !input.value.trim(); };
    choice.addEventListener('change', () => {
      if (choice.value.startsWith('std:')) {
        const c = choices.find((x) => x.id === choice.value.slice(4));
        input.value = c ? c.text : '';
      } else {
        input.value = '';
      }
      sync();
      if (choice.value) input.focus();
    });
    input.addEventListener('input', sync);
    choice.focus();
    const done = (v) => {
      host.querySelectorAll('input, button, select').forEach((el) => { el.disabled = true; });
      if (v !== null) saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      resolve(v);
    };
    saveBtn.addEventListener('click', () => {
      if (saveBtn.disabled) return;
      done({
        instructionId: choice.value.startsWith('std:') ? choice.value.slice(4) : null,
        text: input.value.trim(),
        position: Number(host.querySelector('.vas-position').value)
      });
    });
    host.querySelector('.cancel-btn').addEventListener('click', () => done(null));
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === input) saveBtn.click();
      else if (e.key === 'Escape') { e.stopPropagation(); done(null); }
    });
  });
}

// Standard instructions per VAS type + step, loaded on first use.
const vasCatalogCache = new Map();
async function loadVasStepCatalog(providedServiceId, stepId) {
  const key = `${providedServiceId}|${stepId}`;
  if (vasCatalogCache.has(key)) return vasCatalogCache.get(key);
  const res = await apiCall('vas_step_catalog', { org: currentOrg, providedServiceId, stepId });
  if (res.success) vasCatalogCache.set(key, res);
  return res;
}

async function runVasWrite(action, payload, successMessage) {
  vasBusy = true;
  try {
    const res = await apiCall(action, { org: currentOrg, ...payload });
    if (!res.success) {
      if (res.tokenInvalid) { handleTokenInvalid(); return res; }
      // Stale page or uncertain outcome: reload so the cards show MAWM's
      // real state; otherwise just drop the editor and keep current data.
      if (res.stale && lastSearchValue) await runSearch(lastSearchValue);
      else if (lastResult) renderResults(lastResult);
      showStatus(res.error || 'VAS change failed', 'error');
      return res;
    }
    if (res.steps) applyVasSteps(payload.servicePk, res.steps);
    showStatus(successMessage(res), 'success');
    return res;
  } catch (error) {
    console.error('VAS write error:', error);
    if (lastResult) renderResults(lastResult);
    showStatus(error.message || 'VAS change failed', 'error');
    return { success: false, error: error.message };
  } finally {
    vasBusy = false;
  }
}

async function onVasAction(btn) {
  if (vasBusy) return;
  const action = btn.dataset.vasAction;
  const host = btn.closest('[data-step]');
  const servicePk = host.dataset.svc;
  const stepPk = host.dataset.step;

  if (action === 'up' || action === 'down') {
    // Saves immediately, like the Pick/Pack arrows: one save renumbers the step.
    const svc = (lastResult.vasServices || []).find((v) => String(v.PK) === servicePk);
    const step = svc && svc.Steps.find((s) => String(s.PK) === stepPk);
    if (!step) return;
    const pks = step.Instructions.map((i) => String(i.PK));
    const i = pks.indexOf(btn.closest('li[data-ins]').dataset.ins);
    const j = i + (action === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= pks.length) return;
    [pks[i], pks[j]] = [pks[j], pks[i]];
    document.querySelectorAll('#vasList [data-vas-action]').forEach((b) => { b.disabled = true; });
    showStatus('Saving new order...', 'info');
    await runVasWrite('vas_resequence_instructions', { servicePk, stepPk, pks },
      (res) => `Reordered VAS instructions on step "${res.stepDescription || step.StepDescription}".`);
  } else if (action === 'edit') {
    const li = btn.closest('li[data-ins]');
    const pk = li.dataset.ins;
    const original = vasInstructionText(servicePk, stepPk, pk);
    const text = await inlineTextEditor(li, original);
    if (text === null || text === original) { if (lastResult) renderResults(lastResult); return; }
    await runVasWrite('vas_update_instruction', { servicePk, stepPk, instructionPk: pk, instructionText: text },
      (res) => `VAS instruction updated: "${res.previousText}" → "${res.instructionText}"`);
  } else if (action === 'delete') {
    const pk = btn.closest('li[data-ins]').dataset.ins;
    openDeleteModal({
      text: vasInstructionText(servicePk, stepPk, pk),
      run: async () => {
        const res = await apiCall('vas_delete_instruction', { org: currentOrg, servicePk, stepPk, instructionPk: pk });
        if (res.success) {
          applyVasSteps(servicePk, res.steps);
          res.message = res.warning || `VAS instruction deleted: "${res.deletedText}"`;
        }
        return res;
      }
    });
  } else if (action === 'add') {
    const list = btn.parentElement.querySelector('.vas-instructions');
    const empty = list.querySelector('.vas-empty');
    if (empty) empty.remove();
    const li = document.createElement('li');
    list.appendChild(li);
    btn.style.display = 'none';
    const svc = (lastResult.vasServices || []).find((v) => String(v.PK) === servicePk);
    const step = svc && svc.Steps.find((s) => String(s.PK) === stepPk);
    li.innerHTML = '<span class="text-muted small"><i class="fas fa-spinner fa-spin"></i> Loading standard instructions…</span>';
    vasBusy = true;
    let catalog;
    try {
      catalog = await loadVasStepCatalog(svc.ProvidedServiceId, step.AssignedServiceStepId);
    } finally {
      vasBusy = false;
    }
    if (!catalog.success) {
      if (catalog.tokenInvalid) { handleTokenInvalid(); return; }
      showStatus(`${catalog.error || 'Could not load standard instructions'} — only custom text is available.`, 'warn');
    }
    // Offer only standard instructions not already on the step.
    const onStep = new Set(step.Instructions.map((i) => i.AssignedServiceStepInstructionId));
    const choices = (catalog.instructions || []).filter((c) => !onStep.has(c.id));
    const entry = await vasAddEditor(li, step.Instructions.length, choices);
    if (entry === null) { if (lastResult) renderResults(lastResult); return; }
    const res = await runVasWrite('vas_create_instruction', { servicePk, stepPk, instructionText: entry.text, position: entry.position, instructionId: entry.instructionId },
      (r) => `VAS instruction added at position ${r.position || entry.position}: "${r.instructionText}"`);
    if (res && res.success && res.warning) showStatus(res.warning, 'warn');
  }
}

document.getElementById('vasList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-vas-action]');
  if (btn) onVasAction(btn);
});

// Sequence only matters within one oLPN + target (header or one detail) +
// InstructionType.
function groupKey(row) {
  return [row.OlpnId, row.InstructionRequestorTypeId, row.InstructionRequestorId, row.InstructionType].join('|');
}

// Seq number, plus up/down arrows when the group has more than one row.
function renderSequenceCell(cell, row, groupPks) {
  cell.classList.add('seq-cell');
  const seq = row.Sequence == null || row.Sequence === '' ? '&mdash;' : escapeHtml(row.Sequence);
  const pk = String(row.PK);
  const i = groupPks ? groupPks.indexOf(pk) : -1;
  if (!groupPks || groupPks.length < 2 || i < 0) {
    cell.innerHTML = seq;
    return;
  }
  cell.innerHTML =
    `<span class="seq-num">${seq}</span>` +
    `<span class="seq-arrows">` +
    `<button type="button" class="seq-btn" data-dir="-1" title="Move up"${i === 0 ? ' disabled' : ''}><i class="fas fa-caret-up"></i></button>` +
    `<button type="button" class="seq-btn" data-dir="1" title="Move down"${i === groupPks.length - 1 ? ' disabled' : ''}><i class="fas fa-caret-down"></i></button>` +
    `</span>`;
  cell.querySelectorAll('.seq-btn').forEach((btn) => {
    btn.addEventListener('click', () => moveInstruction(row, groupPks, Number(btn.dataset.dir)));
  });
}

let reorderBusy = false;

// Saves immediately: swaps the row with its neighbour, and the backend
// renumbers the whole group 1..n (only changed rows are written).
async function moveInstruction(row, groupPks, dir) {
  if (reorderBusy) return;
  const pks = [...groupPks];
  const i = pks.indexOf(String(row.PK));
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pks.length) return;
  [pks[i], pks[j]] = [pks[j], pks[i]];

  reorderBusy = true;
  document.querySelectorAll('.seq-btn').forEach((b) => { b.disabled = true; });
  showStatus('Saving new order...', 'info');
  try {
    const res = await apiCall('resequence_instructions', { org: currentOrg, olpnId: row.OlpnId, pks });
    if (!res.success) {
      if (res.tokenInvalid) { handleTokenInvalid(); return; }
      // A partial save or a stale page: reload so the table shows MAWM's
      // real order, then report the problem.
      if ((res.partial || res.stale) && lastSearchValue) await runSearch(lastSearchValue);
      else if (lastResult) renderResults(lastResult);
      showStatus(res.error || 'Reorder failed', 'error');
      return;
    }
    const newSeq = new Map(res.sequences.map((x) => [String(x.pk), x.sequence]));
    for (const r of lastResult.instructions) {
      if (newSeq.has(String(r.PK))) r.Sequence = newSeq.get(String(r.PK));
    }
    renderResults(lastResult);
    showStatus(`Reordered ${res.instructionType} instructions on oLPN ${row.OlpnId} / ${res.target}.`, 'success');
  } catch (error) {
    console.error('Reorder error:', error);
    if (lastSearchValue) await runSearch(lastSearchValue);
    showStatus(error.message || 'Reorder failed', 'error');
  } finally {
    reorderBusy = false;
  }
}

// One "Add instruction" button per active oLPN in the results — including
// oLPNs that have no instructions yet.
function renderAddBar(olpns) {
  addBar.innerHTML = '';
  for (const o of olpns) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-outline-primary btn-sm';
    btn.innerHTML = `<i class="fas fa-plus"></i> Add instruction to oLPN ${escapeHtml(o.olpnId)}`;
    btn.addEventListener('click', () => openCreateModal(o.olpnId));
    addBar.appendChild(btn);
  }
}

// ---- Create instruction modal ----
const createModal = document.getElementById('createModal');
const createOlpnIdEl = document.getElementById('createOlpnId');
const createLoading = document.getElementById('createLoading');
const createForm = document.getElementById('createForm');
const createTarget = document.getElementById('createTarget');
const createType = document.getElementById('createType');
const createSeq = document.getElementById('createSeq');
const createText = document.getElementById('createText');
const createInstructionId = document.getElementById('createInstructionId');
const createModalError = document.getElementById('createModalError');
const createConfirmBtn = document.getElementById('createConfirmBtn');
const createCancelBtn = document.getElementById('createCancelBtn');
let createState = null; // { olpnId, targets, busy }

function showCreateError(msg) {
  createModalError.textContent = msg;
  createModalError.style.display = 'block';
}

async function openCreateModal(olpnId) {
  createState = { olpnId, targets: [], busy: false };
  createOlpnIdEl.textContent = olpnId;
  createModalError.style.display = 'none';
  createLoading.style.display = 'block';
  createForm.style.display = 'none';
  createConfirmBtn.disabled = true;
  createConfirmBtn.innerHTML = '<i class="fas fa-plus"></i> Create';
  createCancelBtn.disabled = false;
  createText.value = '';
  createType.value = 'Pick';
  createInstructionId.innerHTML = '';
  createModal.style.display = 'flex';

  try {
    const [res, catalog] = await Promise.all([
      apiCall('olpn_targets', { org: currentOrg, olpnId }),
      loadInstructionCatalog()
    ]);
    if (!createState || createState.olpnId !== olpnId) return; // closed meanwhile
    createLoading.style.display = 'none';
    if (!res.success || !catalog.success) {
      if (res.tokenInvalid || catalog.tokenInvalid) { closeCreateModal(true); handleTokenInvalid(); return; }
      showCreateError((!res.success ? res.error : catalog.error) || 'Could not load oLPN details');
      return;
    }
    createInstructionId.innerHTML =
      '<option value="">— Select an instruction —</option>' +
      catalog.instructions.map((ins) => `<option value="${escapeHtml(ins.id).replace(/"/g, '&quot;')}">${escapeHtml(ins.id)}</option>`).join('');
    createInstructionId.value = '';
    createState.targets = res.targets;
    createTarget.innerHTML = res.targets.map((t, i) =>
      `<option value="${i}">${escapeHtml(t.label)}${t.existingCount ? ` (${t.existingCount} existing)` : ''}</option>`
    ).join('');
    // Default to the first detail when there's exactly one — the common case.
    const details = res.targets.filter((t) => t.type === 'OlpnDetail');
    createTarget.value = details.length === 1 ? String(res.targets.indexOf(details[0])) : '0';
    syncCreateSequence();
    createForm.style.display = 'block';
    syncCreateButton(); // stays disabled until an Instruction ID is chosen
    createInstructionId.focus();
  } catch (error) {
    createLoading.style.display = 'none';
    showCreateError(error.message || 'Could not load oLPN details');
  }
}

// Master instruction list, loaded once per page (it rarely changes).
let instructionCatalog = null;
async function loadInstructionCatalog() {
  if (instructionCatalog) return { success: true, instructions: instructionCatalog };
  const res = await apiCall('instruction_catalog', { org: currentOrg });
  if (res.success) instructionCatalog = res.instructions;
  return res;
}

// Picking an Instruction ID fills in its default text; the user can still
// edit the text afterwards.
function syncCreateText() {
  const ins = (instructionCatalog || []).find((i) => i.id === createInstructionId.value);
  createText.value = ins ? ins.text : '';
  syncCreateButton();
}

// Create is only enabled once a valid (listed) Instruction ID is selected.
function syncCreateButton() {
  const valid = (instructionCatalog || []).some((i) => i.id === createInstructionId.value);
  createConfirmBtn.disabled = !valid || !!(createState && createState.busy);
}

// Sequences are numbered within target + type. With n existing, the new
// instruction can go at position 1..n+1 (default: last); the ones at and
// after that position move down by one.
function syncCreateSequence() {
  const t = createState && createState.targets[Number(createTarget.value)];
  const n = (t && t.countByType && t.countByType[createType.value]) || 0;
  const opts = [];
  for (let i = 1; i <= n + 1; i++) {
    const note = n === 0 ? '' : i === 1 ? ' (first)' : i === n + 1 ? ' (last)' : '';
    opts.push(`<option value="${i}">${i}${note}</option>`);
  }
  createSeq.innerHTML = opts.join('');
  createSeq.value = String(n + 1);
}

function closeCreateModal(force) {
  if (!force && createState && createState.busy) return; // create in flight
  createModal.style.display = 'none';
  createState = null;
}

async function confirmCreate() {
  if (!createState || createState.busy) return;
  const t = createState.targets[Number(createTarget.value)];
  const instructionId = createInstructionId.value;
  const text = createText.value.trim();
  const seq = Number(createSeq.value);
  if (!t) { showCreateError('Choose where to attach the instruction.'); return; }
  if (!instructionId) { showCreateError('Select an Instruction ID.'); createInstructionId.focus(); return; }
  if (!text) { showCreateError('Instruction text cannot be empty.'); createText.focus(); return; }
  if (!Number.isInteger(seq) || seq < 1) { showCreateError('Sequence must be a whole number of 1 or more.'); return; }

  createModalError.style.display = 'none';
  createState.busy = true;
  createConfirmBtn.disabled = createCancelBtn.disabled = true;
  createConfirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
  const olpnId = createState.olpnId;
  try {
    const res = await apiCall('create_instruction', {
      org: currentOrg,
      olpnId,
      targetType: t.type,
      olpnDetailId: t.olpnDetailId,
      instructionType: createType.value,
      instructionId,
      instructionText: text,
      sequence: seq
    });
    if (!res.success) {
      if (res.tokenInvalid) { closeCreateModal(true); handleTokenInvalid(); return; }
      createState.busy = false;
      createCancelBtn.disabled = false;
      syncCreateButton();
      createConfirmBtn.innerHTML = '<i class="fas fa-plus"></i> Create';
      showCreateError(res.error || 'Create failed');
      return;
    }
    closeCreateModal(true);
    // Re-run the search so the new row arrives fully joined (order, task...).
    if (lastSearchValue) await runSearch(lastSearchValue);
    if (res.renumberWarning) {
      showStatus(res.renumberWarning, 'warn');
    } else if (res.visibleOnOlpn) {
      showStatus(`Instruction created on oLPN ${olpnId} / ${res.target}: "${res.instructionText}"`, 'success');
    } else {
      showStatus(`Instruction "${res.instructionText}" was created (PK ${res.pk}), but oLPN ${olpnId} doesn't list it yet, so it may not appear in search results.`, 'warn');
    }
  } catch (error) {
    console.error('Create error:', error);
    if (createState) {
      createState.busy = false;
      createCancelBtn.disabled = false;
      syncCreateButton();
      createConfirmBtn.innerHTML = '<i class="fas fa-plus"></i> Create';
    }
    showCreateError(error.message || 'Create failed');
  }
}

createTarget.addEventListener('change', syncCreateSequence);
createType.addEventListener('change', syncCreateSequence);
createInstructionId.addEventListener('change', syncCreateText);
createConfirmBtn.addEventListener('click', confirmCreate);
createCancelBtn.addEventListener('click', () => closeCreateModal());
createModal.addEventListener('click', (e) => { if (e.target === createModal) closeCreateModal(); });
createText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !createConfirmBtn.disabled) confirmCreate(); });

// Instruction cell: text + pencil icon; clicking the pencil swaps in an
// inline editor that saves only InstructionText (by PK) via the backend.
function renderInstructionCell(cell, text) {
  cell.dataset.text = text == null ? '' : String(text);
  const canEdit = !!cell.dataset.pk;
  cell.innerHTML =
    `<span class="instruction-text">${text == null || text === '' ? '&mdash;' : escapeHtml(text)}</span>` +
    (canEdit
      ? ` <button type="button" class="btn btn-link btn-sm p-0 ms-1 edit-instruction-btn" title="Edit instruction text"><i class="fas fa-pencil-alt"></i></button>` +
        `<button type="button" class="btn btn-link btn-sm p-0 ms-2 delete-instruction-btn" title="Delete instruction"><i class="fas fa-trash-alt"></i></button>`
      : '');
  if (canEdit) {
    cell.querySelector('.edit-instruction-btn').addEventListener('click', () => openInstructionEditor(cell));
    cell.querySelector('.delete-instruction-btn').addEventListener('click', () => openDeleteModal({
      text: cell.dataset.text,
      run: async () => {
        const res = await apiCall('delete_instruction', { org: currentOrg, pk: cell.dataset.pk });
        if (res.success && lastResult) {
          // Drop every row carrying this PK and re-render (keeps counts and
          // reorder arrows correct).
          lastResult.instructions = lastResult.instructions.filter((r) => String(r.PK) !== cell.dataset.pk);
          // The backend renumbered the rest of the group to close the gap.
          const seqs = new Map((res.sequences || []).map((x) => [String(x.pk), x.sequence]));
          for (const r of lastResult.instructions) if (seqs.has(String(r.PK))) r.Sequence = seqs.get(String(r.PK));
          if (lastResult.counts) lastResult.counts.instructions = lastResult.instructions.length;
          renderResults(lastResult);
          res.message = res.renumberWarning || `Instruction deleted: "${res.deletedText}"`;
        }
        return res;
      }
    }));
  }
}

function handleTokenInvalid() {
  token = null;
  mainUI.style.display = 'none';
  authSection.style.display = 'block';
  showAuthStatus('Saved token expired or was rejected — please re-authenticate.', 'error');
}

// Delete confirmation modal (plain DOM, no Bootstrap JS — and never a native
// confirm(), which blocks the page).
const deleteModal = document.getElementById('deleteModal');
const deleteModalText = document.getElementById('deleteModalText');
const deleteModalError = document.getElementById('deleteModalError');
const deleteConfirmBtn = document.getElementById('deleteConfirmBtn');
const deleteCancelBtn = document.getElementById('deleteCancelBtn');
let pendingDelete = null; // { text, run } — run() performs the delete and returns the API result

function openDeleteModal(req) {
  pendingDelete = req;
  deleteModalText.textContent = req.text || '(no text)';
  deleteModalError.style.display = 'none';
  deleteConfirmBtn.disabled = deleteCancelBtn.disabled = false;
  deleteConfirmBtn.innerHTML = '<i class="fas fa-trash-alt"></i> Delete';
  deleteModal.style.display = 'flex';
  deleteCancelBtn.focus();
}

function closeDeleteModal() {
  if (deleteConfirmBtn.disabled && pendingDelete) return; // delete in flight
  deleteModal.style.display = 'none';
  pendingDelete = null;
}

async function confirmDelete() {
  const req = pendingDelete;
  if (!req) return;
  deleteConfirmBtn.disabled = deleteCancelBtn.disabled = true;
  deleteConfirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';
  try {
    const res = await req.run();
    if (!res.success) {
      if (res.tokenInvalid) {
        pendingDelete = null;
        deleteModal.style.display = 'none';
        handleTokenInvalid();
        return;
      }
      deleteModalError.textContent = res.error || 'Delete failed';
      deleteModalError.style.display = 'block';
      deleteConfirmBtn.disabled = deleteCancelBtn.disabled = false;
      deleteConfirmBtn.innerHTML = '<i class="fas fa-trash-alt"></i> Delete';
      return;
    }
    pendingDelete = null;
    deleteModal.style.display = 'none';
    showStatus(res.message || 'Deleted.', 'success');
  } catch (error) {
    console.error('Delete error:', error);
    deleteModalError.textContent = error.message || 'Delete failed';
    deleteModalError.style.display = 'block';
    deleteConfirmBtn.disabled = deleteCancelBtn.disabled = false;
    deleteConfirmBtn.innerHTML = '<i class="fas fa-trash-alt"></i> Delete';
  }
}

deleteConfirmBtn.addEventListener('click', confirmDelete);
deleteCancelBtn.addEventListener('click', closeDeleteModal);
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeDeleteModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (deleteModal.style.display === 'flex') closeDeleteModal();
  if (createModal.style.display === 'flex') closeCreateModal();
});

function openInstructionEditor(cell) {
  const original = cell.dataset.text;
  cell.innerHTML = `
    <div class="d-flex gap-1 align-items-center instruction-editor">
      <input type="text" class="form-control form-control-sm" maxlength="500" />
      <button type="button" class="btn btn-success btn-sm save-btn" title="Save"><i class="fas fa-check"></i></button>
      <button type="button" class="btn btn-outline-secondary btn-sm cancel-btn" title="Cancel"><i class="fas fa-times"></i></button>
    </div>`;
  const input = cell.querySelector('input');
  const saveBtn = cell.querySelector('.save-btn');
  const cancelBtn = cell.querySelector('.cancel-btn');
  input.value = original;
  input.focus();
  input.select();

  const cancel = () => renderInstructionCell(cell, original);
  const save = async () => {
    const newText = input.value.trim();
    if (!newText) {
      showStatus('Instruction text cannot be empty.', 'error');
      return;
    }
    if (newText === original) {
      cancel();
      return;
    }
    input.disabled = saveBtn.disabled = cancelBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    try {
      const res = await apiCall('update_instruction', { org: currentOrg, pk: cell.dataset.pk, instructionText: newText });
      if (!res.success) {
        if (res.tokenInvalid) {
          handleTokenInvalid();
          return;
        }
        showStatus(res.error || 'Update failed', 'error');
        input.disabled = saveBtn.disabled = cancelBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-check"></i>';
        return;
      }
      // Same PK can appear on more than one row — update them all.
      if (lastResult) {
        for (const r of lastResult.instructions) {
          if (String(r.PK) === cell.dataset.pk) r.InstructionText = res.instructionText;
        }
        renderResults(lastResult);
      }
      showStatus(`Instruction updated: "${res.previousText}" → "${res.instructionText}"`, 'success');
    } catch (error) {
      console.error('Update error:', error);
      showStatus(error.message || 'Update failed', 'error');
      input.disabled = saveBtn.disabled = cancelBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fas fa-check"></i>';
    }
  };

  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', cancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    else if (e.key === 'Escape') cancel();
  });
}

async function runSearch(value) {
  lastSearchValue = value;
  hideStatus();
  resultsEl.style.display = 'none';
  if (!value) {
    showStatus('Enter a value to search for', 'error');
    return;
  }

  showStatus('Searching...', 'info');
  searchBtn.disabled = true;
  try {
    const res = await apiCall('search', { org: currentOrg, mode: 'auto', value });
    if (!res.success) {
      if (res.tokenInvalid) {
        token = null;
        mainUI.style.display = 'none';
        authSection.style.display = 'block';
        showAuthStatus('Saved token expired or was rejected — please re-authenticate.', 'error');
      } else {
        showStatus(res.error || 'Search failed', 'error');
      }
      return;
    }
    hideStatus();
    lastResult = res;
    renderResults(res);
    if ((res.counts?.instructions ?? 0) === 0) {
      showStatus(res.fellBackToOlpn
        ? 'No matching order — searched as an oLPN, and no instructions were found.'
        : 'Search completed — no instructions found for this order.', 'warn');
    }
  } catch (error) {
    console.error('Search error:', error);
    showStatus(error.message || 'Search failed', 'error');
  } finally {
    searchBtn.disabled = false;
  }
}

orgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') authenticate();
});
valueInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch(valueInput.value.trim());
});
searchBtn.addEventListener('click', () => runSearch(valueInput.value.trim()));

init();
