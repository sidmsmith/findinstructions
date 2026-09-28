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

// Usage tracking (Neon via the usage dashboard's ingest endpoint) — same
// forward-and-forget pattern as Work/receivingworkbench and
// Work/taskcompletion: never blocks or fails the caller's request.
const USAGE_INGEST_URL = (process.env.MANHATTAN_USAGE_INGEST_URL || '').trim();
const USAGE_INGEST_SECRET = (process.env.MANHATTAN_USAGE_INGEST_SECRET || '').trim();
const APP_NAME = 'findinstructions-app';
const APP_VERSION = '1.7.0';

async function forwardUsageEvent(payload) {
  if (!USAGE_INGEST_URL) {
    console.warn('[usage] MANHATTAN_USAGE_INGEST_URL not set; event not recorded');
    return;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (USAGE_INGEST_SECRET) headers.Authorization = `Bearer ${USAGE_INGEST_SECRET}`;
  try {
    await fetch(USAGE_INGEST_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_name: APP_NAME, app_version: APP_VERSION, ...payload })
    });
  } catch (e) {
    console.warn('[usage] Forward failed:', e.message);
  }
}

const TASK_SEARCH_PATH = '/task/api/task/task/search';
const OLPN_SEARCH_PATH = '/pickpack/api/pickpack/olpn/search';
const ASSIGNED_INSTRUCTION_SEARCH_PATH = '/pickpack/api/fw-aux-svcs/assignedInstruction/search';
// Update-by-PK: PUT {base}/{PK} with the full entity (PK in the body too),
// only InstructionText changed. Taken from a Glean conversation, confirmed
// by the user in Postman and then live through this app against SS-DEMO
// (2026-09-28). Delete-by-PK: DELETE {base}/{PK} — supplied by the user.
const ASSIGNED_INSTRUCTION_BASE_PATH = '/pickpack/api/fw-aux-svcs/assignedInstruction';
// Create: POST {base}/save with no PK (MAWM generates it). Taken from a
// Glean conversation (2026-09-28); first exercised through this app's
// Add-instruction modal.
const ASSIGNED_INSTRUCTION_SAVE_PATH = '/pickpack/api/fw-aux-svcs/assignedInstruction/save';
const INSTRUCTION_TYPES = ['Pick', 'Pack'];
const INSTRUCTION_CATALOG_SEARCH_PATH = '/aux-svcs/api/aux-svcs/instruction/search';
const ASSIGNED_INSTRUCTION_ENTITY_FIELDS = [
  'OrgId', 'FacilityId', 'InstructionId', 'InstructionText', 'InstructionType',
  'Sequence', 'InstructionRequestorTypeId', 'InstructionRequestorId', 'PK'
];

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
  return mawmRequest('POST', path, token, org, payload);
}

