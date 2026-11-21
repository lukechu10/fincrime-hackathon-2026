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

The runner is deterministic and makes no model calls. It treats alerts as already raised; it does not rerun the upstream monitoring thresholds. The same code serves all four institutions, and institution differences come from the data and the SOP settings: thresholds in the alert measurements, the payments/FX held-payment release gate, and own-name funding being normal at payments/FX. Each case runs in four steps.

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
   - A staff note about staying under a threshold.
   - A staff note recording a refusal to explain a higher-risk route.
   - A device shared with other customers.
   - A customer saying others use their account.
   - A payer company dissolved before it paid.
   - Payees controlled by the customer's own director.
   - An invoice table that contradicts the payment it names, or a linked ordinary invoice that names a different payment beneficiary.
   - A payment file with many payees sharing a few addresses.
3. **Assess each alert against its own rule.**
   - **Internal-list matches (TM22)** use the list assessment. Registers are read on the transaction date, and a gift letter's stated date of birth counts as identity evidence.
   - **Every other alert** is covered when what remains unexplained falls below that rule's own threshold:
     - TM01: only the customer's own top-ups may remain, within the rule's multiple.
     - TM02: the remaining unexplained inflow is below £2,000 **and** every material flagged onward payment is explained.
     - TM04: the remaining counterparties are within the limit.
     - TM06 and TM07: the remaining amount is below the limit.
     - All other rules: nothing may remain.
   - **When an alert is not covered,** it escalates only on a concrete pattern:
     - Rapid movement on to crypto, individuals abroad or several unrelated people.
     - Higher-risk-country payments with several unrelated individuals.
     - Third-party payouts at investment.
   - **Otherwise it becomes one specific request.** An unexplained outflow asks for purpose documents and an unexplained inflow for source of funds. Rule-specific requests cover cash records, counterparty details and reasons for early redemption.
4. **Aggregate.**
   - **Any suspicion wins:** escalate with fixed precedence: listed party, structuring, invoice mismatch, account misuse, early redemption, high-risk corridor, unexplained funds, mule activity, pass-through, then third-party funding.
   - **Otherwise any gap gives one RFI:** the identity question comes first, then the payments/FX release gate, then purpose before source. Other requests are listed in the same reason.
   - **Otherwise the case closes.** Own-account explanations go through the 5× rule first: activity at 5× or more of the declared monthly baseline gives `RFI_UPDATED_PROFILE`.
   - **Payments/FX release gate:** the actual held payment must be explained at any amount. At £10,000 or more it needs a matched invoice or contract unless the destination account is documented as the client's own. A matching name alone does not establish ownership; a standalone payment file or merchant receipt does not replace the required invoice or contract.

Reasons name the decisive facts, amounts, counterparties and documents. Evidence lists only IDs that exist in the supplied files.

**Model:** none. **Cost:** US$0 per run. **Measured runtime** on this machine with the bundled runner:
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
