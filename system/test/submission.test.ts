import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Institution } from "../src/bank-cases.js";
import { runSubmission } from "../src/submission.js";

function fixture(t: TestContext, institution: Institution, options: { fraud?: boolean; amount?: number; holder?: boolean; baseline?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fincrime-submission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The folder itself is deliberately not named after the institution.
  const input = join(root, "unseen-set");
  mkdirSync(join(input, "evidence"), { recursive: true });
  const output = join(root, "out.jsonl");
  const write = (name: string, rows: unknown[]) => writeFileSync(join(input, `${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n"));
  const amount = options.amount ?? 10_000;
  const held = institution === "payments_fx";
  write("cases", [{ case_id: "CASE-1", customer_id: "PERSON-1", institution, review_window: { from: "2026-09-01", to: "2026-09-30" },
    alert_ids: ["AL-1"], held_payment_id: held ? "TX-1" : null }]);
  write("customers", [{ customer_id: "PERSON-1", name: "Example Customer", declared: { monthly_income_gbp: options.baseline ?? 4_000 } }]);
  write("alerts", [{ alert_id: "AL-1", case_id: "CASE-1", customer_id: "PERSON-1", rule_id: held ? "TM06" : "TM01",
    transaction_ids: ["TX-1"], measured: { received_gbp: amount } }]);
  write("transactions", [{ transaction_id: "TX-1", customer_id: "PERSON-1", booked_at: "2026-09-07T10:00:00Z", direction: held ? "out" : "in",
    amount_gbp: amount, counterparty_name: options.holder ? "Example Customer" : "Example Counterparty", counterparty_account: "01-02-03 12345678" }]);
  const docs = [{ id: "DOC-KYC", kind: "due_diligence_summary", text: "# Customer information" }];
  if (options.holder) docs.push({ id: "DOC-STM", kind: "bank_statement", text: "**Account holder:** Example Customer\n**Account:** 01-02-03 12345678" });
  if (options.fraud) docs.push({ id: "DOC-RPT", kind: "sending_bank_fraud_report", text: "**Subject:** Sending-bank scam report" });
  write("evidence", docs.map((doc) => ({ doc_id: doc.id, customer_id: "PERSON-1", type: doc.kind, title: doc.id, dated: "2026-09-08", file: `evidence/${doc.id}.md` })));
  for (const doc of docs) writeFileSync(join(input, `evidence/${doc.id}.md`), doc.text);
  write("internal_list", []);
  write("previous_reviews", []);
  return { input, output, write };
}

for (const institution of ["bank", "emoney", "investment", "payments_fx"] as const) {
  test(`writes deterministic submission JSONL for ${institution}`, (t) => {
    const { input, output } = fixture(t, institution);
    runSubmission(input, output);
    const first = readFileSync(output, "utf8");
    runSubmission(input, output);
    assert.equal(readFileSync(output, "utf8"), first);
    assert.equal(first.split("\n").length, 2);
    const result = JSON.parse(first);
    assert.deepEqual(Object.keys(result), ["case_id", "alert_ids", "verdict", "reason_code", "reason", "evidence"]);
    assert.equal(result.case_id, "CASE-1");
    assert.deepEqual(result.alert_ids, ["AL-1"]);
    assert.equal(result.verdict, "RFI");
    assert.deepEqual(result.evidence, ["TX-1"]);
    if (institution === "payments_fx") assert.match(result.reason, /no invoice or contract on file supports it/);
    else assert.match(result.reason, /where the money for .* came from/);
  });
}

test("own-account proof closes below 5× and requests an updated profile at 5×", (t) => {
  const below = fixture(t, "bank", { holder: true, baseline: 2_000, amount: 9_999.99 });
  runSubmission(below.input, below.output);
  assert.equal(JSON.parse(readFileSync(below.output, "utf8")).reason_code, "OWN_ACCOUNT");
  const atLimit = fixture(t, "bank", { holder: true, baseline: 2_000 });
  runSubmission(atLimit.input, atLimit.output);
  assert.equal(JSON.parse(readFileSync(atLimit.output, "utf8")).reason_code, "RFI_UPDATED_PROFILE");
});

test("fraud evidence takes precedence over an otherwise reconciled case", (t) => {
  const { input, output } = fixture(t, "bank", { holder: true, fraud: true });
  runSubmission(input, output);
  const result = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(result.verdict, "ESCALATE");
  assert.equal(result.reason_code, "ESC_MULE_ACTIVITY");
  assert.ok(result.evidence.includes("DOC-RPT"));
});

const readOne = (output: string) => {
  const lines = readFileSync(output, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
};
const assertFallback = (result: Record<string, unknown>, alertIds: string[]) => {
  assert.equal(result.case_id, "CASE-1");
  assert.deepEqual(result.alert_ids, alertIds);
  assert.equal(result.verdict, "ESCALATE");
  assert.equal(result.reason_code, "ESC_UNEXPLAINED_FUNDS");
  assert.deepEqual(result.evidence, []);
};

test("a case whose records cannot be joined is escalated instead of aborting the run", (t) => {
  const { input, output, write } = fixture(t, "bank");
  write("alerts", []);
  runSubmission(input, output);
  assertFallback(readOne(output), ["AL-1"]);
});

test("the output path may not be inside the input folder, and missing output folders are created", (t) => {
  const { input, output } = fixture(t, "bank");
  assert.throws(() => runSubmission(input, join(input, "cases.jsonl")), /must not overwrite/);
  assert.throws(() => runSubmission(input, join(input, "new", "out.jsonl")), /must not overwrite/);
  const nested = join(output, "..", "made", "for", "this", "run.jsonl");
  runSubmission(input, nested);
  assert.equal(readOne(nested).case_id, "CASE-1");
});

test("a bad row naming the customer escalates their case; unrelated bad rows are skipped", (t) => {
  const { input, output } = fixture(t, "bank");
  const decided = () => { runSubmission(input, output); return readOne(output); };
  const baseline = decided();
  assert.notEqual(baseline.reason_code, "ESC_UNEXPLAINED_FUNDS");
  // An unreadable line and a row for another customer leave this case's records intact.
  const transactions = join(input, "transactions.jsonl");
  const original = readFileSync(transactions, "utf8");
  writeFileSync(transactions, `﻿${original}\n{not json\n${JSON.stringify({ transaction_id: "TX-9", customer_id: "OTHER", amount_gbp: -1 })}\n`);
  assert.deepEqual(decided(), baseline);
  // An invalid transaction for this customer means the evidence pack is incomplete.
  writeFileSync(transactions, `${original}\n${JSON.stringify({ transaction_id: "TX-2", customer_id: "PERSON-1", amount_gbp: -1 })}\n`);
  assertFallback(decided(), ["AL-1"]);
});

test("a malformed case record or unreadable document still yields a line for that case", (t) => {
  const { input, output, write } = fixture(t, "bank");
  write("cases", [{ case_id: "CASE-1", customer_id: "PERSON-1", institution: "bank", review_window: { from: "2026-09-30", to: "2026-09-01" }, alert_ids: ["AL-1"] }]);
  runSubmission(input, output);
  assertFallback(readOne(output), ["AL-1"]);

  const second = fixture(t, "bank");
  rmSync(join(second.input, "evidence", "DOC-KYC.md"));
  runSubmission(second.input, second.output);
  assertFallback(readOne(second.output), ["AL-1"]);
});
