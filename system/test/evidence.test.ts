import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadEvidenceIndex, type EvidenceMetadata } from "../src/evidence.js";
import { extractEvidence, type EvidenceFact } from "../src/evidence-extraction.js";

const fact = (facts: readonly EvidenceFact[], field: EvidenceFact["field"]) => facts.find((f) => f.field === field);

const invoice = [
  "# Invoice for office chairs", "**Document ID:** TEST-1", "**Dated:** 8 August 2026", "",
  "**Bill to:** Example Customer", "**Amount due:** £3,450.07", "**Pay to:** Example Supplier, account 00-00-00 00000001",
].join("\n");

test("extracts invoice facts with exact money, source, and a separate destination", () => {
  const extraction = extractEvidence("TEST-1", "invoice", invoice);
  assert.equal(extraction.kind, "invoice");
  assert.deepEqual(fact(extraction.facts, "amountDue"), {
    field: "amountDue", value: { currency: "GBP", minorUnits: 345007 },
    source: { docId: "TEST-1", line: 6, excerpt: "**Amount due:** £3,450.07" },
  });
  assert.equal(fact(extraction.facts, "documentDate")?.value, "2026-08-08");
  assert.equal(fact(extraction.facts, "payee")?.value, "Example Supplier");
  assert.equal(fact(extraction.facts, "paymentDestination")?.value, "account 00-00-00 00000001");
});

test("preserves conflicting amounts and omits malformed dates and unrecognized currencies", () => {
  const { facts } = extractEvidence("TEST-2", "invoice", [
    "**Dated:** 30 February 2026", "**Amount due:** £12,00.40", "**Total:** EUR 300.00",
    "**Price:** £300.00", "**Price:** £301.00", "**Pay to:** IBAN ending 0001",
  ].join("\r\n"));
  assert.deepEqual(facts.filter((f) => f.field === "price").map((f) => f.value), [
    { currency: "GBP", minorUnits: 30000 }, { currency: "GBP", minorUnits: 30100 },
  ]);
  for (const field of ["documentDate", "amountDue", "total", "payee"] as const) assert.equal(fact(facts, field), undefined);
  assert.equal(fact(facts, "paymentDestination")?.value, "IBAN ending 0001");
});

test("keeps multiple invoice lines and money associated with their own invoice numbers", () => {
  const { entries } = extractEvidence("TEST-3", "supplier_invoices", [
    "| Invoice | Dated | Goods | Amount |", "|---|---|---|---|",
    "| A-1 | 1 October 2026 | Chairs \\| other | £100.01 |", "| A-2 | 2 October 2026 | Tables | £120.03 |",
  ].join("\n"));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "invoiceLine");
  assert.equal(fact(entries[0].facts, "goods")?.value, "Chairs | other");
  assert.equal(fact(entries[1].facts, "invoiceNumber")?.value, "A-2");
  assert.deepEqual(fact(entries[1].facts, "amount")?.value, { currency: "GBP", minorUnits: 12003 });
});

test("extracts joint account holders and dated movements without inferring ownership from the transfer", () => {
  const { facts, entries } = extractEvidence("TEST-4", "bank_statement", [
    "**Account holders:** Person One and Person Two", "**Account:** 10-20-30 00000000",
    "17 September 2026: transfer of £18,122.16 to Person One's account elsewhere.",
    "18 September 2026: received £11,000.01 from the payments firm.",
    "19 September 2026: £4,824.00 received into the savings account.",
    "20 September 2026: transfer of £4,12.00 out.",
  ].join("\n"));
  assert.equal(fact(facts, "accountHolders")?.value, "Person One and Person Two");
  assert.equal(fact(facts, "accountHolder"), undefined);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, "statementMovement");
  assert.equal(fact(entries[0].facts, "movementDate")?.value, "2026-09-17");
  assert.deepEqual(fact(entries[2].facts, "amount")?.value, { currency: "GBP", minorUnits: 482400 });
});

