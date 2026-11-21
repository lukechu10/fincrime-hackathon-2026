# AGENTS.md — FinCrime Hackathon 2026, Track 1

## Mission and status

Build an evidence-first transaction-monitoring triage system for [Track 1: Stop suspicious payments](https://gb-fincrime-hackathon-11-2026.teamdeel.workers.dev/hackathon#track-1). The system plays the analyst: it reviews cases raised by existing monitoring rules, not a feed of raw transactions that it must flag from scratch. It recommends a disposition; it does not actually release payments, contact customers, or file reports. Escalations go to the Money Laundering Reporting Officer (MLRO), who decides whether to file a Suspicious Activity Report.

Read the [full track brief](https://hosted-pages.godiligent.ai/hackathon-tm-track/), `DATASET.md`, and the four `institutions/*/POLICY.md` files before implementing decision logic. This file summarizes the brief; it is not a replacement for the institution-specific SOPs. The project uses Node.js 24+ and strict TypeScript with NodeNext/ESM. `system/src/index.ts` is the CLI entry point; `system/src/decision.ts` implements the offline, deterministic decision engine (with `explanations.ts` and `signals.ts`), documented in `system/README.md`. `system/src/evidence.ts` loads Markdown and extracts supported facts with source provenance. Run `make dataset` to fetch the bundle to the repository root (`institutions/`, `DATASET.md`, and `BRIEF.html`, all ignored by Git). Keep submission code under `system/`, and regenerate all four verdict files under `output/` after changing the decision logic.

```sh
cd system
npm ci
npm run typecheck  # no emitted files
npm test           # extraction, routing and submission fixtures
npm run build:run  # bundle the self-contained system/run executable
```

## Work log and next steps

Update this section when changing decision logic or completing a review round. Record what changed, what was verified, any known limitations, and the next priority. Keep organizer requirements separate from implemented behaviour; hand-reviewed development cases are not official labels.

- **Current pipeline:** `system/run` is a bundled, offline CLI for all four institutions.
  - **Inputs:** `system/src/bank-cases.ts` assembles cases. `evidence.ts` preserves raw Markdown and extracts supported facts.
  - **Decision:** `explanations.ts` explains individual transactions from documents and history. `signals.ts` finds concrete suspicion in the file. `decision.ts` checks each alert against its own rule's threshold and combines the results: suspicion, then one RFI, then CLOSE.
  - **Output:** `submission.ts` validates the complete batch before writing JSONL.
  - **Not in the submission:** the Bank `llm_review` command is a separate invoice-routing diagnostic and not an estimate of LLM demand. There are no model calls.
- **Bank review, first round (13 cases):** the baseline agreed with 7 manual verdicts. The highest-risk miss was a payment to a company whose listed director had resigned but remained the controlling shareholder on the transaction date. Other gaps included mixed evidence for normal payroll and own-account transfers, a documented group collection, and a verified customer returning to a dormant account.
- **Implemented TM22 timing fix:** `system/src/list-assessment.ts` now evaluates relevant officer and significant-control records using each flagged transaction date. Start dates are inclusive; resignation and cessation dates are exclusive. A director's resignation does not end separately documented control. A register entry without a start date is not backdated. Rebuilt the bundle and regenerated all four outputs: 119 verdicts changed from RFI to ESCALATE, with no other verdict changes.
- **Bank review, second round (9 new cases):** the current runner agreed on 4 verdicts and reason codes, including both transaction-date control cases and the name-only RFI. All five disagreements were missed closes (three RFIs and two escalations); no wrongful closes were observed in either selected sample. Missed evidence included reconciled cash takings, a backed vehicle sale, a matched hospital invoice, an insurance payout, and a refund linked to a payment outside the review window. Do not treat these sample counts as overall accuracy.
- **Implemented documented-credit reconciliation:** `system/src/documented-credits.ts` matches recognized insurance settlement letters, venue refund confirmations, and supplier credit notes to unique incoming transactions by exact amount, party, and claim or booking reference. Refunds additionally require a unique earlier outgoing payment from the same customer's history; both legs are cited even when the original predates the review window. A documented credit can explain more than one eligible alert, but does not override a separate suspicious or unresolved alert or the held payments/FX release gate. For `TM01`, the one permitted residual is separately recognizable declared payroll, with the flagged amounts reconciled to the alert total. Other payout formats, partial refunds, and ambiguity are not assumed to match.
- **Reconciliation verification:** the manually reviewed Bank insurer payout and venue refund now close with the decisive evidence, and the prior transaction-date control escalation still stands. Spot checks of five newly closed credits in e-money, investment and payments/FX also matched their cited source documents and transactions. The four regenerated development outputs record 168 new closes and 10 escalations changed to RFI; these are output differences, not verified gains on the whole dataset. Eight new tests cover positive matches, missing or conflicting records, multi-alert coverage, fraud precedence, and the held payments/FX gate. All 37 tests and the type-checked bundle build passed; five runs per institution with closed stdin reproduced the regenerated outputs byte-for-byte.
- **Reconciliation review follow-up:** a second same-reference document can block closure even when it does not parse as a positive confirmation. Explicit denials, partial settlements, verification warnings linked to the supporting document, and invalid document dates no longer support a close. A held payment cannot serve as a settled original. Uniqueness is evaluated in the same-customer history through the review-window end, not against future transactions. Three new regression tests bring the total to 40; all passed, and rebuilding and rerunning the CLI left all four outputs byte-identical.
- **Family review and local labels (2026-11-21):** every development case was assigned to a scenario family: the rules in the case plus the non-baseline document types, plus the held-payment marker at payments/FX. About 30 families per institution. Each family was reviewed against its SOP by reading several cases in full and checking the deciding facts across every case in the family.
  - **Shape of the data:** each institution came out at exactly 500 CLOSE, 250 RFI and 250 ESCALATE. Families are uniform. The "traps" are whole families: the same activity with the explaining document present (CLOSE) or missing (RFI), and separate suspicious families with their own evidence.
  - **Where the labels live:** `labels/dev-labels.jsonl`, scored with `python labels/score.py`. See `labels/README.md` for the soft spots. They are our judgments, not organizer labels, and must never be read by `system/`.
  - **Baseline before generalizing:** 5,894 verdict-cost points, with no wrongful closes. Most of the cost was over-caution (RFI or ESCALATE where the file documents the activity) and a pass-through rule that escalated every two-sided TM02.
- **Generalized decision logic (all institutions):**
  - **Explanations:** `explanations.ts` replaces the bank-only invoice, own-account and documented-credit paths. Each document type is checked on facts, not phrasing: party, amount in pence, account, reference, date window, and internal consistency such as completion-statement arithmetic or price × travellers. The types covered are joint statements and statements of the "Account … is held by" kind, dealer, hospital, carrier and pro forma invoices, contract schedules, contractor payment files, freight invoices, settlement and solicitor letters, completion statements, gift letters, sale receipts, takings books, car-park collection reports, event cash reconciliations, group bookings, tenancy deposit letters, loan agreements, ISA cancellations, redundancy-driven redemptions, group structure charts, invoice-finance remittances, payroll, established payees, and payments/FX funding linked to a documented onward payment.
  - **Coverage per rule:** an alert closes only when what is left unexplained falls below that rule's own threshold. At TM01 only the customer's own top-ups may remain. TM02 needs the unexplained inflow under £2,000, since an explained payee does not explain third-party money. TM10 needs the redemption itself explained.
  - **Escalation:** concrete signals only:
    - fraud reports;
    - structuring or refusal staff notes;
    - devices shared with other customers;
    - "others use my account" chats;
    - dissolved payers;
    - payees controlled by the customer's own director;
    - contradicting invoice tables;
    - payment files whose payees share a few addresses;
    - TM02 onward payments to crypto, individuals abroad or several unrelated people;
    - higher-risk-country flows with several unrelated individuals;
    - third-party payouts at investment.
  - **Requests instead of escalation:** gaps without suspicion now merge into one RFI with fixed precedence (identity, release gate, purpose, source) instead of escalating because two different requests exist. A single undocumented commercial payment to a higher-risk country is an RFI.
  - **Parser fixes:** insurer letters now accept "approved", "accepted claim" and any payee wording that names the customer, rejecting letters that name another payee. Venue emails accept "cancel …".
  - **Other changes:** the 5× rule compares pence, so £9,999.99 against a £2,000 baseline is below the limit, and it now also covers payments/FX own-name funding. A gift letter's full date of birth confirms or rules out a name-only list match.
- **Verification of the generalized logic:**
  - **Against the local labels:** verdict cost went from 5,894 to 0 across all 4,000 development cases, with 0 wrongful closes. Reason-code agreement is 100% for bank, e-money and payments/FX and 92.8% for investment. The remaining 72 cases are no-document TM08 requests, where we give `RFI_COUNTERPARTY_DETAILS` and the labels prefer `RFI_SOURCE_OF_FUNDS`; both are defensible.
  - **Overfitting risk:** this is measured on the same cases used to design the rules, so it is not an estimate of unseen accuracy. Every CLOSE path checks facts, so an unseen trap variant (wrong amount, donor, account, date or payee) falls to RFI or ESCALATE rather than closing. `test/generalized-decisions.test.ts` covers a matching and a mismatching variant for the main paths.
  - **Tests and build:** 51 of 52 tests pass. The failing test creates a symlink, which Windows blocks without Developer Mode; it is unrelated to this change. The bundled runner reproduced the outputs byte-for-byte across five runs per institution, and 200-case subsets ran in about 1.1 seconds.
- **Submission audit:** `python labels/score.py -v` returned zero verdict cost and no wrongful closes against the local labels, with 72 investment TM08 reason-code disagreements. This is in-sample; the scorer also does not enforce output completeness, so the audit independently checked all 4,000 case and alert records. Typecheck and all 52 tests passed on Linux. A fresh bundle matched `system/run`, and five runs per institution matched the committed outputs byte-for-byte. First-200-case runs retaining full institution indexes took 0.37–1.09 seconds each, with no model cost.
- **Audit blockers before submission:** synthetic checks reproduced TM02 closing despite an unexplained onward payment, a same-name held FX payee bypassing ownership proof, and the supplier-invoice fallback accepting contradictory payee details. Cross-checking the development outputs also found 52 e-money TM02 closes with uncited outgoing alert transactions after filtering out card, direct debit and standing order channels; that count is a review queue, not a count of proven wrong verdicts. The runtime and tracked outputs were not changed in the audit. Fix the wrongful-close paths and test unseen-format/composite cases before treating the local score as a readiness signal. The organizer portal also requires a public GitHub repository and a two-minute demo video.
- **Overfitting audit (2026-11-21, no logic changed):**
  - **Robustness run:** a run-level failure is the largest risk. Any invalid row, missing evidence file, broken join or thrown error aborts the whole institution with no output (`submission.ts` has no per-case fallback).
  - **Trap mutations:** raising every amount by £37 in the documents a CLOSE cites dropped 1,561 of 1,827 closes. The 266 that survive rely on full-account-number statements or re-verification, which do not depend on amounts. Swapping the customer's name dropped 1,292 of 1,331.
  - **Prose parsers:** every free-text document is a unique paraphrase. The credit-letter parser written from the first Bank sample covered 192 of the 281 letters that today's dev-widened parser accepts. One plausible rewording drops every solicitor-letter close (38/38) and 90 of the 140 gift-letter cases, and removes all 16 structuring escalations from staff notes. Expect some misses on unseen paraphrases.
  - **Labels are not independent:** the labels were written by the same agent in the same session as the engine, so a cost of 0 shows self-agreement, not accuracy.
- **Fixed the three submission audit blockers:** TM02 now requires support for each material flagged onward payment as well as the existing inflow check. Payments/FX always assesses and cites the actual held payment: a same-name destination needs ownership evidence for the £10,000 exemption, and a uniquely matched same-day merchant receipt can support a smaller payment without replacing the large-payment invoice or contract. Ordinary invoice matching now uses one path with one-to-one reconciliation, and a linked invoice naming a conflicting beneficiary escalates even when another invoice matches. Added six regression tests; all 58 and typecheck passed. Rebuilt the bundle and regenerated all four development files; five runs per institution reproduced them byte-for-byte. The local score is now 156 verdict-cost points and zero labelled wrongful closes: 52 e-money TM02 CLOSEs became RFIs for uncited onward activity; no other verdicts changed. Review whether those small movements are part of the alerted flow or independently explained before relaxing the rule.
- **Per-case fallback (no verdict logic changed):**
  - **What changed:** loaders now skip bad rows with a stderr warning instead of throwing, and ignore a leading byte-order mark. A case is escalated with `ESC_UNEXPLAINED_FUNDS`, its alert IDs and no evidence when any of these holds:
    - its record is malformed;
    - a skipped row or evidence entry names its customer;
    - a join or document read fails;
    - deciding it throws or fails validation.

    Missing output folders are created.
  - **Fault injection:** each copy of the Bank folder had one change: a byte-order mark, an empty counterparty, a negative amount, a null review note, a null document date, a deleted evidence file, a removed customer, or a bad alert line. Every copy now writes 1,000 lines with at most one case changed; before, each one aborted with no output.
  - **Verification:**
    - Development outputs are byte-identical to the previous commit, and identical across five runs. The local score is unchanged at 156.
    - Synthetic cases: unchanged at cost 12, zero wrongful closes, 16/16 reproducible.
    - Tests: 61, all passing except the Windows symlink test.
  - **Synthetic misses:** the four remaining misses are wording-dependent parses:
    - a reworded structuring note becomes an RFI instead of escalating;
    - a redundancy redemption becomes an RFI instead of closing;
    - a refund whose original payment is outside the window becomes an RFI;
    - an invoice diversion becomes an RFI instead of escalating.
- **Early-redemption evidence fix:** the redundancy path now checks the fund pair named by each TM10 alert and requires a matching employer letter dated during the holding plus a customer sale request citing redundancy, dated between the letter and the sale. It no longer infers a request or claims a living-cost purpose. All 62 tests and the type-checked bundle build passed. Regenerating all four development outputs left all 4,000 verdicts and reason codes unchanged; only the 46 redundancy explanation texts changed. Across the expanded 40-case synthetic suite, `SYN-IV-07-CS` was the only change (CLOSE to RFI); cost fell from 61 to 51, with zero wrongful closes and byte-identical outputs on five runs. This remains a targeted local suite, and reworded evidence not recognized by the parser can still fall to RFI.
- **Synthetic logic gaps fixed:** these five gaps would remain even with perfect parsing; IV-07 was already fixed in the early-redemption commit.
  - **Joint accounts:** a statement listing the customer as a joint holder now explains a payment named after the other holder (IV-08).
  - **Structuring in chats:** the customer's own words in a support chat now count as a structuring admission, and "under a grand" or "asks for ID" phrasing is recognised (EM-06). Agent text is ignored.
  - **Crypto:** recognised from the payee's name (including "digital assets") or a reference naming an asset such as BTC (EM-07).
  - **Open register roles:** a role with no end date continues after the register's own date, while a missing start date is still not backdated (BK-09). This changes an existing test's expectation, which is intended.
  - **Invoice contradictions:** an ordinary invoice reference is also read from an "Invoice number" field. A payment that quotes an invoice and goes to its issuer, but for a different amount, now escalates as `ESC_INVOICE_MISMATCH` (PX-09). A different beneficiary already did, once the reference was read (PX-04).
  - **Verification:**
    - Development outputs are byte-identical, so the dev score is unchanged at 156.
    - Synthetic cases: cost went from 51 to 33, with correct verdicts up from 23/40 to 29/40, zero wrongful closes, and all 40 reproducible across five runs.
    - Tests: five new regression tests plus one updated test, 67 in total, all passing except the Windows symlink test.
  - **Still open:** the remaining synthetic misses are wording and layout parses, such as solicitor and gift wording, prose contracts and ownership, and the insurer net of excess, plus three reason-code choices.
- **Next priority:**
  - **Make the free-text parsers robust to rewording**, or add the LLM fallback reader for documents no parser recognizes; the remaining synthetic misses are of this kind.
  - **Measure generalization:** hand-check a fresh stratified sample of outputs, especially every CLOSE path, for wording and evidence quality.
  - **Stress-test trap variants** by mutating development cases: change an amount, donor, account or date, and confirm closes fall away.
  - **Decide the no-document TM08 reason code.**
  - **Optional LLM review:** consider it only for documents no parser recognizes, keeping the final decision deterministic.

## Submission contract

Deliver `system/run` (executable), `system/README.md` (how to run it and how it decides), and four development output files: `output/bank.jsonl`, `output/emoney.jsonl`, `output/investment.jsonl`, and `output/payments_fx.jsonl`.

```sh
system/run institutions/bank output/bank.jsonl
# Evaluators also run from inside system/:
./run /absolute/path/to/bank /absolute/path/to/bank.jsonl
```

- The runner takes exactly two positional arguments: an institution folder and an output file. Resolve relative arguments against the caller's working directory; locate the runner's own code relative to the wrapper, not the caller. It must be non-interactive: do not read stdin, contact the customer, or pause for a response. An RFI is a verdict whose `reason` says what the analyst should request, not a request the program actually sends. A submission must not need to build or install dependencies at evaluation time. Use only the Node.js standard library and shell for the submitted runtime; TypeScript and other development dependencies are build-time only. Document how to prepare it beforehand.
- Read case data only from the supplied institution folder, and write only the requested output file. Keep diagnostics out of JSONL (use stderr). Don't rely on `.env`, another institution's data, or development outputs at evaluation time. Keep `.env` untouched and out of Git. Our default is an offline runner. The bundle README allows model calls only via OpenRouter chat completions, using `OPENROUTER_API_KEY` supplied by the evaluator; the 200-case run should cost under about US$4. The submission README should report the runtime and cost for 200 cases and identify any model used.
- The organizers test on 800 unseen cases (200 per institution) in the same format and under the same policies. They run the system five times. A 200-case run must finish within 30 minutes.
- Never embed development case IDs, names, amounts, or case-specific lookup tables in the decision logic. Policy thresholds and artificial test fixtures are fine. A missing case counts as an escalation; don't silently drop cases or invent evidence to fill gaps.

### Inputs

At the repository root, the development bundle installs `DATASET.md` (the organizer's `README.md`), `BRIEF.html`, and `institutions/{bank,emoney,investment,payments_fx}/`. There are 4,000 development cases, 1,000 per institution, **without answer labels**. Each institution folder contains:

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
| `TM01` Profile exceeded | 30-day inflows > 3× declared monthly income (individual) or > 2× monthly turnover (business) | 30-day inflows > 2× the monthly share of declared annual payment volume | Same as Bank | Same as Bank (customers are individual investors) |
| `TM02` Rapid movement | Over 10 days, ≥ 80% of ≥ £2,000 received is paid out within 48h; card spend excluded | Same as Bank, counting only money from anyone other than the client | Same as Bank | Over 10 days, ≥ 80% of ≥ £2,000 deposited is withdrawn within 10 days and < 20% of it was invested |
| `TM03` Repeated subthreshold activity | 3+ cash deposits of £9,000.00–£9,999.99 within 10 days | 3+ payments to the same beneficiary of £9,000.00–£9,999.99 within 10 days | 4+ cash top-ups of £800.00–£999.99 within 10 days | — |
| `TM04` Many payers/payees | > 6 payers or payees by bank transfer in 30 days | Client pays > 25 beneficiaries in 30 days | Same as Bank | — |
| `TM05` Large cash | One cash deposit/withdrawal ≥ £10,000 (individual) or ≥ £25,000 (business) | — | One cash top-up ≥ £1,000 (individual) or ≥ £5,000 (business) | — |
| `TM06` Unexpected higher-risk country | ≥ £5,000 within 30 days to or from an undeclared higher-risk country | Same | Same | Same |
| `TM07` Dormant reactivation | ≥ £5,000 moves after 180 days with no activity | Same | Same | Same |
| `TM08` Third-party funding/payout | — | Funding ≥ £1,000 from an account not in the client's name | — | Deposit ≥ £1,000 from, or withdrawal to, an account not in the customer's name |
| `TM10` Early fund redemption | — | — | — | Fund units sold within 90 days of purchase |
| `TM22` Internal-list match | Payer, recipient or company officer matches by name, address, date of birth or identifier | Same | Same | Same |

All four SOPs share the same verdict definitions, policy settings (higher-risk country list, 5× own-account rule, internal-list and prior-review handling) and reason codes. Payments/FX alone adds the £10,000 invoice-before-release rule and scopes a case to one held outgoing payment.

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
