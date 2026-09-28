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
    `<span class="badge bg-primary">Instructions found: ${c.instructions ?? 0}</span>`
  ].join('');

  if (!res.instructions || res.instructions.length === 0) {
    resultsBody.innerHTML = `<tr><td colspan="15" class="text-muted text-center py-3">No instructions found.</td></tr>`;
  } else {
    for (const row of res.instructions) {
      const tr = document.createElement('tr');
      tr.innerHTML = [
        row.Sequence,
        escapeHtml(row.InstructionType),
        '', // Instruction cell — filled by renderInstructionCell below
        escapeHtml(row.OrderId),
        escapeHtml(row.OrderLineId),
        escapeHtml(row.ItemId),
        escapeHtml(row.OlpnId),
        escapeHtml(row.OlpnStatus),
        escapeHtml(row.OlpnDetailId),
        escapeHtml(row.TaskId),
        escapeHtml(row.TaskDetailId),
        escapeHtml(row.TaskDetailStatus),
        escapeHtml(row.InstructionRequestorTypeId),
        escapeHtml(row.InstructionRequestorId),
        escapeHtml(row.Process)
      ].map((v) => `<td>${v == null || v === '' ? '&mdash;' : v}</td>`).join('');
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
  resultsEl.style.display = 'block';
}

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
    cell.querySelector('.delete-instruction-btn').addEventListener('click', () => openDeleteModal(cell));
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
let pendingDeleteCell = null;

function openDeleteModal(cell) {
  pendingDeleteCell = cell;
  deleteModalText.textContent = cell.dataset.text || '(no text)';
  deleteModalError.style.display = 'none';
  deleteConfirmBtn.disabled = deleteCancelBtn.disabled = false;
  deleteConfirmBtn.innerHTML = '<i class="fas fa-trash-alt"></i> Delete';
  deleteModal.style.display = 'flex';
  deleteCancelBtn.focus();
}

function closeDeleteModal() {
  if (deleteConfirmBtn.disabled && pendingDeleteCell) return; // delete in flight
  deleteModal.style.display = 'none';
  pendingDeleteCell = null;
}

async function confirmDelete() {
  const cell = pendingDeleteCell;
  if (!cell) return;
  deleteConfirmBtn.disabled = deleteCancelBtn.disabled = true;
  deleteConfirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';
  try {
    const res = await apiCall('delete_instruction', { org: currentOrg, pk: cell.dataset.pk });
    if (!res.success) {
      if (res.tokenInvalid) {
        pendingDeleteCell = null;
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
    // Remove every row carrying this PK and keep the count badge honest.
    document.querySelectorAll('td.instruction-cell').forEach((c) => {
      if (c.dataset.pk === cell.dataset.pk) c.closest('tr').remove();
    });
    const remaining = resultsBody.querySelectorAll('td.instruction-cell').length;
    const countBadge = countsRow.querySelector('.bg-primary');
    if (countBadge) countBadge.textContent = `Instructions found: ${remaining}`;
    if (remaining === 0) {
      resultsBody.innerHTML = `<tr><td colspan="15" class="text-muted text-center py-3">No instructions found.</td></tr>`;
    }
    pendingDeleteCell = null;
    deleteModal.style.display = 'none';
    showStatus(`Instruction deleted: "${res.deletedText}"`, 'success');
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
  if (e.key === 'Escape' && deleteModal.style.display === 'flex') closeDeleteModal();
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
      document.querySelectorAll('td.instruction-cell').forEach((c) => {
        if (c.dataset.pk === cell.dataset.pk) renderInstructionCell(c, res.instructionText);
      });
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
