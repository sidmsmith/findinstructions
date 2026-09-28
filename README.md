# Find Instructions

Enter a MAWM Order ID or oLPN ID and see every runtime `assignedInstruction`
record linked to it (Pick and Pack), joined back to the Order Line, Task,
oLPN, and oLPN Detail that produced it. From the results you can also
**add** a new instruction to any oLPN (header or a specific detail), and
**edit** (pencil icon — instruction text only) or **delete** (trash icon,
behind a confirmation) an existing one — see
[Creating, updating and deleting instructions](#creating-updating-and-deleting-instructions).

## Setup

```
npm install
cp .env.example .env   # fill in MANHATTAN_SECRET / MANHATTAN_PASSWORD
npm start               # or: npm run dev (vercel dev)
```

Open http://localhost:3000, enter an ORG (e.g. `SS-DEMO`), authenticate,
then enter an Order ID or oLPN ID in the single search box.

## One search box: Order first, then oLPN

There is no Order/oLPN toggle. The value is searched as an **Order**
first; if no order matches, the same value is searched as an **oLPN**.
A "Matched as" badge shows which one produced the results.

- "Order found" means the Task search (`TaskDetail.OrderId=`) returned at
  least one task detail. That Task search is the app's only order
  lookup, so an order with no tasks at all falls through to the oLPN
  search.
- The oLPN fallback costs one extra Task search (the failed Order
  attempt), whose raw response is kept under `orderAttempt` in the
  diagnostics panel.
- URL parameters `Id`, `Order`/`OrderId`, and `Olpn`/`OlpnId` all feed
  the same search, so older links still work. The API still accepts an
  explicit `mode: 'order' | 'olpn'` (no fallback); the UI always sends
  `mode: 'auto'`.

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

1. `POST /task/api/task/task/search` with a `TaskDetail.OrderId=` (or, on
   the oLPN fallback, `TaskDetail.OlpnId=`) dotted-path filter — returns Task rows with a nested
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
   **Header-level** (`Olpn`) instructions belong to the whole oLPN, so they
   get no order line, item, oLPN detail, or task detail (the table shows
   *Header* in the Order Line and oLPN Detail columns). Their Order and
   Task are shown only when every task detail on that oLPN has the same
   one. Header instructions sort before the oLPN's detail instructions.

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
`auth_success`/`auth_failed`, `search_completed`/`search_failed`,
`instruction_created`/`instruction_create_failed`,
`instruction_updated`/`instruction_update_failed`, and
`instruction_deleted`/`instruction_delete_failed` events to the Manhattan
App Usage Dashboard's Neon ingest endpoint
(`app_name: "findinstructions-app"`). Forwarding is best-effort — a
failed or unconfigured ingest never blocks the request it's attached to.

## Notes / known limitations

- Facility is derived as `{ORG}-DM1`, the ecosystem-wide convention (not a
  MAWM requirement — see `auth-conventions.md`).
- No CLI, CSV export, or pagination loop beyond a single generous `Size` per
  call — reasonable for one order/oLPN's worth of data. If a search is
  truncated (very large fan-out), the "Raw API responses" panel will show it
  (`header.totalCount` vs. rows actually returned).
- The only write calls are the instruction create, edit and delete
  below; the search/join itself is read-only.

## Creating, updating and deleting instructions

### Create ("Add instruction to oLPN …" → `olpn_targets` + `create_instruction`)

The results show one **Add instruction** button per active (non-Cancelled)
oLPN found — including oLPNs with no instructions yet. It opens a modal:

- **Attach to** — "oLPN header" or "Detail N – Item X" (with a count of
  existing instructions on each).
- **Type** — Pick or Pack.
- **Sequence** — pre-filled with the next free number for that target.
- **Instruction ID** — required dropdown (starts blank; **Create** stays
  greyed out until a listed ID is selected) of the master
  instruction definitions, loaded from
  `POST /aux-svcs/api/aux-svcs/instruction/search`
  (`Query: "InstructionId != null"`, template `InstructionId` +
  `InstructionText`, `Size: 1000`; 77 in SS-DEMO). Loaded once per page.
- **Instruction text** — starts blank; picking an Instruction ID fills in
  that instruction's default text, which the user can then edit.

How the target is resolved: every oLPN and oLPN detail has an
*instruction requestor ID* from the moment it exists, whether or not it
has instructions. `olpn/search` with `OlpnAndDetailsServiceRequestorIds`
in the `Template` returns them as one comma-separated string — the
header's ID first, then one per `OlpnDetail` in array order (observed on
SS-DEMO oLPNs `0000099999100015639` and `0000099999100015677`). If the
ID count isn't exactly 1 + number of details, the app refuses to create.
The ID is resolved on the server at create time, never taken from the
browser.

