// api/validate.js – Find Instructions (order/oLPN -> assigned Pick/Pack instructions)
//
// Endpoint evidence:
//   - /oauth/token, /pickpack/api/pickpack/olpn/search:
//     CONFIRMED across the mawm_api_library ecosystem (see Work/mawm_api_library/
//     _conventions/auth-conventions.md and olpn/api.md) and directly in
//     Work/taskcompletion/mawm_client.py (search_olpn).
//   - /task/api/task/task/search, queried with a `TaskDetail.<field>` dotted-path
//     filter and reading the nested TaskDetail[] array off each Task row:
//     CONFIRMED live against SS-DEMO in Work/taskcompletion/mawm_client.py
//     (search_task, search_task_id_for_container, search_task_id_for_olpn).
//     This corrects an unverified guess in the originating Glean report, which
//     proposed /pickpack/api/task/taskDetail/search instead.
//   - /pickpack/api/fw-aux-svcs/assignedInstruction/search and the
//     OlpnAndDetailsServiceRequestorIds / OlpnDetail.AssignedInstruction join:
//     taken from the supplied Glean report — CONFIRMED live against SS-DEMO
//     order 6000012 (2026-08-17): returned real Repack/Apply Labels Pick
//     instructions correctly joined back to order line, item, oLPN, oLPN
//     detail, and task detail.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const AUTH_HOST = process.env.MANHATTAN_AUTH_HOST || 'salep-auth.sce.manh.com';
const API_HOST = process.env.MANHATTAN_API_HOST || 'salep.sce.manh.com';
const CLIENT_ID = process.env.MANHATTAN_CLIENT_ID || 'omnicomponent.1.0.0';
const CLIENT_SECRET = process.env.MANHATTAN_SECRET;
const PASSWORD = process.env.MANHATTAN_PASSWORD;
const USERNAME_BASE = process.env.MANHATTAN_USERNAME_BASE || 'sdtadmin@';

const TASK_SEARCH_PATH = '/task/api/task/task/search';
const OLPN_SEARCH_PATH = '/pickpack/api/pickpack/olpn/search';
const ASSIGNED_INSTRUCTION_SEARCH_PATH = '/pickpack/api/fw-aux-svcs/assignedInstruction/search';

// olpn_status domain, CONFIRMED (mawm_api_library/_conventions/statuses.md
// "### oLPN"). A re-waved/unwaved order leaves behind oLPN records from
// earlier waves in this status — their AssignedInstruction rows are stale
// and must not be reported as live instructions.
const OLPN_CANCELLED_STATUS = '9000';

// Read/written by the deployed app itself, same pattern as Work/vasexecution
// (see mawm_api_library/_conventions/auth-conventions.md, "Server-side
// token/org persistence") — a manually-provisioned or previously-obtained
// token is reused silently across requests until it expires or MAWM rejects
// it, at which point the app falls back to the ORG/password prompt.
const TOKEN_FILE_PATH = path.join(__dirname, '..', '.token');

// ---------------------------------------------------------------------------
// Auth / transport (mirrors Work/item_update/api/validate.js)
// ---------------------------------------------------------------------------

class TokenInvalidError extends Error {
  constructor(message) {
    super(message);
    this.tokenInvalid = true;
  }
}

// Decodes the JWT payload without verifying the signature — same
// unverified-decode approach confirmed in Work/vasexecution (see
// auth-conventions.md). Used only to read `exp`/`organization` locally;
// MAWM itself is still the authority on whether the token is actually
// valid (a 401 from a real call always wins over this local check).
function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function isTokenUsable(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return false;
  const nowSeconds = Date.now() / 1000;
  return payload.exp > nowSeconds + 30; // 30s buffer
}

function readTokenFile() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE_PATH, 'utf8').trim();
    return raw || null;
  } catch (e) {
    return null;
  }
}

