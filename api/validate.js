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
// "VAS Execution ↗" links on VAS cards. Set VAS_EXECUTION_URL to another
// deployment, or to "off" to hide the links.
const VAS_EXECUTION_URL = (() => {
  const v = (process.env.VAS_EXECUTION_URL || 'https://vasexecution.vercel.app').trim();
  return /^off$/i.test(v) || !/^https?:\/\//i.test(v) ? null : v.replace(/\/+$/, '');
})();
const APP_VERSION = '1.16.0';

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
// VAS: assigned services (with steps and step instructions) hang off the
// SAME requestor IDs as assigned instructions. Endpoint and
// `ServiceRequestorId IN (...)` filter CONFIRMED in Work/vasexecution
// (fetch_assigned_service_rows); both kinds of record on one requestor
// observed live on SS-DEMO oLPN 0000099999100015592 detail 1 (2026-10-06).
const ASSIGNED_SERVICE_SEARCH_PATH = '/pickpack/api/fw-aux-svcs/assignedService/search';
// VAS step instructions have no endpoints of their own; they are created,
// updated and deleted through the parent service's save with a PARTIAL
// nested body (omitted steps/instructions are left unchanged; delete uses
// ApplyAction "DELETE"). OBSERVED on SS-DEMO 2026-10-06 (create -> update ->
// delete of a throwaway instruction, whole service diffed after each call;
// only the new row and the Process audit stamp changed). Only tested while
// the service is Created (1000), so the app only edits Created services.
const ASSIGNED_SERVICE_SAVE_PATH = '/pickpack/api/fw-aux-svcs/assignedService/save';
const ASSIGNED_SERVICE_GET_PATH = '/pickpack/api/fw-aux-svcs/assignedService';
const VAS_EDITABLE_STATUS = '1000';
// VAS master definitions: ProvidedService -> ProvidedServiceStep[] ->
// StepInstruction[]. Endpoint CONFIRMED in Work/vasexecution; observed on
// SS-DEMO that a master StepInstructionId is exactly the
// AssignedServiceStepInstructionId used on assigned services (2026-10-07).
const PROVIDED_SERVICE_SEARCH_PATH = '/aux-svcs/api/aux-svcs/providedService/search';
// Same mapping as Work/vasexecution's ASSIGNED_SERVICE_STATUS.
const ASSIGNED_SERVICE_STATUS = { 1000: 'Created', 2000: 'In Progress', 5000: 'Complete', 8000: 'Cancelled', 9000: 'Failed' };
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
    json = parseMawmJson(text);
  } catch (e) {
    return { httpOk: res.ok, httpStatus: res.status, parseError: true, raw: text };
  }
  return { httpOk: res.ok, httpStatus: res.status, ...json };
}

