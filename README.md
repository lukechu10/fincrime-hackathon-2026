# FinCrime Hackathon 2026 — Track 1

A Node.js and TypeScript starter for [Track 1: Stop suspicious payments](https://gb-fincrime-hackathon-11-2026.teamdeel.workers.dev/hackathon#track-1). The challenge is to review transaction-monitoring alerts and their evidence and decide how to close each case. This scaffold does not implement alert review yet.

## Repository layout

| Path | Contents |
| --- | --- |
| `institutions/` | Local development dataset, one folder per institution (ignored by Git) |
| [`system/`](system/) | TypeScript source, tests, and the future submission runner |
| [`output/`](output/) | Generated development verdicts, one JSONL file per institution (not generated yet) |

## Development dataset

From the repository root, run (requires `make`, `curl`, and `unzip`):

```sh
make dataset
```

This downloads the [official Track 1 ZIP](https://drive.google.com/file/d/1WcZKDHAhpaNjbAxau0Mmecwvy80OXD_9/view) and installs `institutions/`, `BRIEF.html`, and `DATASET.md` at the repo root. `DATASET.md` is the organizer's `README.md`, renamed to keep this project README intact. All three dataset paths are ignored by Git. Rerunning skips the download if the expected files are present. If the target reports an incomplete dataset, move the existing dataset paths aside and retry.

For a manual install, copy `institutions/` and `BRIEF.html` from the archive's `hackathon/` folder to the repo root, and copy its `README.md` as `DATASET.md`. Do not copy the archive's placeholder `system/` or `output/` folders. Start with `DATASET.md` and the four `institutions/*/POLICY.md` files. There are 1,000 unlabeled development cases per institution.

## Getting started

Requires Node.js 24+ and npm.

```sh
cd system
npm ci
npm run dev
```

Run the npm commands below from `system/`. The dev command watches `system/src/index.ts`, currently a placeholder. See [`system/README.md`](system/README.md) for the submission command we’ll implement.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check TypeScript without writing build files |
| `npm test` | Run the evidence extraction and loader tests (no dataset required) |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm start` | Run the compiled entry point after building |

## Evidence preprocessing

[`system/src/evidence.ts`](system/src/evidence.ts) exposes `loadEvidenceIndex(institutionDir)`. Create one index per institution run. Use `metadataForCustomer(customerId)` to select candidate documents without opening them, then call `get(docId)` for the relevant IDs. Each document is read and parsed once per index, in memory; there is no separate JSON generation step.

The returned document contains the original metadata and Markdown plus a JSON-serializable `extraction`: document-level `facts` and grouped `entries` (such as invoice rows, statement movements, and register officers). Each fact carries the document ID, line number, and original excerpt. Recognized GBP amounts use integer pence, and recognized full dates use `YYYY-MM-DD`. Notes, chats, and other unsupported document types remain available as raw Markdown. Extraction records what documents say; it does not establish a transaction match, prove a claim, or decide a verdict.
