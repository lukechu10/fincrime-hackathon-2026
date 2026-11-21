import assert from "node:assert/strict";
import { test } from "node:test";
import type { BankTransaction, InstitutionCasePack } from "../src/bank-cases.js";
import { decideCase } from "../src/decision.js";
import { documentedCredits } from "../src/documented-credits.js";
import type { EvidenceDocument } from "../src/evidence.js";
import { extractEvidence } from "../src/evidence-extraction.js";

function document(id: string, type: string, markdown: string, dated = "2026-10-05"): EvidenceDocument {
  return {
    metadata: { doc_id: id, customer_id: "C1", type, title: id, dated, file: `evidence/${id}.md` },
    markdown, extraction: extractEvidence(id, type, markdown),
  };
}

const venueBody = ["# Email from Example Venue Ltd", "Subject: Cancellation - BOOKING 12345",
  "We have processed the full refund of your deposit in the amount of £6,100.03 for BOOKING 12345."].join("\n");
const insurerBody = ["# Claim settlement letter from Example Assurance plc", "Dear Alex Example,",
  "We have accepted your claim, CLAIM 22345, under your policy.", "Example Assurance plc will settle the claim by sending £6,100.03 by bank transfer."].join("\n");
const original: BankTransaction = {
  transaction_id: "ORIG", customer_id: "C1", direction: "out", booked_at: "2026-08-03T12:00:00Z",
  amount_gbp: 6100.03, counterparty_name: "Example Venue Ltd", counterparty_account: "example-1", counterparty_country: "Lebanon", reference: "BOOKING 12345",
};
const refund: BankTransaction = { ...original, transaction_id: "REFUND", direction: "in", booked_at: "2026-10-06T12:00:00Z",
  counterparty_account: "example-2", reference: "REFUND BOOKING 12345" };
const payout: BankTransaction = { ...refund, transaction_id: "PAYOUT", reference: "CLAIM 22345", counterparty_name: "Example Assurance plc" };
const payroll: BankTransaction = { ...refund, amount_gbp: 2100, transaction_id: "SALARY", reference: "SALARY EXAMPLE EMPLOYER LTD",
  counterparty_name: "Example Employer Ltd", counterparty_country: "United Kingdom", channel: "bacs" };

function pack(credit: BankTransaction, documents: readonly EvidenceDocument[], other?: BankTransaction): InstitutionCasePack {
  const flags = [credit, ...(other ? [other] : [])];
  const tm01 = { alert_id: "A1", case_id: "CASE", customer_id: "C1", rule_id: "TM01", transaction_ids: flags.map((t) => t.transaction_id),
    measured: { received_gbp: other ? 8200.03 : 6100.03, baseline_gbp: 2000 } };
  const second = { ...tm01, alert_id: "A2", rule_id: credit === refund ? "TM06" : "TM07", transaction_ids: [credit.transaction_id] };
  return {
    caseRecord: { institution: "bank", case_id: "CASE", customer_id: "C1", alert_ids: [tm01.alert_id, second.alert_id], review_window: { from: "2026-09-07", to: "2026-10-06" } },
    customer: { customer_id: "C1", name: "Alex Example", employer: "Example Employer Ltd", declared: { source_of_funds: "Salary", monthly_income_gbp: 2000 } },
    documents, priorTransactions: [original], windowTransactions: flags, flaggedTransactions: flags, alerts: [tm01, second],
    internalList: [], previousReviews: [],
  };
}

const venue = document("DOC-VENUE", "venue_email", venueBody);
const insurer = document("DOC-CLAIM", "insurer_letter", insurerBody);

test("links a documented refund to the original outside the window and independently explains payroll", () => {
  const result = decideCase(pack(refund, [venue], payroll));
  assert.equal(result.reason_code, "REFUND_OF_EARLIER_PAYMENT");
  assert.deepEqual(result.evidence, ["DOC-VENUE", "REFUND", "ORIG", "SALARY"]);
  assert.match(result.reason, /BOOKING 12345.*2026-08-03/);
  assert.match(result.reason, /TM01 and TM06/);
});

test("a matching claim can explain both profile and dormancy alerts", () => {
  const result = decideCase(pack(payout, [insurer]));
  assert.equal(result.verdict, "CLOSE");
  assert.equal(result.reason_code, "DOCUMENTED_EVENT");
  assert.deepEqual(result.alert_ids, ["A1", "A2"]);
  assert.deepEqual(result.evidence, ["DOC-CLAIM", "PAYOUT"]);
  assert.match(result.reason, /TM01 and TM07/);
});

test("a credit note can document a refund but cannot replace the earlier transaction", () => {
  const note = document("DOC-CREDIT", "credit_note", "# Credit note from Example Venue Ltd\n**Supplier:** Example Venue Ltd, Beirut\n**Customer:** Alex Example\n**Credit for:** cancelled booking BOOKING 12345\n**Refund:** £6,100.03");
  assert.equal(documentedCredits(pack(refund, [note])).get("REFUND")?.original?.transaction_id, "ORIG");
  assert.equal(documentedCredits({ ...pack(refund, [note]), priorTransactions: [] }).size, 0);
});

