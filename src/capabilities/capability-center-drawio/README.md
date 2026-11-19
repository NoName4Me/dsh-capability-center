# capability-center-drawio

This DSH bundle adds a session-bound, same-origin draw.io workspace. The left
pane keeps the bundled draw.io editor mounted. The right pane embeds the
existing DSH conversation through `SessionProvider`, so messages, running
state, drafts, attachments, and the composer remain part of the original
session. Entering the canvas collapses an expanded global session sidebar so
the workspace has the intended canvas and chat columns. Leaving the canvas
restores the sidebar only when it remains collapsed from this canvas entry.

Starting a create call opens the split view automatically. Completed turns
that create, open, or edit a board show an **打开画布** card below the reply.
The card opens the board for that turn. The embedded editor uses Simplified
Chinese. The editor opens on an infinite canvas with the page, shape, and
format panels closed by default so diagrams have more usable space. Startup
configuration hides the complete outer panel containers when draw.io does not
close them through its own controls. Creation tools receive visual guidance
for layout, hierarchy, and color, and use a built-in visual system when no
custom style is supplied.

## Visual system

`visualTheme` selects a cohesive background and role palette. The default
`auto` mode uses the restrained `editorial` palette. `technical`, `warm`, and
`monochrome` cover diagrams for engineering, education or lifestyle subjects,
and monochrome reports.

Nodes can use `start`, `end`, `process`, `decision`, `outcome`, `warning`, or
`note` roles. The service applies consistent fills, borders, typography, and
shapes by role. When an explicit user style, brand color, or reference example
is available, that direction takes priority. Pass explicit draw.io style
properties through `style`; explicit non-draw.io colors are retained.

The classic draw.io fills `#dae8fc`, `#d5e8d4`, `#e1d5e7`, `#fff2cc`, and
`#f8cecc` are refined into quieter colors by default. Set
`preserveDrawioPalette` to `true` only when the user explicitly requests those
standard draw.io colors or otherwise needs the style preserved unchanged.

## Tools

- `drawio_create` creates a board from nodes and optional edges.
- `drawio_get_selection` reads the activating session's current board,
  revision, page, selected cell IDs, labels, and edge endpoints.
- `drawio_get_diagram` reads the complete normalized draw.io XML.
- `drawio_edit` applies label/style changes and structural operations with an
  exact `expectedRevision`.
- `drawio_open` activates a board for the current session and returns its
  stable binding.

Every mutation is checked against `exec.agent.id`. A board ID from another
session is rejected. `drawio_edit` is serialized per board and compares
`expectedRevision` while holding the board lock, so a stale update fails
without writing. Supported structural operations are `add_node`, `add_edge`,
and `remove_cell`. Removing a parent also removes descendants and incident
edges.

## Selection handoff

The same-origin draw.io editor binds its graph after load, listens to selection
and model changes, and posts stable cell IDs to the DSH host. Pointer and
keyboard gestures inside the editor also request the public JSON selection
export immediately, so the fallback path does not wait for its periodic poll.
Before an ordinary idle Enter or Send gesture with a selection, DSH reads it
again and waits for the revision-checked POST. Modifier shortcuts, IME composition,
slash commands, and running-session queue/steer gestures retain their native
path.

At the first model step of a human turn, the host appends a sourced
`capability-center-drawio` context message containing the active board,
revision, page, and exact selected IDs. The chat displays a count below the
sent message, derived from the recorded context. The model uses the captured
IDs and verifies the board revision before calling `drawio_edit`.
Revision checks keep a delayed selection or edit from
overwriting a newer diagram.

Canvas chat keeps inline image previews. Image file cards that would open
the separate DSH preview sidebar are hidden in canvas mode.

## Persistence and export

Board records are not standalone `.drawio` files on disk. DSH stores atomic
JSON records under:

```text
$DSH_HOME/capability-center-drawio/drawio/boards/<board-id>.json
$DSH_HOME/capability-center-drawio/drawio/sessions/<session-hash>.json
```

Each board record contains the draw.io XML, session owner, active page,
revision, selection snapshot, and timestamps. The session record stores the
active board ID. `DSH_HOME` defaults to `~/.dsh`.

While the canvas applies its initial page and panel configuration, draw.io
model, autosave, and save notifications are treated as startup noise and do
not create a board revision. After the bounded initialization window settles,
user edits and page-view changes resume the normal save path.

Use **导出 .drawio** in the canvas header to download the current editor XML
through a local browser `Blob`. Export does not write a new server file.

## Bundled assets

The editor is draw.io `v32.0.2`, extracted at build time from the pinned
`@next-ai-drawio/mcp-server@0.4.15` npm archive. See
`drawio-provenance.json` and the license files under `drawio/`. Runtime loading
uses only same-origin assets under `/capability-center-drawio/drawio/` and
does not invoke `npx` or a public draw.io endpoint.
