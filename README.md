# FinCrime Hackathon 2026 — Track 1

A Node.js and TypeScript starter for [Track 1: Stop suspicious payments](https://gb-fincrime-hackathon-11-2026.teamdeel.workers.dev/hackathon#track-1). The challenge is to review transaction-monitoring alerts and their evidence and recommend how to close each alert. This scaffold does not implement alert review yet.

## Development dataset

From the repository root, run (requires `make`, `curl`, and `unzip`):

```sh
make dataset
```

This downloads the [official Track 1 ZIP](https://drive.google.com/file/d/1WcZKDHAhpaNjbAxau0Mmecwvy80OXD_9/view) and extracts the dataset and brief into `data/track-1/`, which is ignored by Git. Rerunning the command skips the download if the expected files are already present. If the target reports an incomplete folder, move it aside and rerun the command.

If the automatic download is unavailable, open the ZIP link in a browser and copy the contents of its `hackathon/` directory into `data/track-1/`. Start with `data/track-1/README.md` and the four `data/track-1/institutions/*/POLICY.md` files. The bundle contains 1,000 unlabeled development cases per institution.

## Getting started

Requires Node.js 24+ and npm.

```sh
npm ci
npm run dev
```

The entry point is `src/index.ts`. The dev command reruns it when files change.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check TypeScript without writing build files |
| `npm test` | Run the evidence extraction and loader tests (no dataset required) |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm start` | Run the compiled entry point after building |

## Evidence preprocessing

`src/evidence.ts` exposes `loadEvidenceIndex(institutionDir)`. Create one index per institution run. Use `metadataForCustomer(customerId)` to select candidate documents without opening them, then call `get(docId)` for the relevant IDs. Each document is read and parsed once per index, in memory; there is no separate JSON generation step.

The returned document contains the original metadata and Markdown plus a JSON-serializable `extraction`: document-level `facts` and grouped `entries` (such as invoice rows, statement movements, and register officers). Each fact carries the document ID, line number, and original excerpt. Recognized GBP amounts use integer pence, and recognized full dates use `YYYY-MM-DD`. Notes, chats, and other unsupported document types remain available as raw Markdown. Extraction records what documents say; it does not establish a transaction match, prove a claim, or decide a verdict.
