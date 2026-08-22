let token = null;
let currentOrg = null;

const orgInput = document.getElementById('org');
const authSection = document.getElementById('authSection');
const authStatusEl = document.getElementById('authStatus');
const mainUI = document.getElementById('mainUI');
const valueLabel = document.getElementById('valueLabel');
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
  const urlOrder = params.get('Order') || params.get('OrderId');
  const urlOlpn = params.get('Olpn') || params.get('OlpnId');

  if (urlOlpn && urlOlpn.trim()) {
    window.urlMode = 'olpn';
    window.urlValue = urlOlpn.trim();
  } else if (urlOrder && urlOrder.trim()) {
    window.urlMode = 'order';
    window.urlValue = urlOrder.trim();
  }
  return urlOrg && urlOrg.trim() ? urlOrg.trim() : null;
}

function enterMainUI() {
  hideAuthStatus();
  authSection.style.display = 'none';
  mainUI.style.display = 'block';

  if (window.urlMode && window.urlValue) {
    if (window.urlMode === 'olpn') document.getElementById('modeOlpn').checked = true;
    else document.getElementById('modeOrder').checked = true;
    updateValueLabel();
    valueInput.value = window.urlValue;
    const mode = window.urlMode;
    const value = window.urlValue;
    window.urlMode = null;
    window.urlValue = null;
    setTimeout(() => runSearch(mode, value), 300);
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

function updateValueLabel() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode === 'order') {
    valueLabel.textContent = 'Order ID:';
    valueInput.placeholder = 'Enter an Order ID';
  } else {
    valueLabel.textContent = 'oLPN ID:';
    valueInput.placeholder = 'Enter an oLPN ID';
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
  countsRow.innerHTML = [
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
        escapeHtml(row.InstructionText),
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

async function runSearch(mode, value) {
  hideStatus();
  resultsEl.style.display = 'none';
  if (!value) {
    showStatus('Enter a value to search for', 'error');
    return;
  }

  showStatus('Searching...', 'info');
  searchBtn.disabled = true;
  try {
    const res = await apiCall('search', { org: currentOrg, mode, value });
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
      showStatus('Search completed — no instructions found for this ' + (mode === 'order' ? 'order' : 'oLPN') + '.', 'warn');
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
  if (e.key === 'Enter') {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    runSearch(mode, valueInput.value.trim());
  }
});
searchBtn.addEventListener('click', () => {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  runSearch(mode, valueInput.value.trim());
});
document.getElementById('modeOrder').addEventListener('change', updateValueLabel);
document.getElementById('modeOlpn').addEventListener('change', updateValueLabel);

init();
