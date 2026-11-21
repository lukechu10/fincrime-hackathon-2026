# Track 1 submission system

Run the bundled executable from the repository root:

```sh
system/run institutions/bank output/bank.jsonl
```

It also works from inside `system/` with absolute paths:

```sh
./run /absolute/path/to/institutions/bank /absolute/path/to/output/bank.jsonl
```

The output directory must already exist. The runner writes exactly one JSON line per input case, in input order and with all alert IDs. It validates the case and alert references, verdict/reason-code pairs, and cited IDs before writing. Errors go to stderr and exit nonzero. Node.js 24+ is the only runtime requirement; no npm install, network, API key, or prior development run is required at evaluation time.

## How it decides

This is a deterministic baseline, not a model. It treats alerts as already raised and does not rerun all of the upstream monitoring thresholds. It joins each case to its customer, flagged transactions, evidence documents, and relevant list entries. It evaluates each alert, with a separate release check when there is a held payments/FX payment. It uses structured invoice, bank statement, and register facts alongside selected raw document signals. It also reconciles recognized insurance settlements and full refunds documented by a venue email or supplier credit note. These require an exact amount, counterparty and claim or booking reference; refunds also require and cite a unique original payment, even if it predates the review window.

- **Escalate** on a current sending-bank fraud report, a corroborated internal-list match, selected adverse notes, or unexplained linked flows and gaps that cannot be settled by one request. For list matches, officer and control records are evaluated on the matched transaction date, using their appointment or notification and resignation or cessation dates. A resignation does not end a separately documented period of significant control. Suspicion takes precedence over any otherwise reassuring match.
- **Close** only on supported explanations for every alert. Implemented positive checks cover documented own accounts, exact invoice reconciliation for selected outgoing alert types, documented insurance payouts and linked refunds, and affirmative evidence distinguishing an internal-list match. An invoice alone does not clear a list match. Own-account activity at **5× or more** of the declared monthly baseline goes to RFI instead.
- **Request information** when one request could resolve the outstanding gap, such as proof of the source of a flagged deposit or documentation for a held payment. A documented own-account transfer is exempt from the **£10,000** payments/FX release gate; otherwise the baseline does not release a held payment at that amount or above without a reconciled invoice. Unsupported contract formats stay under review rather than being treated as verified.
- Output reasons use the facts and original document, transaction, and list entry IDs relied on. Past verdicts do not automatically clear new activity. The baseline does not interpret arbitrary free-form evidence or implement every closure scenario in the SOPs, so conservative decisions are expected where the evidence cannot be reconciled.

**Model:** none. **Cost:** US$0 per run. **Measured runtime:** 0.18–0.26 seconds for 200 development cases on this machine, measured across all four institutions using subsets with the same input layout. The full development outputs were byte-identical across five runs. Development cases are unlabeled, so this checks reproducibility and contract compliance, not verdict accuracy.

## Rebuild and regenerate

From the repository root, with the dataset downloaded:

```sh
npm --prefix system ci
npm --prefix system test
npm --prefix system run build:run
for institution in bank emoney investment payments_fx; do
  system/run "institutions/$institution" "output/$institution.jsonl"
done
```

The Bank invoice-routing diagnostic is still available separately: `npm --prefix system run bank:routes -- ../institutions/bank [case-id]`. It reports routing candidates, not the final verdicts above.
