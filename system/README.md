# Track 1 submission runner

```sh
system/run <institution-folder> <output.jsonl>
```

The bundled executable needs Node.js 24+ and no dependency install. It runs non-interactively from any working directory; relative paths resolve from the caller’s directory. It writes one JSONL verdict per case in input order, with all alert IDs, a reason code, a case-specific explanation, and evidence IDs. A case that cannot be assessed because its inputs are incomplete is escalated rather than silently dropped.

## Architecture

| Stage | Code | What it does |
| --- | --- | --- |
| Case assembly | [`bank-cases.ts`](src/bank-cases.ts), [`evidence.ts`](src/evidence.ts) | Joins alerts, transactions, history, and documents. Extracted facts retain their source excerpts. |
| Evidence checks | [`explanations.ts`](src/explanations.ts), [`signals.ts`](src/signals.ts), [`list-assessment.ts`](src/list-assessment.ts) | Reconciles evidence to transactions and checks for contradictions, suspicious activity, and internal-list matches. |
| Policy decision | [`decision.ts`](src/decision.ts) | Assesses alerts individually and combines them into one recommendation under the institution’s policy. |
| Output | [`submission.ts`](src/submission.ts) | Validates case and alert IDs, verdict and reason-code compatibility, and evidence citations before writing JSONL. |

## Decision policy

- **ESCALATE** when evidence points to suspicion, even if another alert is explained. For example, a conflicting invoice or a confirmed listed party takes precedence over a missing document.
- **RFI** when there’s no suspicion and a specific document or answer can resolve the gap. Documented own-account activity at or above 5× the declared baseline requires an updated profile.
- **CLOSE** only when the evidence explains the activity behind every alert. For payments/FX, the actual held payment must also be explained; at £10,000 or more, a matching invoice or contract is required unless the destination is documented as the client’s own account.

## Optional model fallback

Set `OPENROUTER_API_KEY` to enable a second pass via OpenRouter. The default model is `anthropic/claude-haiku-5.5`; `OPENROUTER_MODEL` overrides it. Without a key, the runner stays offline and ignores the override. It reads selected documents the standard parsers could not use, and only in cases that haven’t already escalated. It returns structured facts with verbatim quotes. The runner verifies each quote against the source, applies the same evidence checks, and reruns the deterministic decision logic. If no usable model findings are returned, the offline result stands.

**Runtime and cost:** Offline, 200-case subsets took about 1.1 seconds in local benchmarks and cost US$0 in model fees. With the fallback enabled, the estimate is about one additional minute and US$0.01 in model fees per 200 cases, depending on the evidence mix. These are estimates for the default model, not live benchmarks. In two exploratory runs with a free model, 37 of 40 synthetic verdicts matched our local labels, up from 29 offline, with no wrongful closures. The prompt changed between runs, so live reproducibility has not been established.

## Rebuild and regenerate

From the repository root after `make dataset`:

```sh
npm --prefix system ci
npm --prefix system test
npm --prefix system run build:run
for institution in bank emoney investment payments_fx; do
  system/run "institutions/$institution" "output/$institution.jsonl"
done
```
