# Find Instructions

Enter a MAWM Order ID or oLPN ID and see every runtime `assignedInstruction`
record linked to it (Pick and Pack), joined back to the Order Line, Task,
oLPN, and oLPN Detail that produced it. From the results you can also
**add** a new instruction to any oLPN (header or a specific detail),
**edit** (pencil icon — instruction text only) or **delete** (trash icon,
behind a confirmation) an existing one, and **reorder** (▲▼ arrows) the
instructions within a group — see
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
   one.
5. Rows are sorted per oLPN: header first, then details by number; within
   a target Pick before Pack; then `Sequence`. Each **sequence group** —
   same oLPN, same target (header or one detail), same `InstructionType` —
   sits together under a full-width label row (colored Pick / Pack badge,
   oLPN, target, count).
6. **VAS** (read-only): `POST /pickpack/api/fw-aux-svcs/assignedService/search`
   with `ServiceRequestorId IN (...)` over **every** requestor ID on the
   active oLPNs (from `OlpnAndDetailsServiceRequestorIds`, now requested in
   step 2's template). Each assigned service is shown below the table as a
   card — service, status, target, order line — with its
   `AssignedServiceStep[]` and each step's
   `AssignedServiceStepInstruction[]` text. Step instructions can be
   edited, added and deleted while the step is Created — see "Editing VAS
   step instructions" below.

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

## Assigned instructions vs. VAS

Two different MAWM record types hang off the **same requestor IDs** (the
oLPN header and each oLPN detail):

| | Assigned instructions (Pick/Pack table) | VAS services (cards below) |
|---|---|---|
| Search | `fw-aux-svcs/assignedInstruction/search` | `fw-aux-svcs/assignedService/search` |
| Filter | `InstructionRequestorId in (...)` | `ServiceRequestorId IN (...)` |
| Shape | one flat row per instruction | service → `AssignedServiceStep[]` → `AssignedServiceStepInstruction[]` |
| Instruction fields | `InstructionId`, `InstructionText`, `InstructionType`, `Sequence` | `AssignedServiceStepInstructionId`, `InstructionText`, `Sequence` |
| Master data | `aux-svcs/instruction` | `aux-svcs/providedService` (VAS type → steps → `StepInstruction`) |
| In this app | search, create, edit, reorder, delete | search; edit, add, delete step instructions (Created only) |

The VAS endpoint and filter come from `Work/vasexecution`
(`fetch_assigned_service_rows`). Both record types on one requestor were
observed live on SS-DEMO oLPN `0000099999100015592` detail 1 (2026-10-06),
and the VAS rows there sit on the same header/detail ID positions as the
assigned instructions.

## Editing VAS step instructions

Each instruction on a VAS card has a pencil (inline edit) and trash
(confirmation modal); each step has **+ Add instruction** (inline). These
appear only when the **service and the step are both Created (1000)** —
the only status this was tested at — otherwise the step shows a
"read-only" note.

Steps and step instructions have no endpoints of their own (their GET and
search 404), so all three go through the parent service:
`POST /pickpack/api/fw-aux-svcs/assignedService/save` with a **partial**
body — the service PK, the one step PK, and the one instruction. Omitted
steps and instructions are left unchanged.

| Action | Instruction object sent |
|---|---|
| `vas_create_instruction` | `{AssignedServiceStepInstructionId, InstructionText, Sequence}` — no PK (MAWM generates it). The add editor's **Instruction** dropdown lists the step's **standard** instructions from the VAS master definition (`POST /aux-svcs/api/aux-svcs/providedService/search` → `ProvidedServiceStep[].StepInstruction[]`, via `vas_step_catalog`) that aren't already on the step; picking one fills its default text (editable) and uses its master `StepInstructionId` as the id — the same id assigned services already use. **Custom text…** generates `{ProvidedServiceId}_{StepId}_ins_{random}` (≤ 50 chars). **Duplicates are rejected**: a standard id already on the step, or custom text identical to an instruction already on it. The inline add editor has a **Position** dropdown 1…n+1 (default last): the row is appended, then the step is renumbered with one resequence save (also closing any gaps); if that second save fails the instruction stays at the end and a warning is shown |
| `vas_update_instruction` | `{PK, InstructionText}` |
| `vas_delete_instruction` | `{ApplyAction: "DELETE", PK}` |
| `vas_resequence_instructions` | one `{PK, Sequence}` per instruction whose number changes |

Each action first re-reads the service (`GET .../assignedService/{PK}`)
and refuses unless it belongs to `{ORG}`/`{ORG}-DM1`, the service and step
are Created, and the step/instruction exist. Afterwards it re-reads again
and only reports success if the change is there **and every other
instruction on the step is unchanged**. MAWM stamps touched rows'
`Process` with `/fw-aux-svcs/assignedService/save` (audit only).

**Reorder** (▲▼ next to each instruction when a Created step has 2+):
saves immediately, like the Pick/Pack arrows. `vas_resequence_instructions`
sends the step's full PK list in the new order; the server checks it is
exactly the step's current instructions, then sends **one** save whose
instruction list is just the changed `{PK, Sequence}` pairs — so the whole
renumber is a single MAWM transaction (Pick/Pack reorder needs one PUT
per row). It re-reads and only reports success if the sequences are
1…n in the new order with ids and texts unchanged; otherwise it reloads
the search. Confirmed on SS-DEMO (swap and swap back, 2026-10-06).

**Big numbers**: MAWM returns the nested parent references
(`AssignedService.PK`, `AssignedServiceStep.PK`) as bare 19-digit JSON
numbers, which `JSON.parse` rounds. `parseMawmJson()` quotes any bare
16+ digit number before parsing, for every MAWM response.

Evidence: endpoint and payload shapes from a Glean answer; create → update
→ delete confirmed on SS-DEMO (2026-10-06) with the whole service diffed
after each call.

## Usage tracking

If `MANHATTAN_USAGE_INGEST_URL` is set, the app forwards `app_opened`,
`auth_success`/`auth_failed`, `search_completed`/`search_failed`,
`instruction_created`/`instruction_create_failed`,
`instructions_resequenced`/`instructions_resequence_failed`,
`vas_instruction_created`/`_updated`/`_deleted` (and `vas_instruction_create_failed` etc.),
`vas_instructions_resequenced`/`vas_instructions_resequence_failed`,
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
- **Sequence** — a dropdown limited to **1…n+1**, where n is the number
  of existing instructions on that target **of that type** (sequences are
  numbered per target + Pick/Pack); defaults to last. The server enforces
  the same range.
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
5. Inserts the new instruction at the chosen position and renumbers the
   group 1…n+1 (only changed rows are written, via the same update-by-PK
   call as reorder) — choosing 2 when there are 3 moves the old 2 and 3 to
   3 and 4, rather than leaving two 2s. Existing gaps (e.g. 1, 2, 3, 9)
   are closed up at the same time.
6. The UI then re-runs the search so the new row appears fully joined.

Evidence: endpoint and payload from a Glean conversation; confirmed
working through this modal against SS-DEMO oLPN `0000099999100015677`
(2026-09-28) — a header instruction ("Cut Paper") landed on the header and
a detail instruction ("BOGO Sticker") on detail 1, confirming the header
ID comes first in `OlpnAndDetailsServiceRequestorIds`.

### Reorder (▲▼ arrows → `resequence_instructions`)

Sequence only matters within a group: same oLPN, same target (header or
one detail), same `InstructionType`. Arrows appear only on groups with 2+
instructions (up disabled on the first, down on the last). Each click
**saves immediately** — there is no Save button:

1. The browser sends the group's full PK list in its new order.
2. The backend re-reads the oLPN and refuses unless those PKs are exactly
   one whole group (nothing missing or added since the page loaded).
3. It renumbers the group 1..n and PUTs only the rows whose `Sequence`
   changed — the same `PUT .../assignedInstruction/{PK}` as the text edit,
   full entity with only `Sequence` changed (rows taken from the fresh
   oLPN read).
4. It re-reads the oLPN and only reports success if the new order stuck.

All arrows are disabled while a save is in flight. If a save fails part
way (e.g. the second of two PUTs), or the page was stale, the search is
re-run so the table shows MAWM's real order, and the error is shown.

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
- After the delete, the rest of that sequence group (same requestor +
  type) is renumbered 1…n so no gap is left (deleting 2 of 1, 2, 3 leaves
  1, 2), with the same per-row PUT as reorder. VAS deletes do the same with
  one resequence save.
- The record is re-read afterwards; success is only reported if search no
  longer returns it. The row(s) with that `PK` are then removed from the
  table and the "Instructions found" count is updated.
- Evidence: endpoint supplied by the user and confirmed working through
  this app against SS-DEMO (2026-09-28).