async function mawmRequest(method, path, token, org, payload) {
  const orgUpper = org.toUpperCase();
  const url = `https://${API_HOST}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    selectedOrganization: orgUpper,
    selectedLocation: `${orgUpper}-DM1`
  };

  const init = { method, headers };
  if (payload !== undefined) init.body = JSON.stringify(payload);
  const res = await fetch(url, init);
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
  const activeOlpns = []; // { olpnId, status } — found and not Cancelled
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
      if (!activeOlpns.some((o) => o.olpnId === olpnId)) activeOlpns.push({ olpnId, status });
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
  // A header-level (Olpn) instruction belongs to the whole oLPN, not to any
  // one line — so it gets no order line, item, or task detail. Order and
  // task are shown only when every task detail on that oLPN agrees on them.
  function sharedValue(rows, field) {
    const values = new Set(rows.map((r) => r[field]).filter((v) => v != null && v !== ''));
    return values.size === 1 ? [...values][0] : null;
  }

  const flattened = instructionRows.map((inst) => {
    const ctx = requestorMap.get(String(inst.InstructionRequestorId)) || {};
    const isHeader = ctx.type === 'Olpn';
    const olpnTaskDetails = taskDetails.filter((td) => td.OlpnId === ctx.olpnId);
    const matchingTaskDetail = isHeader
      ? null
      : olpnTaskDetails.find((td) => ctx.olpnDetailId == null || td.OlpnDetailId === ctx.olpnDetailId);

    return {
      OrgId: inst.OrgId || orgUpper,
      FacilityId: inst.FacilityId || facilityId,
      IsHeader: isHeader,
      OrderId: isHeader
        ? sharedValue(olpnTaskDetails, 'OrderId')
        : (matchingTaskDetail && matchingTaskDetail.OrderId) || null,
      OrderLineId: (matchingTaskDetail && matchingTaskDetail.OrderLineId) || null,
      ItemId: isHeader ? null : (matchingTaskDetail && matchingTaskDetail.ItemId) || ctx.itemId || null,
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
      TaskId: isHeader
        ? sharedValue(olpnTaskDetails, 'TaskId')
        : matchingTaskDetail ? matchingTaskDetail.TaskId : null,
      TaskDetailId: matchingTaskDetail ? matchingTaskDetail.TaskDetailId : null,
      TaskDetailStatus: matchingTaskDetail ? matchingTaskDetail.Status : null
    };
  });

  // Per oLPN: header instructions first, then details; each by Sequence.
  flattened.sort((a, b) => {
    if (a.OlpnId !== b.OlpnId) return String(a.OlpnId).localeCompare(String(b.OlpnId));
    if (a.IsHeader !== b.IsHeader) return a.IsHeader ? -1 : 1;
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
    activeOlpns,
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

// Single-box search: try the value as an Order first; only if no order
// matches, search it as an oLPN. "Order found" means the Task search
// returned at least one TaskDetail for that OrderId — the Task search is
// this app's only order lookup, so an order with no tasks at all falls
// through to the oLPN search. An explicit 'order'/'olpn' mode skips the
// fallback.
async function searchAuto({ org, mode, value }, token) {
  if (mode !== 'auto') {
    const result = await findInstructions({ org, mode, value }, token);
    return { ...result, requestedMode: mode, fellBackToOlpn: false };
  }

  const orderResult = await findInstructions({ org, mode: 'order', value }, token);
  if (orderResult.counts.taskDetails > 0) {
    return { ...orderResult, requestedMode: 'auto', fellBackToOlpn: false };
  }

  const olpnResult = await findInstructions({ org, mode: 'olpn', value }, token);
  return {
    ...olpnResult,
    requestedMode: 'auto',
    fellBackToOlpn: true,
    raw: { ...olpnResult.raw, orderAttempt: orderResult.raw }
  };
}

// ---------------------------------------------------------------------------
// Update one assigned instruction's text
// ---------------------------------------------------------------------------

async function getAssignedInstructionByPk(orgUpper, pk, token) {
  const template = {};
  for (const f of ASSIGNED_INSTRUCTION_ENTITY_FIELDS) template[f] = null;
  template.UpdatedTimestamp = null;
  const resp = await mawmPost(ASSIGNED_INSTRUCTION_SEARCH_PATH, token, orgUpper, {
    Query: `PK=${escapeQuoted(pk)}`,
    Template: template,
    Size: 2
  });
  return { resp, rows: dataRows(resp) };
}

async function updateInstructionText({ org, pk, instructionText }, token) {
  const orgUpper = org.toUpperCase();
  const facilityId = `${orgUpper}-DM1`;

  // 1. Re-read the current record by PK so the PUT carries MAWM's current
  //    values for every other field, not whatever the browser last saw.
  const before = await getAssignedInstructionByPk(orgUpper, pk, token);
  if (before.rows.length !== 1) {
    return {
      success: false,
      error: before.rows.length === 0
        ? `Assigned instruction ${pk} not found.`
        : `PK ${pk} matched more than one assigned instruction — not updating.`
    };
  }
  const current = before.rows[0];
  if (current.OrgId !== orgUpper || current.FacilityId !== facilityId) {
    return { success: false, error: `Instruction ${pk} belongs to ${current.OrgId}/${current.FacilityId}, not ${orgUpper}/${facilityId}.` };
  }

  // 2. PUT the full entity with only InstructionText changed.
  const payload = {};
  for (const f of ASSIGNED_INSTRUCTION_ENTITY_FIELDS) payload[f] = current[f];
  payload.InstructionText = instructionText;
  const putPath = `${ASSIGNED_INSTRUCTION_BASE_PATH}/${encodeURIComponent(pk)}`;
  const putResp = await mawmRequest('PUT', putPath, token, orgUpper, payload);
  if (!putResp.httpOk || putResp.parseError || putResp.success === false) {
    return { success: false, error: `Update failed ${describeMawmFailure(putResp)}` };
  }

  // 3. Read back to confirm the change actually persisted.
  const after = await getAssignedInstructionByPk(orgUpper, pk, token);
  const updated = after.rows[0];
  if (!updated || updated.InstructionText !== instructionText) {
    return { success: false, error: 'MAWM accepted the update, but re-reading the instruction shows the text did not change.' };
  }

  return {
    success: true,
    pk: updated.PK,
    instructionText: updated.InstructionText,
    previousText: current.InstructionText,
    updatedTimestamp: updated.UpdatedTimestamp || null
  };
}

function describeMawmFailure(resp) {
  const detail = resp.message
    || (resp.errors && resp.errors.length && JSON.stringify(resp.errors))
    || (resp.messages && resp.messages.Message && resp.messages.Message.length && JSON.stringify(resp.messages.Message))
    || resp.raw
    || '';
  return `(HTTP ${resp.httpStatus}) ${String(detail).slice(0, 400)}`.trim();
}

async function deleteInstruction({ org, pk }, token) {
  const orgUpper = org.toUpperCase();
  const facilityId = `${orgUpper}-DM1`;

  // 1. Confirm the record exists and belongs to this ORG/facility before
  //    deleting anything — a DELETE can't be undone.
  const before = await getAssignedInstructionByPk(orgUpper, pk, token);
  if (before.rows.length !== 1) {
    return {
      success: false,
      error: before.rows.length === 0
        ? `Assigned instruction ${pk} not found.`
        : `PK ${pk} matched more than one assigned instruction — not deleting.`
    };
  }
  const current = before.rows[0];
  if (current.OrgId !== orgUpper || current.FacilityId !== facilityId) {
    return { success: false, error: `Instruction ${pk} belongs to ${current.OrgId}/${current.FacilityId}, not ${orgUpper}/${facilityId}.` };
  }

  // 2. DELETE by PK.
  const delPath = `${ASSIGNED_INSTRUCTION_BASE_PATH}/${encodeURIComponent(pk)}`;
  const delResp = await mawmRequest('DELETE', delPath, token, orgUpper);
  // An empty 2xx body is a valid DELETE response — only fail on a non-2xx
  // status or an explicit success:false.
  if (!delResp.httpOk || delResp.success === false) {
    return { success: false, error: `Delete failed ${describeMawmFailure(delResp)}` };
  }

  // 3. Read back to confirm it's actually gone.
  const after = await getAssignedInstructionByPk(orgUpper, pk, token);
  if (after.rows.length > 0) {
    return { success: false, error: 'MAWM accepted the delete, but the instruction is still returned by search.' };
  }

  return { success: true, pk: String(pk), deletedText: current.InstructionText };
}

// ---------------------------------------------------------------------------
// Create a new assigned instruction on an oLPN header or detail
// ---------------------------------------------------------------------------

// Every oLPN and oLPN detail has an instruction requestor ID from birth,
// whether or not it has instructions yet. MAWM returns them as one
// comma-separated string: the header's ID first, then one per OlpnDetail in
// the same order as the OlpnDetail[] array. OBSERVED on SS-DEMO oLPN
// 0000099999100015639 (known detail-2 requestor sits at position 2 of the
// detail IDs) and 0000099999100015677 (1 detail, 2 IDs). Because that order
// rests on limited evidence, createInstruction() re-reads the oLPN after
// saving and checks the instruction landed under the intended target.
async function readOlpnWithRequestors(orgUpper, olpnId, token) {
  const resp = await mawmPost(OLPN_SEARCH_PATH, token, orgUpper, {
    Query: `OlpnId ='${escapeQuoted(olpnId)}'`,
    Template: {
      OlpnId: null,
      Status: null,
      OlpnAndDetailsServiceRequestorIds: null,
      AssignedInstruction: null,
      OlpnDetail: { OlpnDetailId: null, ItemId: null, AssignedInstruction: null }
    },
    Size: 50
  });
  const rows = dataRows(resp).filter((r) => String(r.Status) !== OLPN_CANCELLED_STATUS);
  if (rows.length === 0) {
    return { error: dataRows(resp).length ? `oLPN ${olpnId} is Cancelled.` : `oLPN ${olpnId} not found.` };
  }
  if (rows.length > 1) return { error: `oLPN ${olpnId} matched more than one active record — not changing it.` };
  const row = rows[0];

  const ids = String(row.OlpnAndDetailsServiceRequestorIds || '').split(',').map((x) => x.trim()).filter(Boolean);
  const details = asArray(row.OlpnDetail);
  if (ids.length !== details.length + 1) {
    return {
      error: `oLPN ${olpnId} returned ${ids.length} requestor ID(s) for 1 header + ${details.length} detail(s); ` +
        'cannot tell which ID belongs to which target, so not creating anything.'
    };
  }

  const targets = [
    { type: 'Olpn', requestorId: ids[0], olpnDetailId: null, itemId: null, label: 'oLPN header', existing: asArray(row.AssignedInstruction) }
  ];
  details.forEach((d, i) => {
    targets.push({
      type: 'OlpnDetail',
      requestorId: ids[i + 1],
      olpnDetailId: d.OlpnDetailId != null ? String(d.OlpnDetailId) : null,
      itemId: d.ItemId || null,
      label: `Detail ${d.OlpnDetailId} – Item ${d.ItemId || '?'}`,
      existing: asArray(d.AssignedInstruction)
    });
  });
  return { row, targets };
}

async function getOlpnTargets({ org, olpnId }, token) {
  const orgUpper = org.toUpperCase();
  const r = await readOlpnWithRequestors(orgUpper, olpnId, token);
  if (r.error) return { success: false, error: r.error };
  return {
    success: true,
    olpnId: r.row.OlpnId,
    status: r.row.Status != null ? String(r.row.Status) : null,
    targets: r.targets.map((t) => ({
      type: t.type,
      olpnDetailId: t.olpnDetailId,
      itemId: t.itemId,
      label: t.label,
      existingCount: t.existing.length,
      nextSequence: t.existing.reduce((m, a) => Math.max(m, Number(a.Sequence) || 0), 0) + 1
    }))
  };
}

// Master instruction definitions (InstructionId + default InstructionText)
// used to populate the create modal's dropdown. Query/template supplied by
// the user from Postman against SS-DEMO (2026-09-28): 77 rows.
async function getInstructionCatalog(orgUpper, token) {
  const resp = await mawmPost(INSTRUCTION_CATALOG_SEARCH_PATH, token, orgUpper, {
    Query: 'InstructionId != null',
    Template: { InstructionId: null, InstructionText: null },
    Size: 1000
  });
  if (!resp.httpOk || resp.parseError || resp.success === false) {
    return { error: `Could not load instruction list ${describeMawmFailure(resp)}` };
  }
  const seen = new Set();
  const instructions = [];
  for (const r of dataRows(resp)) {
    const id = r.InstructionId != null ? String(r.InstructionId) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    instructions.push({ id, text: r.InstructionText != null ? String(r.InstructionText) : '' });
  }
  instructions.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
  return { instructions };
}

async function createInstruction({ org, olpnId, targetType, olpnDetailId, instructionType, instructionId, instructionText, sequence }, token) {
  const orgUpper = org.toUpperCase();

  // 1. Resolve the requestor ID server-side — never trust one from the browser.
  const before = await readOlpnWithRequestors(orgUpper, olpnId, token);
  if (before.error) return { success: false, error: before.error };
  const target = before.targets.find((t) =>
    t.type === targetType && (targetType === 'Olpn' || t.olpnDetailId === String(olpnDetailId))
  );
  if (!target) return { success: false, error: `oLPN ${olpnId} has no ${targetType === 'Olpn' ? 'header' : `detail ${olpnDetailId}`} target.` };

  // InstructionId must be a real master instruction, and unique per
  // requestor — reject both here with a clear message rather than relying
  // on MAWM's own error.
  const catalog = await getInstructionCatalog(orgUpper, token);
  if (catalog.error) return { success: false, error: catalog.error };
  if (!catalog.instructions.some((i) => i.id === instructionId)) {
    return { success: false, error: `"${instructionId}" is not a defined instruction.` };
  }
  if (target.existing.some((a) => a.InstructionId === instructionId)) {
    return { success: false, error: `${target.label} already has instruction "${instructionId}".` };
  }

  // 2. Create. No PK — MAWM generates it; OrgId/FacilityId come from headers.
  const payload = {
    InstructionRequestorId: target.requestorId,
    InstructionRequestorTypeId: target.type,
    InstructionType: instructionType,
    InstructionId: instructionId,
    InstructionText: instructionText,
    Sequence: sequence
  };
  const saveResp = await mawmPost(ASSIGNED_INSTRUCTION_SAVE_PATH, token, orgUpper, payload);
  if (!saveResp.httpOk || saveResp.parseError || saveResp.success === false) {
    return { success: false, error: `Create failed ${describeMawmFailure(saveResp)}` };
  }
  const savedPk = saveResp.data && !Array.isArray(saveResp.data) && saveResp.data.PK ? String(saveResp.data.PK) : null;

  // 3. Confirm the record exists in the instruction store.
  const findResp = await mawmPost(ASSIGNED_INSTRUCTION_SEARCH_PATH, token, orgUpper, {
    Query: `InstructionRequestorTypeId='${target.type}' and InstructionRequestorId='${escapeQuoted(target.requestorId)}' ` +
      `and InstructionId='${escapeQuoted(instructionId)}'`,
    Size: 5
  });
  const created = dataRows(findResp).find((r) => !savedPk || String(r.PK) === savedPk);
  if (!created) {
    return { success: false, error: 'MAWM accepted the create, but the new instruction could not be found afterwards.' };
  }
  const pk = String(created.PK);

  // 4. Confirm it shows up under the intended target on the oLPN — this is
  //    what the search join reads, and it checks the requestor-ID mapping.
  const after = await readOlpnWithRequestors(orgUpper, olpnId, token);
  let landedOn = null;
  if (!after.error) {
    const hit = after.targets.find((t) => t.existing.some((a) => String(a.PK) === pk));
    landedOn = hit ? hit.label : null;
  }
  if (landedOn && landedOn !== target.label) {
    return {
      success: false,
      pk,
      error: `Created instruction ${pk}, but it appears under "${landedOn}" instead of "${target.label}". ` +
        'Delete it from the results table and report this — the requestor-ID mapping is wrong for this oLPN.'
    };
  }

  return {
    success: true,
    pk,
    target: target.label,
    instructionText: created.InstructionText,
    // false => saved, but the oLPN doesn't list it yet, so a search won't show it
    visibleOnOlpn: !!landedOn
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

  if (action === 'app_opened') {
    await forwardUsageEvent({ event_name: 'app_opened' });
    return res.json({ success: true });
  }

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
    if (!token) {
      await forwardUsageEvent({ event_name: 'auth_failed', org: String(orgFromBody).toUpperCase() });
      return res.json({ success: false, error: 'Auth failed' });
    }
    writeTokenFile(token);
    await forwardUsageEvent({ event_name: 'auth_success', org: String(orgFromBody).toUpperCase() });
    return res.json({ success: true, token });
  }

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  if (action === 'search') {
    const org = req.body.org;
    const mode = req.body.mode || 'auto'; // 'auto' | 'order' | 'olpn'
    const value = req.body.value;

    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    if (mode !== 'auto' && mode !== 'order' && mode !== 'olpn') {
      return res.status(400).json({ success: false, error: "mode must be 'auto', 'order' or 'olpn'" });
    }
    if (!value || !String(value).trim()) {
      return res.status(400).json({ success: false, error: 'A value to search for is required' });
    }

    try {
      const result = await searchAuto({ org, mode, value: String(value).trim() }, token);
      await forwardUsageEvent({
        event_name: 'search_completed',
        org: String(org).toUpperCase(),
        mode: result.mode, // the mode that actually produced the results
        requestedMode: mode,
        instructionsFound: result.counts ? result.counts.instructions : undefined
      });
      return res.json(result);
    } catch (e) {
      console.error('[search] error:', e);
      await forwardUsageEvent({ event_name: 'search_failed', org: String(org).toUpperCase(), mode, error: e.message });
      return res.json({ success: false, error: e.message || 'Search failed', tokenInvalid: !!e.tokenInvalid });
    }
  }

  if (action === 'olpn_targets') {
    const org = req.body.org;
    const olpnId = req.body.olpnId != null ? String(req.body.olpnId).trim() : '';
    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    if (!olpnId) return res.status(400).json({ success: false, error: 'olpnId required' });
    try {
      return res.json(await getOlpnTargets({ org, olpnId }, token));
    } catch (e) {
      console.error('[olpn_targets] error:', e);
      return res.json({ success: false, error: e.message || 'Lookup failed', tokenInvalid: !!e.tokenInvalid });
    }
  }

  if (action === 'instruction_catalog') {
    const org = req.body.org;
    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    try {
      const r = await getInstructionCatalog(String(org).toUpperCase(), token);
      return res.json(r.error ? { success: false, error: r.error } : { success: true, instructions: r.instructions });
    } catch (e) {
      console.error('[instruction_catalog] error:', e);
      return res.json({ success: false, error: e.message || 'Lookup failed', tokenInvalid: !!e.tokenInvalid });
    }
  }

  if (action === 'create_instruction') {
    const org = req.body.org;
    const olpnId = req.body.olpnId != null ? String(req.body.olpnId).trim() : '';
    const targetType = req.body.targetType;
    const olpnDetailId = req.body.olpnDetailId != null ? String(req.body.olpnDetailId).trim() : '';
    const instructionType = req.body.instructionType;
    const instructionId = req.body.instructionId != null ? String(req.body.instructionId) : '';
    const instructionText = req.body.instructionText != null ? String(req.body.instructionText).trim() : '';
    const sequence = Number(req.body.sequence);

    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    if (!olpnId) return res.status(400).json({ success: false, error: 'olpnId required' });
    if (targetType !== 'Olpn' && targetType !== 'OlpnDetail') {
      return res.status(400).json({ success: false, error: "targetType must be 'Olpn' or 'OlpnDetail'" });
    }
    if (targetType === 'OlpnDetail' && !olpnDetailId) {
      return res.status(400).json({ success: false, error: 'olpnDetailId required for a detail-level instruction' });
    }
    if (!INSTRUCTION_TYPES.includes(instructionType)) {
      return res.status(400).json({ success: false, error: `instructionType must be one of ${INSTRUCTION_TYPES.join(', ')}` });
    }
    if (!instructionId) return res.status(400).json({ success: false, error: 'Select an Instruction ID' });
    if (!instructionText) return res.status(400).json({ success: false, error: 'Instruction text cannot be empty' });
    if (!Number.isInteger(sequence) || sequence < 1) {
      return res.status(400).json({ success: false, error: 'Sequence must be a whole number of 1 or more' });
    }

    try {
      const result = await createInstruction(
        { org, olpnId, targetType, olpnDetailId, instructionType, instructionId, instructionText, sequence },
        token
      );
      await forwardUsageEvent({
        event_name: result.success ? 'instruction_created' : 'instruction_create_failed',
        org: String(org).toUpperCase(),
        targetType,
        ...(result.success ? {} : { error: result.error })
      });
      return res.json(result);
    } catch (e) {
      console.error('[create_instruction] error:', e);
      await forwardUsageEvent({ event_name: 'instruction_create_failed', org: String(org).toUpperCase(), error: e.message });
      return res.json({ success: false, error: e.message || 'Create failed', tokenInvalid: !!e.tokenInvalid });
    }
  }

  if (action === 'update_instruction') {
    const org = req.body.org;
    const pk = req.body.pk != null ? String(req.body.pk).trim() : '';
    const instructionText = req.body.instructionText != null ? String(req.body.instructionText).trim() : '';

    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    if (!/^-?\d+$/.test(pk)) return res.status(400).json({ success: false, error: 'A numeric instruction PK is required' });
    if (!instructionText) return res.status(400).json({ success: false, error: 'Instruction text cannot be empty' });

    try {
      const result = await updateInstructionText({ org, pk, instructionText }, token);
      await forwardUsageEvent({
        event_name: result.success ? 'instruction_updated' : 'instruction_update_failed',
        org: String(org).toUpperCase(),
        ...(result.success ? {} : { error: result.error })
      });
      return res.json(result);
    } catch (e) {
      console.error('[update_instruction] error:', e);
      await forwardUsageEvent({ event_name: 'instruction_update_failed', org: String(org).toUpperCase(), error: e.message });
      return res.json({ success: false, error: e.message || 'Update failed', tokenInvalid: !!e.tokenInvalid });
    }
  }

  if (action === 'delete_instruction') {
    const org = req.body.org;
    const pk = req.body.pk != null ? String(req.body.pk).trim() : '';

    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    if (!/^-?\d+$/.test(pk)) return res.status(400).json({ success: false, error: 'A numeric instruction PK is required' });

    try {
      const result = await deleteInstruction({ org, pk }, token);
      await forwardUsageEvent({
        event_name: result.success ? 'instruction_deleted' : 'instruction_delete_failed',
        org: String(org).toUpperCase(),
        ...(result.success ? {} : { error: result.error })
      });
      return res.json(result);
    } catch (e) {
      console.error('[delete_instruction] error:', e);
      await forwardUsageEvent({ event_name: 'instruction_delete_failed', org: String(org).toUpperCase(), error: e.message });
      return res.json({ success: false, error: e.message || 'Delete failed', tokenInvalid: !!e.tokenInvalid });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}

handler.config = { api: { bodyParser: true } };
module.exports = handler;
