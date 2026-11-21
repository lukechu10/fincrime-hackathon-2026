import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadBankCases, type BankCasePack, type BankTransaction } from "../src/bank-cases.js";
import { routeBankCase } from "../src/bank-routing.js";
import type { EvidenceDocument, EvidenceMetadata } from "../src/evidence.js";
import { extractEvidence } from "../src/evidence-extraction.js";

function document(doc_id: string, type: string, markdown: string, dated = "2026-08-08"): EvidenceDocument {
  const metadata: EvidenceMetadata = { doc_id, customer_id: "C1", type, dated, title: doc_id, file: `evidence/${doc_id}.md` };
  return { metadata, markdown, extraction: extractEvidence(doc_id, type, markdown) };
}

const invoiceText = [
  "# Invoice", "**Dated:** 8 August 2026", "**Bill to:** Example Buyer", "**Amount due:** £3,450.09",
  "**Pay to:** Example Supplier, account 01-02-03 12345678",
].join("\n");
const invoice = document("INV-TEST", "invoice", invoiceText);
const report = document("RPT-TEST", "sending_bank_fraud_report", "Another bank reports an apparent scam.", "2026-09-01");
const note = document("NTE-TEST", "contact_note", "The customer says this was a purchase.");
const tx: BankTransaction = {
  transaction_id: "T1", customer_id: "C1", booked_at: "2026-08-12T12:00:00Z", direction: "out", amount_gbp: 3450.09,
  counterparty_name: " Example   Supplier ", counterparty_account: "01020312345678",
};
const pack: BankCasePack = {
  caseRecord: { case_id: "CASE1", institution: "bank", customer_id: "C1", alert_ids: ["A1"],
    review_window: { from: "2026-08-01", to: "2026-08-31" } },
  customer: { customer_id: "C1", name: "Example Buyer" },
  alerts: [{ alert_id: "A1", case_id: "CASE1", customer_id: "C1", rule_id: "TM22", transaction_ids: ["T1"] }],
  flaggedTransactions: [tx], documents: [invoice, note],
};

test("a reconciled invoice advances to policy checks, not a verdict or document clearance", () => {
  const result = routeBankCase(pack);
  assert.equal(result.route, "continue_policy");
  assert.deepEqual(result.invoiceMatches, [{ documentId: "INV-TEST", transactionId: "T1" }]);
  assert.deepEqual(result.alertsWithoutInvoiceCoverage, []);
  assert.deepEqual(result.unparsedDocumentIds, ["NTE-TEST"]);
  assert.equal("verdict" in result, false);
});

test("a same-customer raw fraud report overrides complete invoice coverage, even if posted after the window", () => {
  assert.equal(report.extraction.kind, "unparsed");
  const result = routeBankCase({ ...pack, documents: [invoice, report] });
  assert.equal(result.route, "llm_review");
  assert.deepEqual(result.reasons, ["FRAUD_REPORT_REQUIRES_REVIEW", "INVOICE_COVERAGE_CANDIDATE"]);
  assert.deepEqual(result.fraudReportIds, ["RPT-TEST"]);
  assert.deepEqual(result.unparsedDocumentIds, ["RPT-TEST"]);
  assert.equal(result.invoiceMatches.length, 1);
});

test("wrong amount, payer, payee, destination, date, or direction do not reconcile", () => {
  for (const change of [
    { amount_gbp: 3450.08 }, { counterparty_name: "Another Supplier" }, { booked_at: "2026-08-07T10:00:00Z" },
    { direction: "in" as const }, { counterparty_account: "01-02-03 00000000" }, { counterparty_account: null },
  ]) {
    const result = routeBankCase({ ...pack, flaggedTransactions: [{ ...tx, ...change }] });
    assert.equal(result.route, "llm_review", JSON.stringify(change));
    assert.deepEqual(result.invoiceMatches, []);
  }
  assert.equal(routeBankCase({ ...pack, customer: { ...pack.customer, name: "Different Buyer" } }).route, "llm_review");
});

test("an invoice for only one of multiple alerts cannot complete coverage", () => {
  const second = { ...pack.alerts[0], alert_id: "A2", transaction_ids: ["T2"] };
  const result = routeBankCase({ ...pack, alerts: [pack.alerts[0], second], flaggedTransactions: [tx,
    { ...tx, transaction_id: "T2", amount_gbp: 123 }],
  });
  assert.equal(result.route, "llm_review");
  assert.deepEqual(result.alertsWithoutInvoiceCoverage, ["A2"]);
});

test("one invoice cannot be reused across two indistinguishable payments", () => {
  const result = routeBankCase({ ...pack, alerts: [{ ...pack.alerts[0], transaction_ids: ["T1", "T2"] }],
    flaggedTransactions: [tx, { ...tx, transaction_id: "T2" }],
  });
  assert.equal(result.route, "llm_review");
  assert.deepEqual(result.invoiceMatches, []);
});

test("loads a case with only its customer's original documents and checks references", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bank-routing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "evidence"));
  const writeRows = (file: string, rows: readonly unknown[]) =>
    writeFileSync(join(root, `${file}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeRows("cases", [pack.caseRecord]);
  writeRows("alerts", pack.alerts);
  writeRows("customers", [pack.customer]);
  writeRows("transactions", [tx]);
  writeRows("evidence", [invoice.metadata, report.metadata, { ...note.metadata, customer_id: "C2" }]);
  writeFileSync(join(root, invoice.metadata.file), invoice.markdown);
  writeFileSync(join(root, report.metadata.file), report.markdown);
  const loaded = loadBankCases(root).get("CASE1");
  assert.equal(loaded.documents[1].markdown, report.markdown);
  assert.deepEqual(loaded.documents.map((d) => d.metadata.doc_id), ["INV-TEST", "RPT-TEST"]);
  assert.equal(routeBankCase(loaded).route, "llm_review");
  writeRows("transactions", [{ ...tx, customer_id: "C2" }]);
  assert.throws(() => loadBankCases(root).get("CASE1"), /missing or unrelated transaction T1/);
});
