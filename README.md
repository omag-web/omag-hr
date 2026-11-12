# OMAG HR Assistant

A member-facing HR assistant for Oklahoma municipalities, replacing OMAG's "Oklahoma Municipal HR Assistant" CustomGPT. Members ask employment-law questions answered from Oklahoma statutes (Title 11 and others), federal regulations and OMAG guidance, with citations, and generate documents (personnel handbook, FMLA policy, acknowledgment receipt) from OMAG's templates.

**Status:** prototype / planning. Nothing here talks to a backend yet.

## What's in the repo

| Path | What it is |
|---|---|
| [`prototype/index.html`](prototype/index.html) | Clickable front-end prototype with scripted answers. Single self-contained file — open it in a browser. |
| [`docs/scope.md`](docs/scope.md) | Scope, architecture, cost estimate, analytics plan and open decisions. |
| [`docs/system-prompt.md`](docs/system-prompt.md) | The CustomGPT's instructions, carried over as the starting system prompt. |

## Running the prototype

Open `prototype/index.html` in any browser, or enable GitHub Pages for this repo and visit `/prototype/`. No build step.

Things to try:

- Ask **"Can the mayor suspend an employee unilaterally?"**, then change the form of government in **Member profile** (bottom of the sidebar) and ask again — the answer and citations change per Title 11.
- Click any citation chip to see the statute text (Title 11) or a regulation summary (29 C.F.R.).
- **Document templates → Personnel policies handbook** — fill in the blanks and download a real `.docx`.
- **"Is our handbook FMLA compliant?"** → **Upload our handbook** — simulated review (sample findings).

Free-typed questions without a script get a "prototype" message with suggestions.

## Going from prototype to product

The prototype's `route(q)` function stands in for the backend. In the real build it becomes a `fetch` to an API (Lambda → Amazon Bedrock) that streams the answer back; the rest of the UI stays. See [`docs/scope.md`](docs/scope.md).
