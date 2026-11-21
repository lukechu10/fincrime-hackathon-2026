# Track 1 submission system

This folder contains the Node.js/TypeScript code and tests. So far it has an evidence loader and extractors for selected document types. The verdict engine and `run` executable are not implemented yet. See the [project README](../README.md) for development setup and dataset installation.

Once the runner is implemented, invoke it from the repository root:

```sh
system/run institutions/bank output/bank.jsonl
```

It must also work from inside `system/` with absolute input and output paths, without installing dependencies. The completed submission should include its decision logic, any model used, and the measured time and cost of a 200-case run here.