test("extracts company identity, dissolution and grouped officer/control rows", () => {
  const { facts, entries } = extractEvidence("TEST-5", "company_register_extract", [
    "**Company number:** 00123456", "**Status:** Dissolved on 28 July 2025", "",
    "| Officer | Role | Born |", "|---|---|---|", "| Person A | Director | 1993 |", "",
    "| Person with significant control | Control |", "|---|---|", "| Person B | Owns 75% or more of shares |",
  ].join("\n"));
  assert.equal(fact(facts, "companyNumber")?.value, "00123456");
  assert.equal(fact(facts, "dissolutionDate")?.value, "2025-07-28");
  assert.deepEqual(entries.map((entry) => entry.kind), ["companyOfficer", "significantControl"]);
  assert.equal(fact(entries[0].facts, "birthDetail")?.value, "1993");
  assert.equal(fact(entries[1].facts, "person")?.value, "Person B");
});

const metadata = (doc_id: string, type = "invoice", customer_id = "ABC"): EvidenceMetadata => ({
  doc_id, customer_id, type, title: "Example document", dated: "2026-08-08", file: `evidence/${doc_id}.md`,
});

function fixture(t: TestContext, rows: readonly EvidenceMetadata[]): string {
  const root = mkdtempSync(join(tmpdir(), "fincrime-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "evidence"));
  writeFileSync(join(root, "evidence.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return root;
}

test("indexes by customer, reads documents lazily, and caches original text and extraction", (t) => {
  const root = fixture(t, [metadata("TEST-1"), metadata("CHAT", "customer_chat"), metadata("MISSING", "invoice", "DEF")]);
  const chat = "**Customer:** The cash came from selling my car.";
  writeFileSync(join(root, "evidence/TEST-1.md"), invoice);
  writeFileSync(join(root, "evidence/CHAT.md"), chat);
  const index = loadEvidenceIndex(root);
  assert.deepEqual(index.metadataForCustomer("ABC").map((r) => r.doc_id), ["TEST-1", "CHAT"]);
  const [loaded, conversation] = index.documentsForCustomer("ABC");
  assert.equal(loaded.markdown, invoice);
  assert.equal(conversation.markdown, chat);
  assert.deepEqual(conversation.extraction, { kind: "unparsed", facts: [], entries: [] });
  rmSync(join(root, "evidence/TEST-1.md"));
  assert.strictEqual(index.get("TEST-1"), loaded);
  assert.equal(index.get("UNKNOWN"), undefined);
  assert.throws(() => index.get("MISSING"), /Cannot read evidence MISSING/);
});

test("reports invalid metadata and clear file/line locations", (t) => {
  const root = fixture(t, [metadata("DUP"), metadata("DUP")]);
  assert.throws(() => loadEvidenceIndex(root), /evidence\.jsonl:2: duplicate evidence ID DUP/);
  writeFileSync(join(root, "evidence.jsonl"), "{bad json}\n");
  assert.throws(() => loadEvidenceIndex(root), /evidence\.jsonl:1: invalid JSON/);
  writeFileSync(join(root, "evidence.jsonl"), "{}\n");
  assert.throws(() => loadEvidenceIndex(root), /evidence\.jsonl:1: invalid evidence metadata/);
});

test("rejects document paths and symlinks escaping the evidence folder", (t) => {
  const root = fixture(t, [{ ...metadata("OUTSIDE"), file: "../outside.md" }]);
  assert.throws(() => loadEvidenceIndex(root), /expected a relative Markdown path under evidence/);
  writeFileSync(join(root, "evidence.jsonl"), JSON.stringify(metadata("OUTSIDE")));
  writeFileSync(join(root, "outside.md"), "Not an evidence document");
  symlinkSync("../outside.md", join(root, "evidence/OUTSIDE.md"));
  assert.throws(() => loadEvidenceIndex(root).get("OUTSIDE"), /document resolves outside the evidence directory/);
});
