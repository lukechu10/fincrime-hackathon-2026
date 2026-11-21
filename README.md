# FinCrime Hackathon 2026 — Track 1

A Node.js and TypeScript starter for [Track 1: Stop suspicious payments](https://gb-fincrime-hackathon-11-2026.teamdeel.workers.dev/hackathon#track-1). The challenge is to review transaction-monitoring alerts and their evidence and recommend how to close each alert. This scaffold does not implement alert review yet.

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
| `npm run build` | Compile TypeScript into `dist/` |
| `npm start` | Run the compiled entry point after building |
