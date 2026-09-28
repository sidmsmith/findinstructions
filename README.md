# Find Instructions

Enter a MAWM Order ID or oLPN ID and see every runtime `assignedInstruction`
record linked to it (Pick and Pack), joined back to the Order Line, Task,
oLPN, and oLPN Detail that produced it.

## Setup

```
npm install
cp .env.example .env   # fill in MANHATTAN_SECRET / MANHATTAN_PASSWORD
npm start               # or: npm run dev (vercel dev)
```

Open http://localhost:3000, enter an ORG (e.g. `SS-DEMO`), authenticate,
then search by Order ID or oLPN ID.

## Silent auth via `.token`

A `.token` file at the project root (gitignored) holds a raw JWT bearer
token. On load, the app decodes its `exp` and `organization` claims
(no signature verification — same unverified-decode approach as
`Work/vasexecution`) and, if it isn't expired, authenticates silently and
skips the ORG prompt entirely.

- **Token exists and is still valid** → straight to the search screen, no
  prompt.
- **Token missing, expired, or rejected by MAWM (401) mid-search** → falls
  back to the ORG prompt (password-grant OAuth), and writes the newly
  obtained token back to `.token` so the next run is silent again.

Since these tokens expire every few hours, drop a fresh one into `.token`
(or just let a manual re-auth overwrite it) when it goes stale.

## How the join works

1. `POST /task/api/task/task/search` with a `TaskDetail.OrderId=` or
   `TaskDetail.OlpnId=` dotted-path filter — returns Task rows with a nested
   `TaskDetail[]` array (`OrderId`, `OrderLineId`, `ItemId`, `OlpnId`,
   `OlpnDetailId`, `Status`).
2. For every distinct `OlpnId`, `POST /pickpack/api/pickpack/olpn/search`
   with a template pulling `Status` and `AssignedInstruction` at both the
   oLPN header and `OlpnDetail[]` level — each instruction carries an
   `InstructionRequestorId`. **oLPNs with `Status = '9000'` (Cancelled —
   `olpn_status` domain, confirmed in `_conventions/statuses.md`) are
   excluded here** — a re-waved/unwaved order leaves earlier-wave oLPN
   records behind, and their instructions are stale. Task status is *not*
   filtered — a completed task's oLPN still shows its instructions as long
   as the oLPN itself isn't cancelled. Excluded oLPNs are still listed in
   the "Unmatched / no instruction found" panel for visibility.
3. `POST /pickpack/api/fw-aux-svcs/assignedInstruction/search`, filtered by
   `OrgId`, `FacilityId`, `InstructionRequestorTypeId`, and the collected
   `InstructionRequestorId` values (IN-clause first, falling back to one
   request per ID if the environment rejects it).
4. Everything is joined back together on `InstructionRequestorId` (→ oLPN /
   oLPN detail) and `OlpnId`/`OlpnDetailId` (→ task detail → order line).

Unmatched records (an oLPN that couldn't be found, an oLPN detail with a
requestor ID but no runtime instruction row, a task detail whose oLPN
never resolved) are surfaced in the UI rather than silently dropped.

## Evidence level of each endpoint

- **`/oauth/token`** and **`/pickpack/api/pickpack/olpn/search`** — confirmed
  both by `Work/mawm_api_library` (`_conventions/auth-conventions.md`,
  `olpn/api.md`) and directly in `Work/taskcompletion/mawm_client.py`
  (`search_olpn`).
- **`/task/api/task/task/search`**, queried with a `TaskDetail.<field>`
  dotted-path filter and read via the nested `TaskDetail[]` array — confirmed
  live against SS-DEMO in `Work/taskcompletion/mawm_client.py`
  (`search_task`, `search_task_id_for_container`, `search_task_id_for_olpn`).
  This **corrects** the originating Glean report, which proposed
  `/pickpack/api/task/taskDetail/search` — that path was not independently
  verified anywhere in this ecosystem, whereas `/task/api/task/task/search`
  is.
- **`/pickpack/api/fw-aux-svcs/assignedInstruction/search`** and the
  `OlpnDetail.AssignedInstruction` → `InstructionRequestorId` join — taken
  from the supplied Glean report, not independently found anywhere else in
  this ecosystem's own code. **Confirmed live** against SS-DEMO order
  `6000012` (2026-08-17): returned real `Repack`/`Apply Labels` Pick
  instructions correctly joined back to order line, item, oLPN, oLPN
  detail, and task detail.

## Usage tracking

If `MANHATTAN_USAGE_INGEST_URL` is set, the app forwards `app_opened`,
`auth_success`/`auth_failed`, and `search_completed`/`search_failed`
events to the Manhattan App Usage Dashboard's Neon ingest endpoint
(`app_name: "findinstructions-app"`). Forwarding is best-effort — a
failed or unconfigured ingest never blocks the request it's attached to.

## Notes / known limitations

- Facility is derived as `{ORG}-DM1`, the ecosystem-wide convention (not a
  MAWM requirement — see `auth-conventions.md`).
- No CLI, CSV export, or pagination loop beyond a single generous `Size` per
  call — reasonable for one order/oLPN's worth of data. If a search is
  truncated (very large fan-out), the "Raw API responses" panel will show it
  (`header.totalCount` vs. rows actually returned).
- The only write call is the Instruction-text edit below.

## Editing an instruction's text

Each result row's Instruction cell has a pencil icon. Clicking it opens an
inline editor (Enter/✓ saves, Esc/✗ cancels) that changes **only**
`InstructionText` on that one runtime `assignedInstruction` record — the
master instruction definition is untouched. The backend
(`update_instruction` action):

1. Re-reads the record by `PK` via `assignedInstruction/search` and checks
   it belongs to the current `{ORG}` / `{ORG}-DM1`.
2. `PUT /pickpack/api/fw-aux-svcs/assignedInstruction/{PK}` with the full
   entity (`OrgId`, `FacilityId`, `InstructionId`, `InstructionText`,
   `InstructionType`, `Sequence`, `InstructionRequestorTypeId`,
   `InstructionRequestorId`, `PK`), only `InstructionText` changed. This
   update-by-PK call came from a Glean conversation and was confirmed by
   hand in Postman against SS-DEMO (2026-09-28).
3. Re-reads the record and only reports success if the new text actually
   persisted.
