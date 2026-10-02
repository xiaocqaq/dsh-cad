# dsh-plugin-cad

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) plugin that lets an
agent **operate a running AutoCAD session**: read layers and entities, draw, dimension, hatch,
modify, and save DWG — without installing anything inside AutoCAD.

Built against Harness `0.2.0-rc2`; bring-up verified on **AutoCAD 2026 (R25.1.60.0, zh-CN)**.

## Why this design

The reference evaluation (*Codex for CAD 工程应用评测报告*) tested four integration paths and found
the **live-CAD** path the most valuable, but measured three concrete failure modes. This plugin is
built around fixing them:

| Measured failure | What this plugin does |
| --- | --- |
| 「仅从图上测量时是有偏移500mm」— no scale bar, units guessed | Every tool takes **metres**; the plugin converts via `unitsPerMeter`. Results return both metres and raw drawing units. |
| "能不能准确选中对象" — picking the right entities | `cad_query_entities` is the mandatory first step; `cad_batch` resolves a filter and acts on it in one atomic call so the target set cannot drift. |
| Cross-layer linkage edits missing objects | `cad_transform` applies one offset to a resolved handle set, preserving relative spacing by construction. |

Three integration options were considered:

- **Generate `.lsp` for `APPLOAD`** — matches the lowest-rated path; no live state, no return values.
- **A compiled .NET DLL loaded inside AutoCAD** — most powerful, but needs MSBuild plus a DLL per
  AutoCAD version, and cannot be built or tested without the .NET SDK.
- **stdio JSON bridge → AutoCAD COM** ✅ — AutoCAD already registers an automation server, so the
  plugin attaches to the open session with no in-CAD install and no compile step.

## Architecture

```
dsh tools  →  CadService (unit conversion)  →  CadTransport
                                                 ├── ComTransport        → assets/cad-bridge.ps1 → AutoCAD COM
                                                 └── SimulationTransport → in-memory drawing
```

The transport interface (`src/protocol.ts`) is the seam. `SimulationTransport` is a **real**
implementation of the whole operation surface, not a stub — it is how the tool layer, the unit
conversion and the tests are exercised without AutoCAD, and it lets you rehearse prompts without
touching a live drawing.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-plugin-cad
```

Or from a checkout:

```sh
pnpm install
dsh plugin --profile <your-profile> add D:\code\dsh-plugin-cad
```

Then start AutoCAD, open a drawing, and boot the profile:

```sh
dsh web
```

## Configuration

Edit the `cad` row in your profile's `cordis.patch.yml`:

| Key | Default | Meaning |
| --- | --- | --- |
| `transport` | `com` | `com` drives real AutoCAD; `simulation` runs fully in memory. |
| `progId` | `AutoCAD.Application` | Primary COM ProgID. |
| `progIdFallbacks` | `AutoCAD.Application.25.2` … | Probed in order when the primary is absent. |
| `unitsPerMeter` | `1` | **Set this to `1000` for a millimetre drawing.** Check `cad_status` — it reports the drawing's own `INSUNITS`. |
| `requestTimeoutMs` | `120000` | Hard ceiling on one bridge round-trip. |

Invalid values fail at plugin load rather than silently corrupting geometry.

## Tools

| Tool | Purpose |
| --- | --- |
| `cad_status` | Connection, active drawing, unit scale. **Start here.** |
| `cad_open` / `cad_save_as` | Open a DWG; save to a new path. |
| `cad_list_layers` | Layers with colour, linetype, on/frozen/locked, entity counts. |
| `cad_query_entities` | **Locate entities** by layer, kind, text, or window. Returns handles + metre sizes. |
| `cad_get_entity` | Full detail for one handle. |
| `cad_measure` | Distance between two points, in metres and drawing units. |
| `cad_draw` | Batch-create line / circle / arc / polyline / text / mtext. |
| `cad_add_dimension` | Real dimension objects (linear / aligned / angular / radius / diameter). |
| `cad_add_hatch` | Closed-region fill. |
| `cad_modify` | Change one entity properties. |
| `cad_transform` | Move / rotate / scale a handle set together. |
| `cad_delete` | Erase by handle. |
| `cad_batch` | Resolve a filter **and** transform the matches atomically; supports `dryRun`. |
| `cad_run_command` | Escape hatch to native AutoCAD commands. |

All dimensions are **metres** in and metres out.

## Safety posture

Conventions from the report are enforced in the tool contract:

- Failures return a **structured** error; nothing is silently swallowed.
- Partial success is reported: skipped objects come back in `warnings` and are surfaced to the model.
- `cad_batch` supports `dryRun` so a linkage edit can be previewed before it is applied.
- `cad_query_entities` truncates explicitly and says so, rather than presenting a partial set as complete.

## Verifying against real AutoCAD

```sh
# 1. Start AutoCAD 2026 and open a blank drawing.
# 2. Run the live suite (it draws, queries, transforms, then deletes its own entities).
set DSH_CAD_LIVE=1
node --test --experimental-strip-types test/com-live.test.ts

