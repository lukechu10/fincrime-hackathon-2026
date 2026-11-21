# Track 1 submission system

Run the bundled executable from the repository root:

```sh
system/run institutions/bank output/bank.jsonl
```

It also works from inside `system/` with absolute paths:

```sh
./run /absolute/path/to/institutions/bank /absolute/path/to/output/bank.jsonl
```

Missing output folders are created; the output may not be placed inside the input folder. The runner writes exactly one JSON line per input case, in input order and with all alert IDs. It validates the case and alert references, verdict/reason-code pairs, and cited IDs before writing.

Bad input does not stop the run:
- **Bad rows:** an unreadable line or invalid row is skipped, with a warning on stderr. A leading byte-order mark is ignored.
- **Fallback to ESCALATE:** the case becomes `ESCALATE` with `ESC_UNEXPLAINED_FUNDS`, all of its alert IDs and no cited evidence when:
  - a skipped row or evidence entry still names the case's customer, so their records may be incomplete;
  - the case's own record is malformed;
  - its alert, transaction, customer or document cannot be joined or read;
  - deciding it throws an error or fails validation.
- **Other cases are unaffected.**
- **Exit codes:** the runner exits nonzero only for usage errors, an unreadable input folder, or an output path it refuses. Node.js 24+ is the only runtime requirement; no npm install or prior development run is required at evaluation time. Network access and `OPENROUTER_API_KEY` are optional: without them the runner is fully offline (see [Optional model fallback](#optional-model-fallback)).

## How it decides

The decision logic is deterministic. An optional language-model reader can add checked facts from documents no parser recognised (below), but it never decides a verdict. The runner treats alerts as already raised; it does not rerun the upstream monitoring thresholds. The same code serves all four institutions, and institution differences come from the data and the SOP settings: thresholds in the alert measurements, the payments/FX held-payment release gate, and own-name funding being normal at payments/FX. Each case runs in four steps.

1. **Explain transactions** ([`explanations.ts`](src/explanations.ts)). Document-specific checks compare party names, exact amounts, dates, and account or reference details where applicable. An ordinary outgoing invoice must reconcile uniquely to one payment; a stated beneficiary or account must also match. Recognized document types:
   - Bank statements, including joint accounts and "Account … is held by" lines (`OWN_ACCOUNT`).
   - Invoices, dealer, hospital, carrier and pro forma invoices, contract payment schedules, contractor payment files and freight invoices (`INVOICE_MATCHES`).
   - Insurance settlements, settlement, solicitor and estate letters, completion statements, private sale receipts, tenancy deposit letters and loan agreements (`DOCUMENTED_EVENT`).
   - Gift letters and invoice-finance remittances (`THIRD_PARTY_DOCUMENTED`).
   - Venue refunds, supplier credit notes and ISA cancellations, each linked to the original payment (`REFUND_OF_EARLIER_PAYMENT`).
   - Group structure charts (`GROUP_COMPANY`).
   - Group-trip booking confirmations (`COLLECTION_DOCUMENTED`).
   - Takings books, car-park collection reports and event cash reconciliations (`BUSINESS_RECORDS_RECONCILE`).
   - Declared payroll, established payees, cash re-deposits matching earlier reviewed withdrawals, and same-day merchant receipts matching a unique held payment (`WITHIN_PROFILE`).

   At payments/FX, routine own-name funding is normal. A large dedicated funding transfer counts as explained only when the payment it funded within three days is itself documented.
2. **Look for suspicion** ([`signals.ts`](src/signals.ts)). Each of the following is a concrete signal:
   - A current sending-bank fraud report.
   - A staff note, or the customer's own words in a support chat, about keeping payments under a limit to avoid the related checks.
   - A staff note recording a refusal to explain a higher-risk route.
   - A device shared with other customers.
   - A customer saying others use their account.
   - A payer company dissolved before it paid.
   - Payees controlled by the customer's own director.
   - An invoice table that contradicts the payment it names, or an ordinary invoice quoted by a payment that names a different beneficiary or bills a different amount.
   - A payment file with many payees sharing a few addresses.
3. **Assess each alert against its own rule.**
   - **Internal-list matches (TM22)** use the list assessment. Registers are read on the transaction date: a role with no end date continues after the register's own date, but is not backdated before its start. A gift letter's stated date of birth counts as identity evidence.
   - **Every other alert** is covered when what remains unexplained falls below that rule's own threshold:
     - TM01: only the customer's own top-ups may remain, within the rule's multiple.
     - TM02: the remaining unexplained inflow is below £2,000 **and** every material flagged onward payment is explained. For e-money, a reconciled booking, own-account transfer or tenancy-deposit flow can explain the trigger without treating every attached transaction as part of it. Residual domestic wallet transfers and ATM withdrawals must be below the separate trigger amount and within prior ten-day volumes on the same wallet and channel. Suspicious or unsupported residual activity still prevents closure.
     - TM04: the remaining counterparties are within the limit.
     - TM06 and TM07: the remaining amount is below the limit.
     - All other rules: nothing may remain.
   - **When an alert is not covered,** it escalates only on a concrete pattern:
     - Rapid movement on to crypto (recognised from the payee's name or a reference naming a crypto asset), individuals abroad or several unrelated people.
     - Higher-risk-country payments with several unrelated individuals.
     - Third-party payouts at investment.
   - **Otherwise it becomes one specific request.** An unexplained outflow asks for purpose documents and an unexplained inflow for source of funds. At investment, TM08 requests evidence linking the source and sender to the deposit; if TM01 asks about the same deposit it is not requested twice. Rule-specific requests also cover cash records, counterparty details and reasons for early redemption.
4. **Aggregate.**
   - **Any suspicion wins:** escalate with fixed precedence: listed party, structuring, invoice mismatch, account misuse, early redemption, high-risk corridor, unexplained funds, mule activity, pass-through, then third-party funding.
   - **Otherwise any gap gives one RFI:** the identity question comes first, then the payments/FX release gate, then purpose before source. Other requests are listed in the same reason.
   - **Otherwise the case closes.** Own-account explanations go through the 5× rule first: activity at 5× or more of the declared monthly baseline gives `RFI_UPDATED_PROFILE`.
   - **Payments/FX release gate:** the actual held payment must be explained at any amount. At £10,000 or more it needs a matched invoice or contract unless the destination account is documented as the client's own. A matching name alone does not establish ownership; a standalone payment file or merchant receipt does not replace the required invoice or contract.

Reasons name the decisive facts, amounts, counterparties and documents. Evidence lists only IDs that exist in the supplied files.

## Optional model fallback

When `OPENROUTER_API_KEY` is set, the runner adds a second pass ([`src/llm/`](src/llm/)) for documents written in wording the parsers do not recognise. Without the key, or if a call fails, the output is exactly the deterministic result.

1. **Choose what to read.** After the deterministic pass, nothing is sent for escalated cases, because no new fact can override suspicion. For the rest:
   - **RFI cases:** documents that could explain a payment and that no parser used: letters, receipts, contracts, invoices and ownership statements, but not identity, profile or register records. At most four per case.
   - **RFI and CLOSE cases:** staff notes, support chats and customer emails dated in the review window, checked for statements of concern. At most three per case.
2. **Read.** The model (`anthropic/claude-haiku-5.5` through OpenRouter chat completions, with a strict JSON schema) reports what the document literally says:
   - **Payments:** each payment's direction, other party, amount actually paid, reference, due date, named recipient, purpose and status.
   - **Ownership:** statements that one company owns all of another.
   - **Concerns:** whether someone admits structuring, someone else uses the account, or the customer refused to explain a payment.

   Every value comes with a verbatim quote. The document is treated as data, and instructions inside it are ignored.
3. **Check.** A fact is dropped unless its quote appears word for word in the document and contains the value. A payment must be confirmed or scheduled, not conditional, denied or partial. A concern in a chat must be in the customer's own words; the agent's words do not count.
4. **Match and decide again.** Checked facts go through the same literal matching rules as the parsers: exact pence, the same party (or that party's client account), the stated reference, the customer as recipient, and arrival within 60 days of the document. A refund also needs its unique original payment. A payment the customer makes needs an invoice- or contract-type document and an exact due date or reference. The case is then decided again by the unchanged deterministic logic, in which these facts only fill gaps the parsers left. Concerns become the existing structuring, account-misuse or (with a TM06 alert) high-risk-corridor signals.

**Cost and time (estimated; not yet measured with a live key):**
- **Development data (4,000 cases):** about 250 calls, all concern checks. No development payment document goes unread by the parsers.
- **Estimate:** under US$0.10 for all 4,000 cases, so about US$0.01 for 200, plus about a minute of calls at eight in parallel.
- **Limits:** a 45-second timeout per call, three attempts, and no new calls after 20 minutes.
- **Logging:** stderr reports the number of calls, tokens and the cost OpenRouter returns.

**Reproducibility:** this model does not accept a temperature setting. Repeat runs rely on the strict schema and on verbatim quote checks, so a different but valid wording of the same fact gives the same decision. Live runs still need checking across five repeats.

**Dry run with ideal answers:** a hand-written script supplied correct answers for the synthetic documents. Correct synthetic verdicts went from 29 to 39 of 40, with no wrongful closes; the short gift letter in IV-06 stays an RFI. Early-redemption explanations (IV-01) are not covered by the fallback.

**Model:** none offline; `anthropic/claude-haiku-5.5` when `OPENROUTER_API_KEY` is set. **Cost:** US$0 offline. **Measured offline runtime** on this machine with the bundled runner:
- **200-case subsets** (bank, payments/FX): about 1.1 seconds each.
- **Full 1,000-case files:** 1.6–3.5 seconds each.

Outputs were byte-identical across five runs per institution, from `system/` with absolute paths and from the repository root. [`../labels/`](../labels/) holds our own reviewed judgments for the development cases and a scorer (`python labels/score.py`). They are not organizer labels, and the runner never reads them.

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
