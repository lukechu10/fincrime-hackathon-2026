# Track 1 submission system

This folder contains the Node.js/TypeScript code and tests. It has an evidence loader, extractors for selected document types, and an initial Bank routing rule. `npm run build:run` bundles the placeholder entry point into the `run` executable. The executable does not classify cases yet: the verdict engine and LLM integration are still unimplemented. See the [project README](../README.md) for development setup and dataset installation.

## Inspect Bank routing

After `make dataset`, run from the repository root:

```sh
npm --prefix system run bank:routes -- ../institutions/bank
```

Append a case ID for per-case routing details. This diagnostic reads the inputs and prints routing JSON to stdout; it makes no model calls and writes no verdict files.

The Bank case loader joins the customer, all case alerts, their flagged transactions, and the customer's raw evidence. The initial rule looks for an unambiguous match between one ordinary invoice and one flagged outgoing payment: billed-to and payee names, exact GBP amount, dates, and the destination account when specified. A same-customer sending-bank fraud report always routes to `llm_review`, even with a matching invoice; the report date alone doesn't establish relevance. Cases without complete invoice coverage also route to review in this prototype.

`continue_policy` means only that the invoice check found a candidate match for every flagged transaction. It is **not** permission to close or to ignore unparsed documents. Checks for internal-list matches, prior reviews, and whether every alert is actually explained still need to be implemented.

Once classification is wired into the runner, invoke it from the repository root:

```sh
system/run institutions/bank output/bank.jsonl
```

It must also work from inside `system/` with absolute input and output paths, without installing dependencies. The completed submission should include its decision logic, any model used, and the measured time and cost of a 200-case run here.