# Without the env var the live tests skip and the suite runs offline:
node --test --experimental-strip-types test/*.test.ts
```

The offline suite is 31 passing tests (unit conversion, simulation transport, tool wiring, bundle).
The 4 live tests require a running, licensed AutoCAD.
## Notes from real-CAD bring-up

These were all found by running against AutoCAD 2026 and are worth knowing before editing the bridge:

- **Requests may be pretty-printed across several lines.** The bridge buffers input until braces
  balance, so a hand-written multi-line JSON document is parsed as one request. String contents
  are skipped, so braces inside text do not confuse the nesting count.
- **AutoCAD rejects COM calls with `RPC_E_CALL_REJECTED` while it is busy** (a modal dialog, a long
  regen, or a user command in flight). The bridge retries these transient rejections with a
  short backoff, so a brief hiccup in the AutoCAD UI does not surface as a tool failure.
- **Do not enable `Set-StrictMode`.** Under strict mode PowerShell loses the COM type adapter and
  every later property access fails with *"property cannot be found on this object"*.
- **Do not pass COM objects into functions.** The adapter is lost across that boundary too, so
  `$Doc.ModelSpace` inside a helper silently comes back null. The bridge keeps `$script:Doc` and
  `$script:SPC` in script scope; helpers take handles and plain values only.
- `Entity.Transform` does not exist; use **`TransformBy` with a 4x4 `double[,]`** matrix. A flat
  `double[]` is rejected with *"safe array dimension incorrect"*.
- `Entity.GetBoundingBox` fills two **out-parameters**; it does not return a value. Use
  `$e.GetBoundingBox([ref]$min, [ref]$max)`.
- `Document.GetVariable` exists; `Application.GetVariable` does **not**.
- Layers expose `Color`; `Layer.ColorIndex` does not exist. Entities likewise use `Color`.
- Assigning to a non-existent layer throws; the bridge creates it on demand.
- `cad_transform` works on any entity kind AutoCAD can transform, including polylines and blocks;
  a missing or stale handle is reported in `warnings` rather than silently skipped.
- `StartUndoMark` / `EndUndoMark` are absent from the automation `Document`, and `SendCommand`
  deadlocks when called from an automation client. `cad_draw`'s `undoLabel` is therefore accepted
  but **not** applied; each entity stays individually undoable with `U`.
- `assets/cad-bridge.ps1` must stay **UTF-8 with BOM**. Windows PowerShell 5.1 otherwise reads the
  Chinese strings as ANSI and fails to parse.

## Development

```sh
pnpm install       # also builds via the `prepare` script (needed for git installs)
pnpm typecheck
pnpm build
pnpm test
```

`prepare` runs `tsdown`, so `dsh plugin add github:you/dsh-plugin-cad` works without a monorepo
checkout. Add `allowBuilds: { dsh-plugin-cad: true }` to the profile''s `pnpm-workspace.yaml` to
authorise that build step on first install.

## Licence

MIT.