function writeTokenFile(token) {
  try {
    fs.writeFileSync(TOKEN_FILE_PATH, token, 'utf8');
  } catch (e) {
    console.warn('[token] failed to write .token file:', e.message);
  }
}

async function getToken(org) {
  const url = `https://${AUTH_HOST}/oauth/token`;
  const username = `${USERNAME_BASE}${org.toLowerCase()}`;
  const body = new URLSearchParams({ grant_type: 'password', username, password: PASSWORD });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
    },
    body
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token;
}

async function mawmPost(path, token, org, payload) {
  const orgUpper = org.toUpperCase();
  const url = `https://${API_HOST}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    selectedOrganization: orgUpper,
    selectedLocation: `${orgUpper}-DM1`
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (res.status === 401) {
    throw new TokenInvalidError('MAWM rejected the current token (401) — it may have expired or been revoked.');
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { httpOk: res.ok, httpStatus: res.status, parseError: true, raw: text };
  }
  return { httpOk: res.ok, httpStatus: res.status, ...json };
}

function escapeQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function dataRows(resp) {
  return resp && Array.isArray(resp.data) ? resp.data : [];
}

// ---------------------------------------------------------------------------
// Join algorithm
// ---------------------------------------------------------------------------

async function findInstructions({ org, mode, value }, token) {
  const orgUpper = org.toUpperCase();
  const facilityId = `${orgUpper}-DM1`;
  const escapedValue = escapeQuoted(value);
  const calls = []; // diagnostic log of every MAWM call made

  function logCall(label, endpoint, query, resp) {
    calls.push({
      label,
      endpoint,
      query,
      httpStatus: resp.httpStatus,
      resultCount: Array.isArray(resp.data) ? resp.data.length : (resp.parseError ? 0 : undefined)
    });
  }

  // 1. Task details, via the dotted-path TaskDetail.<field> filter on the
  //    header (Task) search. The response nests each task's TaskDetail[]
  //    array on the same row (confirmed shape, see file header).
  const taskField = mode === 'order' ? 'OrderId' : 'OlpnId';
  const taskQuery = `TaskDetail.${taskField} ='${escapedValue}'`;
  const taskResp = await mawmPost(TASK_SEARCH_PATH, token, orgUpper, {
    Query: taskQuery,
    Size: 200,
    Page: 0
  });
  logCall('taskSearch', TASK_SEARCH_PATH, taskQuery, taskResp);

  const taskDetails = [];
  for (const task of dataRows(taskResp)) {
    for (const detail of asArray(task.TaskDetail)) {
      // Defensive: the dotted-path filter matches if ANY child row matches,
      // but the array returned may contain sibling lines that don't. Keep
      // only rows that actually belong to the value being searched.
      if (mode === 'order' && String(detail.OrderId || '') !== String(value)) continue;
      if (mode === 'olpn' && String(detail.OlpnId || '') !== String(value)) continue;
      taskDetails.push({
        TaskId: task.TaskId != null ? task.TaskId : detail.TaskId,
        TaskDetailId: detail.TaskDetailId,
        OrderId: detail.OrderId,
        OrderLineId: detail.OrderLineId,
        ItemId: detail.ItemId,
        OlpnId: detail.OlpnId,
        OlpnDetailId: detail.OlpnDetailId,
        Status: detail.Status != null ? detail.Status : task.Status,
        TypeId: task.TransactionTypeId || task.TypeId || detail.TypeId
      });
    }
  }

  // 2. Distinct oLPN IDs to look up. In olpn mode, always include the
  //    searched value itself even if no task was found for it (e.g. an
  //    already-shipped oLPN with no open task).
  const olpnIds = new Set(taskDetails.map((d) => d.OlpnId).filter(Boolean));
  if (mode === 'olpn') olpnIds.add(value);

  // 3. For each oLPN, pull header- and detail-level AssignedInstruction
  //    requestor IDs (per the supplied Glean report — see file header for
  //    the live confirmation).
  const requestorMap = new Map(); // requestorId -> { type, olpnId, olpnDetailId, itemId }
  const olpnDetailsSeen = []; // every (olpnId, olpnDetailId, itemId) actually returned by MAWM
  const olpnsNotFound = [];
  const olpnsExcludedCancelled = []; // { olpnId, status } — found, but Status='9000' (Cancelled)
  const olpnStatusById = new Map();
  const olpnRaw = {};

  for (const olpnId of olpnIds) {
    const query = `OlpnId ='${escapeQuoted(olpnId)}'`;
    const resp = await mawmPost(OLPN_SEARCH_PATH, token, orgUpper, {
      Query: query,
      Template: {
        OlpnId: null,
        Status: null,
        AssignedInstruction: null,
        OlpnDetail: { OlpnDetailId: null, ItemId: null, AssignedInstruction: null }
      },
      Size: 50
    });
    logCall(`olpnSearch:${olpnId}`, OLPN_SEARCH_PATH, query, resp);
    olpnRaw[olpnId] = resp;

    const rows = dataRows(resp);
    if (rows.length === 0) {
      olpnsNotFound.push(olpnId);
      continue;
    }

    // A re-waved/unwaved order can leave more than one oLPN record behind
    // for the same "logical" pick — only the non-cancelled one(s) matter.
    const activeRows = [];
    for (const row of rows) {
      const status = row.Status != null ? String(row.Status) : null;
      olpnStatusById.set(olpnId, status);
      if (status === OLPN_CANCELLED_STATUS) {
        olpnsExcludedCancelled.push({ olpnId, status });
        continue;
      }
      activeRows.push(row);
    }

    for (const row of activeRows) {
      for (const inst of asArray(row.AssignedInstruction)) {
        if (!inst || !inst.InstructionRequestorId) continue;
        requestorMap.set(String(inst.InstructionRequestorId), {
          type: 'Olpn',
          olpnId,
          olpnDetailId: null,
          itemId: null
        });
      }
      for (const detail of asArray(row.OlpnDetail)) {
        olpnDetailsSeen.push({ olpnId, olpnDetailId: detail.OlpnDetailId, itemId: detail.ItemId });
        for (const inst of asArray(detail.AssignedInstruction)) {
          if (!inst || !inst.InstructionRequestorId) continue;
          requestorMap.set(String(inst.InstructionRequestorId), {
            type: 'OlpnDetail',
            olpnId,
            olpnDetailId: detail.OlpnDetailId,
            itemId: detail.ItemId
          });
        }
      }
    }
  }

  // 4. Runtime assignedInstruction lookup, grouped by requestor type,
  //    IN-clause first with an automatic per-ID fallback.
  const idsByType = { OlpnDetail: [], Olpn: [] };
  for (const [id, ctx] of requestorMap.entries()) idsByType[ctx.type].push(id);

  const instructionRows = [];

  async function fetchAssignedInstructions(typeId, ids) {
    if (ids.length === 0) return;
    const quoted = ids.map((id) => `'${escapeQuoted(id)}'`).join(',');
    const inQuery =
      `OrgId='${escapeQuoted(orgUpper)}' and FacilityId='${escapeQuoted(facilityId)}' ` +
      `and InstructionRequestorTypeId='${typeId}' and InstructionRequestorId in (${quoted})`;
    const template = {
      OrgId: null,
      FacilityId: null,
      InstructionId: null,
      InstructionText: null,
      InstructionType: null,
      Sequence: null,
      InstructionRequestorTypeId: null,
      InstructionRequestorId: null,
      PK: null,
      Process: null,
      CreatedTimestamp: null,
      UpdatedTimestamp: null
    };

    const resp = await mawmPost(ASSIGNED_INSTRUCTION_SEARCH_PATH, token, orgUpper, {
      Query: inQuery,
      Template: template,
      Size: 500
    });
    logCall(`assignedInstruction:${typeId}:inClause`, ASSIGNED_INSTRUCTION_SEARCH_PATH, inQuery, resp);

    if (resp.httpOk && !resp.parseError && resp.success !== false) {
      instructionRows.push(...dataRows(resp));
      return;
    }

    // Fallback: environment rejected the IN clause (or the call otherwise
    // failed) — issue one request per requestor ID instead of silently
    // dropping results.
    for (const id of ids) {
      const singleQuery =
        `OrgId='${escapeQuoted(orgUpper)}' and FacilityId='${escapeQuoted(facilityId)}' ` +
        `and InstructionRequestorTypeId='${typeId}' and InstructionRequestorId='${escapeQuoted(id)}'`;
      const singleResp = await mawmPost(ASSIGNED_INSTRUCTION_SEARCH_PATH, token, orgUpper, {
        Query: singleQuery,
        Template: template,
        Size: 50
      });
      logCall(`assignedInstruction:${typeId}:${id}`, ASSIGNED_INSTRUCTION_SEARCH_PATH, singleQuery, singleResp);
      if (singleResp.httpOk && !singleResp.parseError) {
        instructionRows.push(...dataRows(singleResp));
      }
    }
  }

  await fetchAssignedInstructions('OlpnDetail', idsByType.OlpnDetail);
  await fetchAssignedInstructions('Olpn', idsByType.Olpn);

  // 5. Flatten: join each assignedInstruction row back to its oLPN (detail)
  //    context and, where available, the task detail that produced it.
  const flattened = instructionRows.map((inst) => {
    const ctx = requestorMap.get(String(inst.InstructionRequestorId)) || {};
    const matchingTaskDetail = taskDetails.find(
      (td) =>
        td.OlpnId === ctx.olpnId &&
        (ctx.olpnDetailId == null || td.OlpnDetailId === ctx.olpnDetailId)
    );

    return {
      OrgId: inst.OrgId || orgUpper,
      FacilityId: inst.FacilityId || facilityId,
      OrderId: (matchingTaskDetail && matchingTaskDetail.OrderId) || null,
      OrderLineId: (matchingTaskDetail && matchingTaskDetail.OrderLineId) || null,
      ItemId: (matchingTaskDetail && matchingTaskDetail.ItemId) || ctx.itemId || null,
      OlpnId: ctx.olpnId || null,
      OlpnStatus: ctx.olpnId ? olpnStatusById.get(ctx.olpnId) : null,
      OlpnDetailId: ctx.olpnDetailId,
      InstructionRequestorTypeId: inst.InstructionRequestorTypeId,
      InstructionRequestorId: inst.InstructionRequestorId,
      InstructionType: inst.InstructionType,
      InstructionId: inst.InstructionId,
      InstructionText: inst.InstructionText,
      Sequence: inst.Sequence,
      Process: inst.Process,
      PK: inst.PK,
      CreatedTimestamp: inst.CreatedTimestamp,
      UpdatedTimestamp: inst.UpdatedTimestamp,
      TaskId: matchingTaskDetail ? matchingTaskDetail.TaskId : null,
      TaskDetailId: matchingTaskDetail ? matchingTaskDetail.TaskDetailId : null,
      TaskDetailStatus: matchingTaskDetail ? matchingTaskDetail.Status : null
    };
  });

  flattened.sort((a, b) => {
    if (a.OlpnId !== b.OlpnId) return String(a.OlpnId).localeCompare(String(b.OlpnId));
    return (Number(a.Sequence) || 0) - (Number(b.Sequence) || 0);
  });

  // 6. Unmatched diagnostics.
  const matchedRequestorIds = new Set(instructionRows.map((r) => String(r.InstructionRequestorId)));
  const olpnDetailsNoInstruction = [];
  for (const [id, ctx] of requestorMap.entries()) {
    if (ctx.type === 'OlpnDetail' && !matchedRequestorIds.has(id)) {
      olpnDetailsNoInstruction.push({ olpnId: ctx.olpnId, olpnDetailId: ctx.olpnDetailId, requestorId: id });
    }
  }
  const olpnDetailsWithNoAssignedInstructionAtAll = olpnDetailsSeen.filter(
    (d) => !Array.from(requestorMap.values()).some((ctx) => ctx.olpnId === d.olpnId && ctx.olpnDetailId === d.olpnDetailId)
  );
  const taskDetailsNoOlpnFound = taskDetails.filter((td) => td.OlpnId && olpnsNotFound.includes(td.OlpnId));
  const excludedOlpnIds = new Set(olpnsExcludedCancelled.map((o) => o.olpnId));
  const taskDetailsOnCancelledOlpn = taskDetails.filter((td) => td.OlpnId && excludedOlpnIds.has(td.OlpnId));

  return {
    success: true,
    org: orgUpper,
    facilityId,
    mode,
    value,
    instructions: flattened,
    counts: {
      taskDetails: taskDetails.length,
      olpnsLooked: olpnIds.size,
      olpnsNotFound: olpnsNotFound.length,
      olpnsExcludedCancelled: olpnsExcludedCancelled.length,
      requestorIds: requestorMap.size,
      instructions: flattened.length
    },
    unmatched: {
      olpnsNotFound,
      olpnsExcludedCancelled,
      taskDetailsOnCancelledOlpn,
      olpnDetailsNoInstruction: [...olpnDetailsNoInstruction, ...olpnDetailsWithNoAssignedInstructionAtAll.map((d) => ({ olpnId: d.olpnId, olpnDetailId: d.olpnDetailId, requestorId: null }))],
      taskDetailsNoOlpnFound
    },
    raw: { taskSearch: taskResp, olpnSearches: olpnRaw, calls }
  };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

async function handler(req, res) {
  console.log(`[API] ${req.method} ${req.url}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, org: orgFromBody } = req.body;

  // Silent-auth check: if a usable token is sitting in .token (see
  // TOKEN_FILE_PATH above), hand it straight back so the frontend can skip
  // the ORG/password prompt entirely. No MAWM round trip here — the exp
  // claim is the only check; a token that decodes fine but was revoked
  // server-side will surface as a 401 (tokenInvalid) on the first real call
  // instead, which then falls back to the prompt.
  if (action === 'token_status') {
    const fileToken = readTokenFile();
    if (fileToken && isTokenUsable(fileToken)) {
      const payload = decodeJwtPayload(fileToken);
      const org = payload && (payload.organization || (payload.userDefaults && payload.userDefaults[0] && payload.userDefaults[0].defaultOrganization));
      if (org) {
        return res.json({ success: true, token: fileToken, org });
      }
    }
    return res.json({ success: false });
  }

  if (action === 'auth') {
    if (!orgFromBody || !String(orgFromBody).trim()) {
      return res.json({ success: false, error: 'ORG required' });
    }
    if (!PASSWORD || !CLIENT_SECRET) {
      return res.json({ success: false, error: 'Server not configured: MANHATTAN_PASSWORD / MANHATTAN_SECRET missing' });
    }
    const token = await getToken(orgFromBody);
    if (!token) return res.json({ success: false, error: 'Auth failed' });
    writeTokenFile(token);
    return res.json({ success: true, token });
  }

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  if (action === 'search') {
    const org = req.body.org;
    const mode = req.body.mode; // 'order' | 'olpn'
    const value = req.body.value;

    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    if (mode !== 'order' && mode !== 'olpn') {
      return res.status(400).json({ success: false, error: "mode must be 'order' or 'olpn'" });
    }
    if (!value || !String(value).trim()) {
      return res.status(400).json({ success: false, error: 'A value to search for is required' });
    }

    try {
      const result = await findInstructions({ org, mode, value: String(value).trim() }, token);
      return res.json(result);
    } catch (e) {
      console.error('[search] error:', e);
      return res.json({ success: false, error: e.message || 'Search failed', tokenInvalid: !!e.tokenInvalid });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}

handler.config = { api: { bodyParser: true } };
module.exports = handler;