The backend (`create_instruction`):

1. Re-reads the oLPN and resolves the chosen target's requestor ID;
   re-loads the instruction list and rejects an `InstructionId` that isn't
   defined there, or that the target already has (it must be unique per
   requestor).
2. `POST /pickpack/api/fw-aux-svcs/assignedInstruction/save` with
   `InstructionRequestorId`, `InstructionRequestorTypeId` (`Olpn` or
   `OlpnDetail`), `InstructionType`, `InstructionId`, `InstructionText`,
   `Sequence` — **no `PK`** (MAWM generates it) and no `OrgId`/`FacilityId`
   (taken from the headers). `InstructionId` is the selected master
   instruction; `InstructionText` is whatever the user left in the text
   box.
3. Finds the new record via `assignedInstruction/search`.
4. Re-reads the oLPN and checks the new instruction appears under the
   **intended** target. If it shows up elsewhere, it reports an error with
   the new PK so it can be deleted; if the oLPN doesn't list it at all
   yet, it reports a warning (it won't appear in search results).
5. The UI then re-runs the search so the new row appears fully joined.

Evidence: endpoint and payload from a Glean conversation; confirmed
working through this modal against SS-DEMO oLPN `0000099999100015677`
(2026-09-28) — a header instruction ("Cut Paper") landed on the header and
a detail instruction ("BOGO Sticker") on detail 1, confirming the header
ID comes first in `OlpnAndDetailsServiceRequestorIds`.

### Update and delete

Both actions act on **one runtime `assignedInstruction` record** (the
instruction attached to that oLPN / oLPN detail), identified by its `PK`.
The master instruction definition is never touched. Both endpoints live at
`/pickpack/api/fw-aux-svcs/assignedInstruction/{PK}`, sent with the usual
`selectedOrganization` / `selectedLocation` headers. Before either call the
backend re-reads the record by `PK` (`assignedInstruction/search`,
`Query: "PK=<pk>"`) and refuses to act unless exactly one record matches
and it belongs to the current `{ORG}` / `{ORG}-DM1`.

### Edit (pencil icon → `update_instruction`)

Opens an inline editor in the Instruction cell (Enter/✓ saves, Esc/✗
cancels). Only `InstructionText` can be changed.

- `PUT .../assignedInstruction/{PK}` with the full entity (`OrgId`,
  `FacilityId`, `InstructionId`, `InstructionText`, `InstructionType`,
  `Sequence`, `InstructionRequestorTypeId`, `InstructionRequestorId`, `PK`),
  only `InstructionText` changed — the other values come from the fresh
  read, not from the browser.
- The record is re-read afterwards; success is only reported if the new
  text actually persisted.
- Evidence: from a Glean conversation, confirmed in Postman and then live
  through this app against SS-DEMO oLPN `0000099999100015639`
  (2026-09-28).

### Delete (trash icon → `delete_instruction`)

Opens a confirmation modal showing the instruction text and warning that
the delete cannot be undone. Only **Delete** in that modal sends anything;
Cancel, Esc, or clicking outside closes it.

- `DELETE .../assignedInstruction/{PK}` (no body). A 2xx with an empty body
  counts as success unless MAWM returns `success: false`.
- The record is re-read afterwards; success is only reported if search no
  longer returns it. The row(s) with that `PK` are then removed from the
  table and the "Instructions found" count is updated.
- Evidence: endpoint supplied by the user and confirmed working through
  this app against SS-DEMO (2026-09-28).