test("rejects missing, ambiguous, different-customer or mismatching original payments", () => {
  for (const history of [[], [original, { ...original, transaction_id: "SECOND-ORIG" }],
    [{ ...original, reference: "BOOKING 12346" }], [{ ...original, amount_gbp: 6100.04 }],
    [{ ...original, customer_id: "OTHER" }], [{ ...original, counterparty_name: "Different Venue Ltd" }]]) {
    const input = { ...pack(refund, [venue]), priorTransactions: history };
    assert.equal(documentedCredits(input).size, 0);
    assert.notEqual(decideCase(input).verdict, "CLOSE");
  }
});

test("does not pick one of ambiguous credits or conflicting documents for the same reference", () => {
  const base = pack(refund, [venue]);
  assert.equal(documentedCredits({ ...base, windowTransactions: [refund, { ...refund, transaction_id: "SECOND" }] }).size, 0);
  const conflict = document("DOC-CONFLICT", "venue_email", venueBody.replace("6,100.03", "6,200.03"));
  assert.equal(documentedCredits(pack(refund, [venue, conflict])).size, 0);
});

test("a denial, partial settlement, or verification warning blocks a positive letter", () => {
  for (const conflicting of [
    document("DENIAL", "insurer_letter", "We declined CLAIM 22345 and will not pay £6,100.03."),
    document("PARTIAL", "insurer_letter", "A partial settlement of £2,000.00 for CLAIM 22345 replaces £6,100.03."),
    document("STAFF", "staff_note", "We could not verify DOC-CLAIM with the insurer."),
  ]) {
    const input = pack(payout, [insurer, conflicting]);
    assert.equal(documentedCredits(input).size, 0);
    assert.notEqual(decideCase(input).verdict, "CLOSE");
  }
});

test("notices containing negated or conditional terms do not support closure", () => {
  for (const body of [insurerBody.replace("have accepted", "have not yet accepted"),
    insurerBody.replace("We have accepted", "We cannot confirm that we have accepted")]) {
    assert.equal(documentedCredits(pack(payout, [document("UNCONFIRMED", "insurer_letter", body)])).size, 0);
  }
  const noRefund = document("NOT-DUE", "venue_email", "# Email from Example Venue Ltd\nCancellation of BOOKING 12345: no refund of £6,100.03 is due.");
  const notCancelled = document("NOT-CANCELLED", "credit_note", "# Credit note from Example Venue Ltd\n**Supplier:** Example Venue Ltd\n**Customer:** Alex Example\n**Credit for:** BOOKING 12345 not cancelled\n**Refund:** £6,100.03");
  for (const doc of [noRefund, notCancelled]) assert.equal(documentedCredits(pack(refund, [doc])).size, 0);
});

test("a held outgoing payment is not proof of a previously settled original payment", () => {
  assert.equal(documentedCredits({ ...pack(refund, [venue]), heldPayment: original }).size, 0);
});

test("a payout needs the right recipient, amount, reference, issuer and document date", () => {
  for (const doc of [document("OTHER-NAME", "insurer_letter", insurerBody.replace("Alex Example", "Taylor Example")),
    document("OTHER-REF", "insurer_letter", insurerBody.replace("22345", "22346")),
    document("OTHER-AMOUNT", "insurer_letter", insurerBody.replace("6,100.03", "6,100.30")),
    document("OTHER-ISSUER", "insurer_letter", insurerBody.replace("from Example Assurance plc", "from Other Assurance plc")),
    document("TOO-LATE", "insurer_letter", insurerBody, "2026-10-07"),
    document("INVALID-DATE", "insurer_letter", insurerBody, "05/10/2026"),
    document("REJECTED", "insurer_letter", insurerBody.replace("accepted your claim", "rejected your claim"))]) {
    assert.equal(documentedCredits(pack(payout, [doc])).size, 0, doc.metadata.doc_id);
  }
});

test("a documented event does not clear unexplained inflows, other alerts, or fraud concerns", () => {
  const unexplained = { ...payroll, counterparty_name: "Someone Else" };
  assert.notEqual(decideCase(pack(refund, [venue], unexplained)).verdict, "CLOSE");
  const input = pack(payout, [insurer]);
  const unrelated = { ...input.alerts[1], rule_id: "TM10" };
  assert.notEqual(decideCase({ ...input, alerts: [input.alerts[0], unrelated] }).verdict, "CLOSE");
  const fraud = document("DOC-FRAUD", "sending_bank_fraud_report", "**Subject:** Sending bank report");
  assert.equal(decideCase(pack(payout, [insurer, fraud])).reason_code, "ESC_MULE_ACTIVITY");
});

test("reconciling an incoming credit does not release an undocumented held FX payment", () => {
  const input = pack(payout, [insurer]);
  const held = { ...original, transaction_id: "HELD", amount_gbp: 10000, booked_at: "2026-10-06T13:00:00Z" };
  const result = decideCase({ ...input, heldPayment: held, caseRecord: { ...input.caseRecord, institution: "payments_fx", held_payment_id: "HELD" } });
  assert.equal(result.verdict, "RFI");
  assert.match(result.reason, /no invoice or contract on file supports it/);
});
