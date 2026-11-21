# AGENTS.md — FinCrime Hackathon 2026, Track 1

## Mission and status

Build an evidence-first transaction-monitoring triage system for [Track 1: Stop suspicious payments](https://gb-fincrime-hackathon-11-2026.teamdeel.workers.dev/hackathon#track-1). The system plays the analyst: it reviews cases raised by existing monitoring rules, not a feed of raw transactions that it must flag from scratch. It recommends a disposition; it does not actually release payments, contact customers, or file reports. Escalations go to the Money Laundering Reporting Officer (MLRO), who decides whether to file a Suspicious Activity Report.

Read the [full track brief](https://hosted-pages.godiligent.ai/hackathon-tm-track/) and the data bundle's README and four `POLICY.md` files before implementing decision logic. This file summarizes the brief; it is not a replacement for the institution-specific SOPs. The repository currently has only a Node.js 24+ / TypeScript scaffold (`src/index.ts`, strict TypeScript with NodeNext/ESM). The official development bundle is extracted locally under `data/track-1/` (ignored by Git); see the project README for the download link. The submission runner and decision engine are not implemented yet.

```sh
npm ci
npm run dev        # watch and run src/index.ts
npm run typecheck  # no emitted files
npm run build      # compile into dist/
npm start          # run the compiled entry point
```

## Submission contract

Deliver `system/run` (executable), `system/README.md` (how to run it and how it decides), and four development output files: `output/bank.jsonl`, `output/emoney.jsonl`, `output/investment.jsonl`, and `output/payments_fx.jsonl`.

```sh
system/run data/track-1/institutions/bank output/bank.jsonl
# Evaluators also run from inside system/:
./run /absolute/path/to/bank /absolute/path/to/bank.jsonl
```

- The runner takes exactly two positional arguments: an institution folder and an output file. Resolve relative arguments against the caller's working directory; locate the runner's own code relative to the wrapper, not the caller. A submission must not need to build or install dependencies at evaluation time. Use only the Node.js standard library and shell for the submitted runtime; TypeScript and other development dependencies are build-time only. Document how to prepare it beforehand.
- Read case data only from the supplied institution folder, and write only the requested output file. Keep diagnostics out of JSONL (use stderr). Don't rely on `.env`, another institution's data, or development outputs at evaluation time. Keep `.env` untouched and out of Git. Our default is an offline runner. The bundle README allows model calls only via OpenRouter chat completions, using `OPENROUTER_API_KEY` supplied by the evaluator; the 200-case run should cost under about US$4. The submission README should report the runtime and cost for 200 cases and identify any model used.
- The organizers test on 800 unseen cases (200 per institution) in the same format and under the same policies. They run the system five times. A 200-case run must finish within 30 minutes.
- Never embed development case IDs, names, amounts, or case-specific lookup tables in the decision logic. Policy thresholds and artificial test fixtures are fine. A missing case counts as an escalation; don't silently drop cases or invent evidence to fill gaps.

### Inputs

Under `data/track-1/`, the development bundle contains `README.md`, `BRIEF.html`, and `institutions/{bank,emoney,investment,payments_fx}/`. There are 4,000 development cases, 1,000 per institution, **without answer labels**. Each institution folder contains:

| Input | Contents |
| --- | --- |
| `POLICY.md` | Institution SOP: case scope, rule definitions, exact thresholds, verdicts, exceptions and release conditions |
| `cases.jsonl` | Case ID, customer, review window, alert IDs and any held payment |
| `alerts.jsonl` | Alert ID, rule, measured values and transactions implicated |
| `customers.jsonl` | Customer profile and declared activity |
| `transactions.jsonl` | Transactions on customer accounts |
| `evidence.jsonl` and `evidence/*.md` | Document IDs/metadata and the underlying Markdown documents |
| `previous_reviews.jsonl` | Earlier reviews with potentially limited coverage |
| `internal_list.jsonl` | Institution's internal list entries |

Inspect the bundle before defining field-level schemas. Scope joins to the case's customer, review window, held payment, and relevant counterparties/documents. Preserve upstream IDs verbatim. Include older records when they establish a relevant link (e.g. a refund's original payment or a review's precise scope), not just because they belong to the customer.

### Output

Write exactly one JSON object per input case, one per line. Preserve input case and alert order for reproducibility. The example below is from the brief; its values are illustrative, **not** defaults or rules.

```json
{"case_id":"BK-CS112964","alert_ids":["BK-AL4810357"],"verdict":"CLOSE","reason_code":"LIST_MATCH_DIFFERENT_PARTY","reason":"The joinery firm's director shares the listed person's name, but the company register gives a birth year of 1993, not 1972. The £3,150.72 payment matches the firm's invoice for fitted wardrobes.","evidence":["REG-5461","INV-7291","BK-L37007"]}
```

- `case_id`: exact ID from `cases.jsonl`; no duplicates or omissions.
- `alert_ids`: **all** alerts in the case, even when one is decisive.
- `verdict`: `CLOSE`, `RFI`, or `ESCALATE`.
- `reason_code`: one allowed code for the main ground, compatible with the verdict. Use stable tie-breaking when several findings qualify; explain the other material findings in `reason` as needed.
- `reason`: two to four case-specific sentences naming the relevant facts, amounts, counterparties, or documents and why they support the verdict. For RFI, say exactly what to ask the customer for. Do not describe a claim as verified unless the evidence supports it.
- `evidence`: exact IDs of the **decisive documents, transactions, or list entries** relied on; no invented IDs, unrelated IDs, or duplicates. Validate that every cited ID exists in the supplied files and is relevant to the case.

## Decision policy

- **CLOSE** only when the evidence explains the activity behind **every** alert and fits the known profile or is credibly documented under the SOP. At payments/FX, this means the held payment can be released. A rule firing is not by itself proof of crime.
- **RFI** only when there is no suspicion and one specific document or answer would settle what remains. An obvious missing invoice is different from a mismatching or otherwise suspicious invoice. Don't ask a question just to avoid a decision.
- **ESCALATE** when there is suspicion or the activity is unexplained and not resolvable through an appropriate RFI under the SOP. Suspicion anywhere in the case takes precedence over benign findings or an otherwise plausible RFI. Once there is suspicion, do not ask the customer; it risks tipping them off.
- **One case, one verdict.** Payments/FX cases center on a held outgoing payment; other institutions review one customer over a review window. Assess each alert against the evidence, then aggregate. A match for one alert cannot explain unrelated activity behind another.

### High-impact checks from the brief

- **Own accounts:** require documentary proof the customer owns the other account. For otherwise explained own-account transfers, if activity reaches **at least 5×** declared income or volume, request an updated expected profile (`RFI_UPDATED_PROFILE`); below that, close if all other requirements are met. Missing proof is not proof of ownership. Follow the SOP for what to compare and how to handle missing declarations.
- **Internal list:** a match on one detail alone is not proof. Close that alert only with affirmative evidence that the party is different; if identity is unresolved and there is no suspicion, ask for counterparty details. Escalate if the listed party is the counterparty or controls it. Account for identifiers and ownership/control, not just names.
- **Prior reviews:** reuse only within the scope actually documented. A prior close is not blanket permission for new, larger, or different activity.
- **Payments/FX release:** a payment of **£10,000 or more** to anyone other than the client requires an invoice or contract on file before release. Check that the document supports the actual payment (e.g. amount, payee and date); the presence of an invoice alone does not suffice.
- **Context only:** round amounts, shared devices/IP/contact details, same-day recipient creation, and crypto or gambling counterparties can inform the assessment but are not standalone alert triggers.

### Institution and rule map

Bank: current accounts with transfers, cards, branch/ATM cash. Payments/FX: businesses funding foreign-currency supplier/staff payments; own funding and payout are normal for the product. E-money: top-ups, transfers, cards and ATM withdrawals. Investment: broker/fund platform with deposits, withdrawals, fund purchases and sales. The summary below is for orientation; use each SOP for exact definitions and thresholds.

| Rule | Bank | Payments/FX | E-money | Investment |
| --- | --- | --- | --- | --- |
| `TM01` Profile exceeded | 30-day inflows vs declared income/turnover | Funding vs expected payment volume | Inflows vs declared income/turnover | Deposits vs declared income |
| `TM02` Rapid movement | In and out within 48h | Third-party funding paid out within 48h; exclude client own funding | In and out within 48h | Withdrawn within 10 days with little invested |
| `TM03` Repeated subthreshold activity | Cash deposits just below £10,000 within 10 days | Payments to one beneficiary just below £10,000 within 10 days | Cash top-ups just below £1,000 within 10 days | — |
| `TM04` Many payers/payees | Over six payers or payees in 30 days | Over 25 beneficiaries in 30 days | Over six payers or payees in 30 days | — |
| `TM05` Large cash | Deposit/withdrawal of at least £10,000 | — | Top-up of at least £1,000 | — |
| `TM06` Unexpected higher-risk country | Transfer origin or destination | Beneficiary country | Transfer origin or destination | Deposit origin or withdrawal destination |
| `TM07` Dormant reactivation | Activity after 180 days dormant | Same | Same | Same |
| `TM08` Third-party funding/payout | — | Funding from an account not in the client's name | — | Deposit from or withdrawal to another party |
| `TM10` Early fund redemption | — | — | — | Fund units sold within 90 days of purchase |
| `TM22` Internal-list match | Payer or recipient | Beneficiary or its officers | Payer or recipient | Depositor |

### Allowed reason codes

| Verdict | Code | Main grounds |
| --- | --- | --- |
| CLOSE | `COLLECTION_DOCUMENTED` | Documented collection on behalf of named people explains the payments |
| CLOSE | `BUSINESS_RECORDS_RECONCILE` | Takings, collection reports, or other business records reconcile to activity |
| CLOSE | `DOCUMENTED_EVENT` | Documented one-off event such as a sale, inheritance, or payout |
| CLOSE | `INVOICE_MATCHES` | Invoice, contract, or payment file matches amount, payee and date |
| CLOSE | `OWN_ACCOUNT` | Funds moved between accounts shown to belong to the customer |
| CLOSE | `GROUP_COMPANY` | Verified same-group company |
| CLOSE | `THIRD_PARTY_DOCUMENTED` | Documented relationship explains the third-party payer |
| CLOSE | `REFUND_OF_EARLIER_PAYMENT` | Refund reconciles to an earlier payment |
| CLOSE | `RETURNING_CUSTOMER` | Verified customer resumed use of a dormant account |
| CLOSE | `LIST_MATCH_DIFFERENT_PARTY` | Evidence shows the counterparty is not the listed party |
| CLOSE | `WITHIN_PROFILE` | Activity fits the declared profile or instructions |
| RFI | `RFI_PURPOSE_DOCUMENTS` | Ask for documents showing payment purpose |
| RFI | `RFI_BUSINESS_RECORDS` | Ask for business records behind the activity |
| RFI | `RFI_SOURCE_OF_FUNDS` | Ask for proof of where the money came from |
| RFI | `RFI_COUNTERPARTY_DETAILS` | Ask who the counterparty is and what the payment was for |
| RFI | `RFI_UPDATED_PROFILE` | Ask for updated expected income or volume |
| ESCALATE | `ESC_MULE_ACTIVITY` | Account receives and passes on other people's money for someone else |
| ESCALATE | `ESC_STRUCTURING` | Transactions were split to stay under a threshold |
| ESCALATE | `ESC_UNEXPLAINED_FUNDS` | Funds lack a credible explanation and were moved on |
| ESCALATE | `ESC_PASS_THROUGH` | Money passes through with no credible purpose, often to linked parties |
| ESCALATE | `ESC_INVOICE_MISMATCH` | Invoices do not support the payments |
| ESCALATE | `ESC_HIGH_RISK_CORRIDOR` | Unexplained payments to or from a higher-risk country |
| ESCALATE | `ESC_ACCOUNT_MISUSE` | Someone other than the customer appears to control or use the account |
| ESCALATE | `ESC_THIRD_PARTY_FUNDING` | Unrelated third parties fund the account or receive money from it |
| ESCALATE | `ESC_EARLY_REDEMPTION` | Fund units bought and quickly sold back to move money |
| ESCALATE | `ESC_LISTED_PARTY` | Counterparty is the listed party or is controlled by it |

## Implementation plan

1. **SOPs and CLI first.** Read all four SOPs from the local bundle and record how their thresholds, case scope, exceptions, and naming differ. Build a fixture-backed vertical slice with strict input/output validation and the required runner invocation. Make missing files, malformed JSONL, and broken references diagnosable; never silently treat a failed load as an empty evidence pack.
2. **Evidence assembly.** Index records once per institution; assemble each case by joining its alerts to implicated transactions and relevant customer and counterparty records. Extract structured evidence with provenance: party/account ownership, identities and control, dates, amounts, payment purpose, and scope of prior reviews. Separate observed facts, document claims, and inferences; retain contradictions. Read document bodies, not just their titles or file names.
3. **Policy and alert findings.** Keep institution settings explicit and share code only where rules really agree. Normalize currencies, dates and parties without losing source values; prefer integer minor units or exact decimals for money comparisons. Produce structured per-alert findings (support, suspicion, unresolved gap, source IDs), then apply case-level precedence. Start with internal-list matching, own-account proof, prior-review scope, and held-payment release checks.
4. **Decision and explanation.** Derive verdict, main reason code, cited evidence, and reason text from the same findings. Use stable ordering and tie-breakers rather than filesystem order, randomness, or current time. Prefer deterministic document extraction and templating; if extraction needs a model, treat it as an untrusted fact extractor, validate facts against the documents, and keep final policy logic deterministic. Do not depend on external or variable model calls in the submitted runner.
5. **Bank vertical slice, then three adapters.** First milestone: run Bank end to end with hand-checked examples of each verdict, and prove that a case with one explained alert and one unresolved alert does not close. Expand coverage to e-money, investment and payments/FX; include a held-payment release case that would otherwise look benign. Generate four development JSONL files only once the real inputs are available and validated.

## Evaluation and checks

Verdict error cost per case (rows are the correct verdict, columns are the system's prediction):

| Correct \\ Predicted | CLOSE | RFI | ESCALATE |
| --- | ---: | ---: | ---: |
| CLOSE | 0 | 3 | 3 |
| RFI | 10 | 0 | 2 |
| ESCALATE | 10 | 3 | 0 |

Score weighting: **60% unseen cases**, **20% development cases** (each splits 60% verdicts / 40% reasons), and **20% reproducibility** (same verdict and reason code across five runs; reproducibility points depend on unseen performance). Evidence alignment, correct grounds, and case-specific wording matter even when the verdict is right. Do not optimize for accuracy alone: track wrongful closes explicitly and measure the cost matrix. Blanket escalation earns zero on verdicts.

- Hand-label a small stratified sample covering all four institutions, rules, multi-alert cases, and hard negatives; hold some cases back from tuning. Treat these labels as local review judgments, not organizer ground truth.
- Exercise policy boundaries and variants: below/at/above 5× and £10,000; owned vs claimed-owned accounts; false vs ambiguous vs confirmed list matches; prior reviews that don't cover newer activity; missing vs mismatching invoices; own funding vs third-party funding under payments/FX `TM02`; benign context vs actual suspicion; one explanation covering some vs all alerts; suspicion overriding an otherwise suitable RFI.
- Test exact case and alert coverage, evidence ID existence and relevance, verdict/code compatibility, and specific RFI wording. Review a sample of explanations manually for decisive evidence and concrete facts.
- Verify the runner from the project root with relative arguments and from `system/` with absolute paths. Repeat representative runs five times and compare verdicts and reason codes; aim for byte-identical output. Benchmark 200-case runs per institution, then verify counts for all four development output files.