// MAWM returns some IDs (e.g. assignedService's nested AssignedService.PK /
// AssignedServiceStep.PK) as bare 19-digit JSON numbers, which JSON.parse
// silently rounds (…831231 -> …832000). Quote any bare 16+ digit number
// before parsing so every ID survives exactly.
function parseMawmJson(text) {
  return JSON.parse(text.replace(/(:\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
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

// Steps + step instructions of one assigned service, as the UI shows them.
// A step is editable only while both it and its service are Created.
function shapeVasSteps(svc) {
  const svcStatus = svc.StatusId != null ? String(svc.StatusId) : null;
  return asArray(svc.AssignedServiceStep)
    .map((st) => {
      const stepStatusId = st.StatusId != null ? String(st.StatusId) : svcStatus;
      return {
        AssignedServiceStepId: st.AssignedServiceStepId,
        StepDescription: st.StepDescription,
        Sequence: st.Sequence,
        StatusId: stepStatusId,
        Status: ASSIGNED_SERVICE_STATUS[stepStatusId] || stepStatusId,
        RequestedQuantity: st.RequestedQuantity,
        CompletedQuantity: st.CompletedQuantity,
        PK: st.PK != null ? String(st.PK) : null,
        Editable: svcStatus === VAS_EDITABLE_STATUS && stepStatusId === VAS_EDITABLE_STATUS,
        Instructions: asArray(st.AssignedServiceStepInstruction)
          .filter((i) => i && i.InstructionText)
          .map((i) => ({
            Sequence: i.Sequence,
            InstructionText: i.InstructionText,
            AssignedServiceStepInstructionId: i.AssignedServiceStepInstructionId,
            PK: i.PK != null ? String(i.PK) : null
          }))
          .sort((a, b) => (Number(a.Sequence) || 0) - (Number(b.Sequence) || 0))
      };
    })
    .sort((a, b) => (Number(a.Sequence) || 0) - (Number(b.Sequence) || 0));
}

// Row order, shared with public/script.js (keep the two in sync): per oLPN,
// the header first, then details by number; within a target Pick before
// Pack; then Sequence. Each reorderable group — same oLPN, same target
// (header or one detail), same InstructionType — is therefore contiguous.
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
  const allRequestors = new Map(); // requestorId -> { type, olpnId, olpnDetailId, itemId }, every target on every active oLPN
  const activeOlpns = []; // { olpnId, status } — found and not Cancelled
  const olpnRaw = {};

  for (const olpnId of olpnIds) {
    const query = `OlpnId ='${escapeQuoted(olpnId)}'`;
    const resp = await mawmPost(OLPN_SEARCH_PATH, token, orgUpper, {
      Query: query,
      Template: {
        OlpnId: null,
        Status: null,
        OlpnAndDetailsServiceRequestorIds: null,
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
      // Every requestor on the oLPN (header first, then one per detail in
      // OlpnDetail order — see readOlpnWithRequestors) — used for VAS.
      const ids = String(row.OlpnAndDetailsServiceRequestorIds || '').split(',').map((x) => x.trim()).filter(Boolean);
      const details = asArray(row.OlpnDetail);
      if (ids.length === details.length + 1) {
        allRequestors.set(ids[0], { type: 'Olpn', olpnId, olpnDetailId: null, itemId: null });
        details.forEach((d, i) => {
          allRequestors.set(ids[i + 1], { type: 'OlpnDetail', olpnId, olpnDetailId: d.OlpnDetailId, itemId: d.ItemId });
        });
      }
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

  flattened.sort(compareInstructionRows);

  // 5b. VAS: assigned services on the same requestors, with their steps and
  //     step instructions. Read-only.
  const vasServices = [];
  if (allRequestors.size > 0) {
    const ids = [...allRequestors.keys()].filter((id) => /^-?\d+$/.test(id));
    const vasQuery = `ServiceRequestorId IN (${ids.join(',')})`;
    const vasResp = await mawmPost(ASSIGNED_SERVICE_SEARCH_PATH, token, orgUpper, { Query: vasQuery, Size: 500 });
    logCall('assignedServiceSearch', ASSIGNED_SERVICE_SEARCH_PATH, vasQuery, vasResp);
    for (const svc of dataRows(vasResp)) {
      const ctx = allRequestors.get(String(svc.ServiceRequestorId)) || {};
      const isHeader = ctx.type === 'Olpn';
      const olpnTaskDetails = taskDetails.filter((td) => td.OlpnId === ctx.olpnId);
      const td = isHeader ? null : olpnTaskDetails.find((t) => t.OlpnDetailId === ctx.olpnDetailId);
      const statusId = svc.StatusId != null ? String(svc.StatusId) : null;
      vasServices.push({
        OlpnId: ctx.olpnId || null,
        IsHeader: isHeader,
        OlpnDetailId: ctx.olpnDetailId || null,
        ItemId: isHeader ? null : (td && td.ItemId) || ctx.itemId || null,
        OrderId: isHeader ? sharedValue(olpnTaskDetails, 'OrderId') : (td && td.OrderId) || null,
        OrderLineId: (td && td.OrderLineId) || null,
        ServiceRequestorTypeId: svc.ServiceRequestorTypeId,
        ServiceRequestorId: svc.ServiceRequestorId != null ? String(svc.ServiceRequestorId) : null,
        ProvidedServiceId: svc.ProvidedServiceId,
        Description: svc.Description || svc.ProvidedServiceId,
        Sequence: svc.Sequence,
        StatusId: statusId,
        Status: ASSIGNED_SERVICE_STATUS[statusId] || statusId,
        PK: svc.PK,
        Editable: statusId === VAS_EDITABLE_STATUS,
        Steps: shapeVasSteps(svc)
      });
    }
    vasServices.sort((a, b) =>
      compareInstructionRows(
        { ...a, InstructionType: 'VAS' },
        { ...b, InstructionType: 'VAS' }
      ) || String(a.ProvidedServiceId).localeCompare(String(b.ProvidedServiceId))
    );

    // Standard definition per VAS type (one search each), so the UI can mark
    // steps that differ from standard. Passive: on any failure StandardSteps
    // stays null, the UI shows no marker, and only the diagnostics log knows.
    const types = [...new Set(vasServices.map((v) => v.ProvidedServiceId).filter(Boolean))];
    const defs = new Map();
    for (const typeId of types) {
      try {
        const def = await getVasTypeDefinition(orgUpper, typeId, token);
        logCall(`providedService:${typeId}`, PROVIDED_SERVICE_SEARCH_PATH, `ProvidedServiceId='${typeId}'`, def.resp || {});
        if (!def.error && def.found) defs.set(typeId, def.steps);
      } catch (e) {
        if (e.tokenInvalid) throw e;
        calls.push({ label: `providedService:${typeId}`, endpoint: PROVIDED_SERVICE_SEARCH_PATH, error: e.message });
      }
    }
    for (const v of vasServices) v.StandardSteps = defs.get(v.ProvidedServiceId) || null;
  }

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
    vasServices,
    vasExecutionUrl: VAS_EXECUTION_URL,
    activeOlpns,
    counts: {
      taskDetails: taskDetails.length,
      olpnsLooked: olpnIds.size,
      olpnsNotFound: olpnsNotFound.length,
      olpnsExcludedCancelled: olpnsExcludedCancelled.length,
      requestorIds: requestorMap.size,
      instructions: flattened.length,
      vasServices: vasServices.length
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

  // 4. Close the gap in its sequence group (same requestor + type), so
  //    deleting 2 of 1,2,3 leaves 1,2 — matching how create renumbers.
  let sequences = [];
  let renumberWarning = null;
  const groupResp = await mawmPost(ASSIGNED_INSTRUCTION_SEARCH_PATH, token, orgUpper, {
    Query: `InstructionRequestorTypeId='${escapeQuoted(current.InstructionRequestorTypeId)}' ` +
      `and InstructionRequestorId='${escapeQuoted(current.InstructionRequestorId)}'`,
    Size: 200
  });
  if (groupResp.httpOk && groupResp.success !== false) {
    const group = dataRows(groupResp)
      .filter((r) => r.InstructionType === current.InstructionType && String(r.PK) !== String(pk))
      .sort((a, b) => (Number(a.Sequence) || 0) - (Number(b.Sequence) || 0) || String(a.PK).localeCompare(String(b.PK)));
    const renumbered = await renumberRows(orgUpper, group, token);
    if (renumbered.error) renumberWarning = `Deleted, but renumbering the remaining instructions failed: ${renumbered.error}`;
    else sequences = group.map((r, i) => ({ pk: String(r.PK), sequence: i + 1 }));
  } else {
    renumberWarning = 'Deleted, but the remaining instructions could not be re-read to renumber them.';
  }

  return { success: true, pk: String(pk), deletedText: current.InstructionText, sequences, renumberWarning };
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
      // Sequences are numbered within target + InstructionType; a new one
      // can go at any position 1..count+1.
      countByType: Object.fromEntries(INSTRUCTION_TYPES.map((type) => [
        type,
        t.existing.filter((a) => a.InstructionType === type).length
      ]))
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

  // Sequence is a position within target + type: 1..count+1.
  const groupBefore = target.existing.filter((a) => a.InstructionType === instructionType);
  if (sequence > groupBefore.length + 1) {
    return {
      success: false,
      error: `Sequence must be between 1 and ${groupBefore.length + 1} — ${target.label} has ` +
        `${groupBefore.length} ${instructionType} instruction(s).`
    };
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

  // 5. Insert at the chosen position and renumber the group 1..n+1, so
  //    choosing 2 of 3 pushes the old 2 and 3 down to 3 and 4 instead of
  //    leaving two 2s. Rows come from the fresh oLPN read.
  let renumberWarning = null;
  if (landedOn) {
    const afterTarget = after.targets.find((t) => t.label === target.label);
    const group = afterTarget.existing.filter((a) => a.InstructionType === instructionType);
    const newRow = group.find((a) => String(a.PK) === pk);
    const others = group
      .filter((a) => String(a.PK) !== pk)
      .sort((a, b) => (Number(a.Sequence) || 0) - (Number(b.Sequence) || 0) || String(a.PK).localeCompare(String(b.PK)));
    others.splice(Math.min(sequence, others.length + 1) - 1, 0, newRow);
    const renumbered = await renumberRows(orgUpper, others, token);
    if (renumbered.error) {
      renumberWarning = `Created, but renumbering the other ${instructionType} instructions failed: ${renumbered.error}`;
    }
  }

  return {
    success: true,
    pk,
    target: target.label,
    instructionText: created.InstructionText,
    // false => saved, but the oLPN doesn't list it yet, so a search won't show it
    visibleOnOlpn: !!landedOn,
    renumberWarning
  };
}

// ---------------------------------------------------------------------------
// Reorder one group of instructions (same oLPN, same target, same type)
// ---------------------------------------------------------------------------

// Gives `rowsInOrder` (full assignedInstruction entities, e.g. from an oLPN
// read) Sequence 1..n, PUTting only rows whose Sequence changes — the same
// confirmed update-by-PK call as the text edit, with only Sequence changed.
async function renumberRows(orgUpper, rowsInOrder, token) {
  const changes = rowsInOrder
    .map((row, i) => ({ row, sequence: i + 1 }))
    .filter((c) => Number(c.row.Sequence) !== c.sequence);
  for (const [n, c] of changes.entries()) {
    const payload = {};
    for (const f of ASSIGNED_INSTRUCTION_ENTITY_FIELDS) payload[f] = c.row[f];
    payload.Sequence = c.sequence;
    const putPath = `${ASSIGNED_INSTRUCTION_BASE_PATH}/${encodeURIComponent(c.row.PK)}`;
    const putResp = await mawmRequest('PUT', putPath, token, orgUpper, payload);
    if (!putResp.httpOk || putResp.parseError || putResp.success === false) {
      return {
        error: `Updating the sequence of "${c.row.InstructionText}" failed ${describeMawmFailure(putResp)}`,
        partial: n > 0
      };
    }
  }
  return { updatedCount: changes.length };
}

// `pks` is the group's full PK list in the desired order. Renumbers it
// 1..n and PUTs only rows whose Sequence changes — via the same confirmed
// update-by-PK call as the text edit, with only Sequence changed. The rows
// come straight from a fresh oLPN read (AssignedInstruction[] carries the
// full entity), so no per-PK re-read is needed before the PUT.
async function resequenceInstructions({ org, olpnId, pks }, token) {
  const orgUpper = org.toUpperCase();
  const facilityId = `${orgUpper}-DM1`;

  const before = await readOlpnWithRequestors(orgUpper, olpnId, token);
  if (before.error) return { success: false, error: before.error };

  // All PKs must be one whole group: same target, same type, nothing missing.
  const target = before.targets.find((t) => t.existing.some((a) => String(a.PK) === pks[0]));
  if (!target) return { success: false, error: `Instruction ${pks[0]} is not on oLPN ${olpnId}.` };
  const first = target.existing.find((a) => String(a.PK) === pks[0]);
  const group = target.existing.filter((a) => a.InstructionType === first.InstructionType);
  const groupPks = new Set(group.map((a) => String(a.PK)));
  if (pks.length !== group.length || new Set(pks).size !== pks.length || !pks.every((pk) => groupPks.has(pk))) {
    return {
      success: false,
      stale: true,
      error: `The ${first.InstructionType} instructions on ${target.label} changed since the page loaded — refresh and try again.`
    };
  }
  const bad = group.find((a) => a.OrgId !== orgUpper || a.FacilityId !== facilityId);
  if (bad) return { success: false, error: `Instruction ${bad.PK} belongs to ${bad.OrgId}/${bad.FacilityId}, not ${orgUpper}/${facilityId}.` };

  const byPk = new Map(group.map((a) => [String(a.PK), a]));
  const renumbered = await renumberRows(orgUpper, pks.map((pk) => byPk.get(pk)), token);
  if (renumbered.error) return { success: false, partial: renumbered.partial, error: renumbered.error };

  // Confirm the new order actually persisted.
  const after = await readOlpnWithRequestors(orgUpper, olpnId, token);
  if (after.error) return { success: false, partial: true, error: `Saved, but re-reading oLPN ${olpnId} failed: ${after.error}` };
  const afterRows = new Map(after.targets.flatMap((t) => t.existing).map((a) => [String(a.PK), a]));
  const wrong = pks.find((pk, i) => !afterRows.has(pk) || Number(afterRows.get(pk).Sequence) !== i + 1);
  if (wrong) {
    return { success: false, partial: true, error: 'MAWM accepted the update, but re-reading the oLPN shows a different order.' };
  }

  return {
    success: true,
    target: target.label,
    instructionType: first.InstructionType,
    sequences: pks.map((pk, i) => ({ pk, sequence: i + 1 })),
    updatedCount: renumbered.updatedCount
  };
}

// ---------------------------------------------------------------------------
// VAS step instructions: create / update / delete (via assignedService/save)
// ---------------------------------------------------------------------------

// Standard (master) definition of one VAS type: stepId -> its standard
// instructions in master order ({ id, text, sequence }). `resp` is returned
// for the diagnostics log.
async function getVasTypeDefinition(orgUpper, providedServiceId, token) {
  const resp = await mawmPost(PROVIDED_SERVICE_SEARCH_PATH, token, orgUpper, {
    Query: `ProvidedServiceId='${escapeQuoted(providedServiceId)}'`,
    Size: 5
  });
  if (!resp.httpOk || resp.parseError || resp.success === false) {
    return { error: `Could not load the ${providedServiceId} definition ${describeMawmFailure(resp)}`, resp };
  }
  const svc = dataRows(resp).find((r) => r.ProvidedServiceId === providedServiceId);
  const steps = {};
  for (const st of asArray(svc && svc.ProvidedServiceStep)) {
    if (!st || !st.ProvidedServiceStepId) continue;
    steps[st.ProvidedServiceStepId] = asArray(st.StepInstruction)
      .filter((i) => i && i.StepInstructionId)
      .map((i) => ({ id: String(i.StepInstructionId), text: i.InstructionText || '', sequence: Number(i.Sequence) || 0 }))
      .sort((a, b) => a.sequence - b.sequence);
  }
  return { found: !!svc, steps, resp };
}

// Standard (master) instructions for one step of a VAS type, in master order.
async function getVasStepCatalog(orgUpper, providedServiceId, stepId, token) {
  const def = await getVasTypeDefinition(orgUpper, providedServiceId, token);
  if (def.error) return { error: def.error };
  return { instructions: def.steps[stepId] || [] };
}

async function getAssignedServiceByPk(orgUpper, servicePk, token) {
  const resp = await mawmRequest('GET', `${ASSIGNED_SERVICE_GET_PATH}/${encodeURIComponent(servicePk)}`, token, orgUpper);
  if (!resp.httpOk || resp.parseError || resp.success === false || !resp.data || Array.isArray(resp.data)) {
    return { error: `Could not read VAS service ${servicePk} ${describeMawmFailure(resp)}` };
  }
  return { svc: resp.data };
}

// Re-reads the service and checks it is safe to write: right org/facility,
// service and step both Created, and (optionally) the instruction exists.
async function loadEditableVasStep(orgUpper, servicePk, stepPk, instructionPk, token) {
  const facilityId = `${orgUpper}-DM1`;
  const r = await getAssignedServiceByPk(orgUpper, servicePk, token);
  if (r.error) return r;
  const svc = r.svc;
  if (svc.OrgId !== orgUpper || svc.FacilityId !== facilityId) {
    return { error: `VAS service ${servicePk} belongs to ${svc.OrgId}/${svc.FacilityId}, not ${orgUpper}/${facilityId}.` };
  }
  const step = asArray(svc.AssignedServiceStep).find((st) => String(st.PK) === String(stepPk));
  if (!step) return { error: `Step ${stepPk} is not part of VAS service ${servicePk}.` };
  const svcStatus = String(svc.StatusId);
  const stepStatus = String(step.StatusId != null ? step.StatusId : svc.StatusId);
  if (svcStatus !== VAS_EDITABLE_STATUS || stepStatus !== VAS_EDITABLE_STATUS) {
    return {
      error: `VAS instructions can only be changed while the service and step are Created (1000) — ` +
        `this service is ${ASSIGNED_SERVICE_STATUS[svcStatus] || svcStatus}, step "${step.StepDescription}" is ` +
        `${ASSIGNED_SERVICE_STATUS[stepStatus] || stepStatus}.`
    };
  }
  const instructions = asArray(step.AssignedServiceStepInstruction);
  let instruction = null;
  if (instructionPk != null) {
    instruction = instructions.find((i) => String(i.PK) === String(instructionPk));
    if (!instruction) return { error: `Instruction ${instructionPk} is not on step "${step.StepDescription}".` };
  }
  return { svc, step, instructions, instruction };
}

// Fingerprint of a step's instructions (PK, id, sequence, text), excluding
// one PK — used to prove a write left the other instructions alone.
function stepFingerprint(instructions, excludePk) {
  return JSON.stringify(
    asArray(instructions)
      .filter((i) => String(i.PK) !== String(excludePk))
      .map((i) => [String(i.PK), i.AssignedServiceStepInstructionId, Number(i.Sequence), i.InstructionText])
      .sort((a, b) => a[0].localeCompare(b[0]))
  );
}

async function saveVasStepInstruction(orgUpper, servicePk, stepPk, instruction, token) {
  const resp = await mawmPost(ASSIGNED_SERVICE_SAVE_PATH, token, orgUpper, {
    PK: String(servicePk),
    AssignedServiceStep: [{ PK: String(stepPk), AssignedServiceStepInstruction: [instruction] }]
  });
  if (!resp.httpOk || resp.parseError || resp.success === false) {
    return { error: describeMawmFailure(resp) };
  }
  return {};
}

// After a write: re-read, prove the other instructions on the step are
// untouched, and return the step's fresh instruction list for the UI.
async function verifyVasStep(orgUpper, servicePk, stepPk, beforeInstructions, changedPk, token) {
  const r = await getAssignedServiceByPk(orgUpper, servicePk, token);
  if (r.error) return { error: `Saved, but re-reading failed: ${r.error}` };
  const step = asArray(r.svc.AssignedServiceStep).find((st) => String(st.PK) === String(stepPk));
  if (!step) return { error: 'Saved, but the step is no longer on the service.' };
  const after = asArray(step.AssignedServiceStepInstruction);
  if (stepFingerprint(after, changedPk) !== stepFingerprint(beforeInstructions, changedPk)) {
    return { error: 'Saved, but other instructions on this step changed unexpectedly — refresh and check.', step, svc: r.svc, after };
  }
  return { step, svc: r.svc, after };
}

function newVasInstructionId(svc, step) {
  // Same style as existing ids ("Embroidery_Prepare the Design_ins_awyd4dkh");
  // MAWM's limit for this id is 50 characters (see Work/vasexecution).
  const prefix = `${svc.ProvidedServiceId || 'VAS'}_${step.AssignedServiceStepId || 'step'}`.slice(0, 36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${prefix}_ins_${rand}`;
}

async function vasCreateInstruction({ org, servicePk, stepPk, instructionText, position, instructionId: standardId }, token) {
  const orgUpper = org.toUpperCase();
  const ctx = await loadEditableVasStep(orgUpper, servicePk, stepPk, null, token);
  if (ctx.error) return { success: false, error: ctx.error };

  // Duplicates: a standard instruction (by its master id) or identical
  // custom text can only be on a step once.
  if (standardId) {
    const catalog = await getVasStepCatalog(orgUpper, ctx.svc.ProvidedServiceId, ctx.step.AssignedServiceStepId, token);
    if (catalog.error) return { success: false, error: catalog.error };
    if (!catalog.instructions.some((i) => i.id === standardId)) {
      return { success: false, error: `"${standardId}" is not a standard instruction of ${ctx.svc.ProvidedServiceId} / ${ctx.step.StepDescription}.` };
    }
    if (ctx.instructions.some((i) => i.AssignedServiceStepInstructionId === standardId)) {
      return { success: false, error: `Step "${ctx.step.StepDescription}" already has that standard instruction.` };
    }
  }
  if (ctx.instructions.some((i) => String(i.InstructionText || '').trim() === instructionText)) {
    return { success: false, error: `Step "${ctx.step.StepDescription}" already has an instruction with that exact text.` };
  }

  // Position is 1..n+1 within the step (default: last). Like Pick/Pack
  // create, the new row is appended first and the step is then renumbered
  // with the confirmed one-save resequence.
  const n = ctx.instructions.length;
  const pos = position == null ? n + 1 : Number(position);
  if (!Number.isInteger(pos) || pos < 1 || pos > n + 1) {
    return { success: false, error: `Position must be between 1 and ${n + 1} — step "${ctx.step.StepDescription}" has ${n} instruction(s).` };
  }
  const sequence = ctx.instructions.reduce((m, i) => Math.max(m, Number(i.Sequence) || 0), 0) + 1;
  const instructionId = standardId || newVasInstructionId(ctx.svc, ctx.step);
  const saved = await saveVasStepInstruction(orgUpper, servicePk, stepPk, {
    AssignedServiceStepInstructionId: instructionId,
    InstructionText: instructionText,
    Sequence: sequence
  }, token);
  if (saved.error) return { success: false, error: `Create failed ${saved.error}` };

  // The new row is expected to differ, so verifyVasStep's own comparison
  // (which excludes nothing for a create) is ignored; compare without it.
  const v = await verifyVasStep(orgUpper, servicePk, stepPk, ctx.instructions, null, token);
  if (!v.after) return { success: false, error: v.error || 'Saved, but re-reading failed.' };
  const created = v.after.find((i) => i.AssignedServiceStepInstructionId === instructionId);
  if (!created) return { success: false, error: 'MAWM accepted the create, but the new instruction is not on the step.' };
  if (stepFingerprint(v.after, created.PK) !== stepFingerprint(ctx.instructions, null)) {
    return { success: false, error: 'Created, but other instructions on this step changed unexpectedly — refresh and check.' };
  }
  // Slot it in at the chosen position and renumber 1..n+1 (also closes gaps).
  const order = ctx.instructions
    .map((i) => ({ pk: String(i.PK), seq: Number(i.Sequence) || 0 }))
    .sort((a, b) => a.seq - b.seq || a.pk.localeCompare(b.pk))
    .map((x) => x.pk);
  order.splice(pos - 1, 0, String(created.PK));
  const contiguous = v.after.every((i) => Number(i.Sequence) === order.indexOf(String(i.PK)) + 1);
  if (!contiguous) {
    const rs = await vasResequenceInstructions({ org, servicePk, stepPk, pks: order }, token);
    if (!rs.success) {
      return {
        success: true,
        pk: String(created.PK),
        instructionText: created.InstructionText,
        position: n + 1,
        steps: shapeVasSteps(v.svc),
        warning: `Added at the end, but moving it to position ${pos} failed: ${rs.error}`
      };
    }
    if (rs.steps) return { success: true, pk: String(created.PK), instructionText: created.InstructionText, position: pos, steps: rs.steps };
  }
  return { success: true, pk: String(created.PK), instructionText: created.InstructionText, position: pos, steps: shapeVasSteps(v.svc) };
}

async function vasUpdateInstruction({ org, servicePk, stepPk, instructionPk, instructionText }, token) {
  const orgUpper = org.toUpperCase();
  const ctx = await loadEditableVasStep(orgUpper, servicePk, stepPk, instructionPk, token);
  if (ctx.error) return { success: false, error: ctx.error };

  const saved = await saveVasStepInstruction(orgUpper, servicePk, stepPk, { PK: String(instructionPk), InstructionText: instructionText }, token);
  if (saved.error) return { success: false, error: `Update failed ${saved.error}` };

  const v = await verifyVasStep(orgUpper, servicePk, stepPk, ctx.instructions, instructionPk, token);
  if (v.error) return { success: false, error: v.error };
  const updated = v.after.find((i) => String(i.PK) === String(instructionPk));
  if (!updated || updated.InstructionText !== instructionText) {
    return { success: false, error: 'MAWM accepted the update, but re-reading shows the text did not change.' };
  }
  return {
    success: true,
    pk: String(instructionPk),
    instructionText: updated.InstructionText,
    previousText: ctx.instruction.InstructionText,
    steps: shapeVasSteps(v.svc)
  };
}

async function vasDeleteInstruction({ org, servicePk, stepPk, instructionPk }, token) {
  const orgUpper = org.toUpperCase();
  const ctx = await loadEditableVasStep(orgUpper, servicePk, stepPk, instructionPk, token);
  if (ctx.error) return { success: false, error: ctx.error };

  const saved = await saveVasStepInstruction(orgUpper, servicePk, stepPk, { ApplyAction: 'DELETE', PK: String(instructionPk) }, token);
  if (saved.error) return { success: false, error: `Delete failed ${saved.error}` };

  const v = await verifyVasStep(orgUpper, servicePk, stepPk, ctx.instructions, instructionPk, token);
  if (v.error) return { success: false, error: v.error };
  if (v.after.some((i) => String(i.PK) === String(instructionPk))) {
    return { success: false, error: 'MAWM accepted the delete, but the instruction is still on the step.' };
  }
  // Close the gap in the step's numbering (same as Pick/Pack delete).
  const remaining = v.after
    .map((i) => ({ pk: String(i.PK), seq: Number(i.Sequence) || 0 }))
    .sort((a, b) => a.seq - b.seq || a.pk.localeCompare(b.pk));
  if (remaining.length > 0 && remaining.some((x, i) => x.seq !== i + 1)) {
    const rs = await vasResequenceInstructions({ org, servicePk, stepPk, pks: remaining.map((x) => x.pk) }, token);
    if (rs.success && rs.steps) {
      return { success: true, pk: String(instructionPk), deletedText: ctx.instruction.InstructionText, steps: rs.steps };
    }
    return {
      success: true, pk: String(instructionPk), deletedText: ctx.instruction.InstructionText, steps: shapeVasSteps(v.svc),
      warning: `Deleted, but renumbering the remaining instructions failed: ${rs.error}`
    };
  }
  return { success: true, pk: String(instructionPk), deletedText: ctx.instruction.InstructionText, steps: shapeVasSteps(v.svc) };
}

// Reorder a step's VAS instructions: `pks` is the step's full instruction
// PK list in the new order. One save carries every changed {PK, Sequence},
// so the reorder is a single MAWM transaction (unlike Pick/Pack reorder,
// which is one PUT per row).
async function vasResequenceInstructions({ org, servicePk, stepPk, pks }, token) {
  const orgUpper = org.toUpperCase();
  const ctx = await loadEditableVasStep(orgUpper, servicePk, stepPk, null, token);
  if (ctx.error) return { success: false, error: ctx.error };

  const current = ctx.instructions.map((i) => String(i.PK));
  if (pks.length !== current.length || new Set(pks).size !== pks.length || !pks.every((pk) => current.includes(pk))) {
    return { success: false, stale: true, error: `The instructions on step "${ctx.step.StepDescription}" changed since the page loaded — refresh and try again.` };
  }
  const byPk = new Map(ctx.instructions.map((i) => [String(i.PK), i]));
  const changes = pks
    .map((pk, i) => ({ PK: pk, Sequence: i + 1 }))
    .filter((c) => Number(byPk.get(c.PK).Sequence) !== c.Sequence);
  if (changes.length === 0) return { success: true, updatedCount: 0, steps: null };

  const resp = await mawmPost(ASSIGNED_SERVICE_SAVE_PATH, token, orgUpper, {
    PK: String(servicePk),
    AssignedServiceStep: [{ PK: String(stepPk), AssignedServiceStepInstruction: changes }]
  });
  if (!resp.httpOk || resp.parseError || resp.success === false) {
    return { success: false, error: `Reorder failed ${describeMawmFailure(resp)}` };
  }

  // Verify: same instructions, same ids/texts, sequences exactly 1..n in the new order.
  const r = await getAssignedServiceByPk(orgUpper, servicePk, token);
  if (r.error) return { success: false, stale: true, error: `Saved, but re-reading failed: ${r.error}` };
  const step = asArray(r.svc.AssignedServiceStep).find((st) => String(st.PK) === String(stepPk));
  const after = new Map(asArray(step && step.AssignedServiceStepInstruction).map((i) => [String(i.PK), i]));
  const bad = pks.find((pk, i) => {
    const a = after.get(pk); const b = byPk.get(pk);
    return !a || Number(a.Sequence) !== i + 1 || a.InstructionText !== b.InstructionText ||
      a.AssignedServiceStepInstructionId !== b.AssignedServiceStepInstructionId;
  });
  if (bad || after.size !== pks.length) {
    return { success: false, stale: true, error: 'MAWM accepted the reorder, but re-reading shows a different result — refresh and check.' };
  }
  return { success: true, updatedCount: changes.length, stepDescription: step.StepDescription, steps: shapeVasSteps(r.svc) };
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

  if (action === 'vas_step_catalog') {
    const org = req.body.org;
    const providedServiceId = req.body.providedServiceId != null ? String(req.body.providedServiceId) : '';
    const stepId = req.body.stepId != null ? String(req.body.stepId) : '';
    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    if (!providedServiceId || !stepId) return res.status(400).json({ success: false, error: 'providedServiceId and stepId are required' });
    try {
      const r = await getVasStepCatalog(String(org).toUpperCase(), providedServiceId, stepId, token);
      return res.json(r.error ? { success: false, error: r.error } : { success: true, instructions: r.instructions });
    } catch (e) {
      console.error('[vas_step_catalog] error:', e);
      return res.json({ success: false, error: e.message || 'Lookup failed', tokenInvalid: !!e.tokenInvalid });
    }
  }

  if (action === 'vas_resequence_instructions') {
    const org = req.body.org;
    const servicePk = req.body.servicePk != null ? String(req.body.servicePk).trim() : '';
    const stepPk = req.body.stepPk != null ? String(req.body.stepPk).trim() : '';
    const pks = Array.isArray(req.body.pks) ? req.body.pks.map((x) => String(x).trim()) : [];
    const isNumeric = (v) => /^-?\d+$/.test(v);
    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    if (!isNumeric(servicePk) || !isNumeric(stepPk)) {
      return res.status(400).json({ success: false, error: 'Numeric servicePk and stepPk are required' });
    }
    if (pks.length < 2 || pks.length > 50 || !pks.every(isNumeric)) {
      return res.status(400).json({ success: false, error: 'pks must be 2–50 numeric instruction PKs' });
    }
    try {
      const result = await vasResequenceInstructions({ org, servicePk, stepPk, pks }, token);
      await forwardUsageEvent({
        event_name: result.success ? 'vas_instructions_resequenced' : 'vas_instructions_resequence_failed',
        org: String(org).toUpperCase(),
        ...(result.success ? { updatedCount: result.updatedCount } : { error: result.error })
      });
      return res.json(result);
    } catch (e) {
      console.error('[vas_resequence_instructions] error:', e);
      await forwardUsageEvent({ event_name: 'vas_instructions_resequence_failed', org: String(org).toUpperCase(), error: e.message });
      return res.json({ success: false, stale: true, error: e.message || 'Reorder failed', tokenInvalid: !!e.tokenInvalid });
    }
  }

  if (action === 'vas_create_instruction' || action === 'vas_update_instruction' || action === 'vas_delete_instruction') {
    const org = req.body.org;
    const servicePk = req.body.servicePk != null ? String(req.body.servicePk).trim() : '';
    const stepPk = req.body.stepPk != null ? String(req.body.stepPk).trim() : '';
    const instructionPk = req.body.instructionPk != null ? String(req.body.instructionPk).trim() : '';
    const instructionText = req.body.instructionText != null ? String(req.body.instructionText).trim() : '';
    const position = req.body.position != null && req.body.position !== '' ? Number(req.body.position) : null;
    const standardId = req.body.instructionId != null && req.body.instructionId !== '' ? String(req.body.instructionId) : null;
    const isNumeric = (v) => /^-?\d+$/.test(v);

    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    if (!isNumeric(servicePk) || !isNumeric(stepPk)) {
      return res.status(400).json({ success: false, error: 'Numeric servicePk and stepPk are required' });
    }
    if (action !== 'vas_create_instruction' && !isNumeric(instructionPk)) {
      return res.status(400).json({ success: false, error: 'A numeric instructionPk is required' });
    }
    if (action !== 'vas_delete_instruction' && !instructionText) {
      return res.status(400).json({ success: false, error: 'Instruction text cannot be empty' });
    }

    const verb = action.replace('vas_', '').replace('_instruction', ''); // create | update | delete
    try {
      const args = { org, servicePk, stepPk, instructionPk, instructionText, position, instructionId: standardId };
      const result = verb === 'create'
        ? await vasCreateInstruction(args, token)
        : verb === 'update'
          ? await vasUpdateInstruction(args, token)
          : await vasDeleteInstruction(args, token);
      await forwardUsageEvent({
        // created / updated / deleted, or create_failed / update_failed / delete_failed
        event_name: result.success ? `vas_instruction_${verb}d` : `vas_instruction_${verb}_failed`,
        org: String(org).toUpperCase(),
        ...(result.success ? {} : { error: result.error })
      });
      return res.json(result);
    } catch (e) {
      console.error(`[${action}] error:`, e);
      await forwardUsageEvent({ event_name: `vas_instruction_${verb}_failed`, org: String(org).toUpperCase(), error: e.message });
      return res.json({ success: false, error: e.message || 'VAS change failed', tokenInvalid: !!e.tokenInvalid });
    }
  }

  if (action === 'resequence_instructions') {
    const org = req.body.org;
    const olpnId = req.body.olpnId != null ? String(req.body.olpnId).trim() : '';
    const pks = Array.isArray(req.body.pks) ? req.body.pks.map((x) => String(x).trim()) : [];

    if (!org || !String(org).trim()) return res.status(400).json({ success: false, error: 'ORG required' });
    if (!olpnId) return res.status(400).json({ success: false, error: 'olpnId required' });
    if (pks.length < 2 || pks.length > 50 || !pks.every((pk) => /^-?\d+$/.test(pk))) {
      return res.status(400).json({ success: false, error: 'pks must be 2–50 numeric instruction PKs' });
    }

    try {
      const result = await resequenceInstructions({ org, olpnId, pks }, token);
      await forwardUsageEvent({
        event_name: result.success ? 'instructions_resequenced' : 'instructions_resequence_failed',
        org: String(org).toUpperCase(),
        ...(result.success ? { updatedCount: result.updatedCount } : { error: result.error })
      });
      return res.json(result);
    } catch (e) {
      console.error('[resequence_instructions] error:', e);
      await forwardUsageEvent({ event_name: 'instructions_resequence_failed', org: String(org).toUpperCase(), error: e.message });
      return res.json({ success: false, partial: true, error: e.message || 'Reorder failed', tokenInvalid: !!e.tokenInvalid });
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
