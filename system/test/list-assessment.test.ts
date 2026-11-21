import assert from "node:assert/strict";
import { test } from "node:test";
import { assessListMatch } from "../src/list-assessment.js";
import type { EvidenceDocument } from "../src/evidence.js";
import { extractEvidence } from "../src/evidence-extraction.js";

function register(docId: string, company: string, born: string, ended = ""): EvidenceDocument {
  const markdown = [
    `**Company:** ${company}`,
    "| Officer | Role | Born | Appointed | Resigned |",
    "|---|---|---|---|---|",
    `| Jordan Example | Director | ${born} | 10 January 2020 | ${ended} |`,
  ].join("\n");
  return {
    metadata: { doc_id: docId, customer_id: "C-1", type: "company_register_extract", title: `Company register extract for ${company}`, dated: "2026-08-01", file: `evidence/${docId}.md` },
    markdown,
    extraction: extractEvidence(docId, "company_register_extract", markdown),
  };
}

const person = { entry_id: "LIST-1", name: "Jordan Example", date_of_birth: "1980-04-15", identifiers: {}, address: "1 Example Road" };
const payment = (day = "2026-08-01", name = "Example Trading Ltd", id = "TX-1") => ({
  transaction_id: id, counterparty_name: name, booked_at: `${day}T10:00:00Z`,
});

test("does not infer a list match from the selected name or premises alone", () => {
  const result = assessListMatch(
    { measured: { list_entry: "LIST-1" } }, [person], [], [payment(undefined, "Jordan Example")],
  );
  assert.equal(result.status, "unresolved");
  assert.deepEqual(result.evidence, ["LIST-1"]);
  assert.match(result.detail, /name or premises match alone is not conclusive/);
});

test("confirms only with the selected entry's matching register birth month/year and an active role", () => {
  const doc = register("REG-1", "Example Trading Ltd", "April 1980");
  const result = assessListMatch(
    { measured: { list_entry: "LIST-1" } }, [person], [doc], [payment()],
  );
  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.evidence, ["LIST-1", "REG-1"]);
});

test("uses a live register birth-month conflict to distinguish a same-name person", () => {
  const doc = register("REG-2", "Example Trading Ltd", "September 1980");
  const result = assessListMatch(
    { measured: { list_entry: "LIST-1" } }, [person], [doc], [payment()],
  );
  assert.equal(result.status, "different");
  assert.deepEqual(result.evidence, ["LIST-1", "REG-2"]);
});

test("does not use a register row whose role had ended before payment", () => {
  const doc = register("REG-3", "Example Trading Ltd", "April 1980", "1 July 2026");
  const result = assessListMatch(
    { measured: { list_entry: "LIST-1" } }, [person], [doc], [payment()],
  );
  assert.equal(result.status, "unresolved");
  assert.deepEqual(result.evidence, ["LIST-1", "REG-3"]);
});

test("does not substitute a name-based entry when measured.list_entry is absent", () => {
  const result = assessListMatch({}, [person], [], [payment(undefined, "Jordan Example")]);
  assert.equal(result.status, "unresolved");
  assert.deepEqual(result.evidence, []);
});

function controlRegister(notified: string, ceased: string): EvidenceDocument {
  const doc = register("PSC-1", "Example Trading Ltd", "April 1980");
  const markdown = ["**Company:** Example Trading Ltd", "| Person | Born | Control | Notified | Ceased |", "|---|---|---|---|---|",
    `| Jordan Example | April 1980 | 60% of shares | ${notified} | ${ceased} |`].join("\n");
  return { ...doc, metadata: { ...doc.metadata, type: "significant_control_register" }, markdown,
    extraction: extractEvidence("PSC-1", "significant_control_register", markdown) };
}

const match = { measured: { list_entry: "LIST-1" } };

test("corroborates control on payment day even after resignation and before a later snapshot", () => {
  const officer = register("REG-4", "Example Trading Ltd", "April 1980", "10 July 2026");
  const controller = controlRegister("1 June 2026", "13 July 2026");
  const result = assessListMatch(match, [person], [officer, controller], [
    payment("2026-07-11", "Unrelated Ltd"), payment("2026-07-11", "Example Trading Ltd", "TX-2"),
  ]);
  assert.equal(result.status, "confirmed");
  assert.equal(result.transactionId, "TX-2");
  assert.deepEqual(result.evidence, ["LIST-1", "PSC-1"]);
  assert.match(result.detail, /significant control on the transaction date 2026-07-11 \(ending on 2026-07-13\)/);
});

test("treats the start date as inclusive and the cessation date as exclusive", () => {
  const controller = controlRegister("1 June 2026", "13 July 2026");
  for (const [day, status] of [["2026-05-31", "unresolved"], ["2026-06-01", "confirmed"], ["2026-07-13", "unresolved"]]) {
    assert.equal(assessListMatch(match, [person], [controller], [payment(day)]).status, status, day);
  }
});

test("does not backdate a control row without a notified date, but an open role continues after the snapshot", () => {
  const controller = controlRegister("", "");
  assert.equal(assessListMatch(match, [person], [controller], [payment("2026-07-31")]).status, "unresolved");
  assert.equal(assessListMatch(match, [person], [controller], [payment("2026-08-01")]).status, "confirmed");
  // Nothing on the register ends the control, so a payment after the snapshot date is still to a controlled payee.
  assert.equal(assessListMatch(match, [person], [controller], [payment("2026-08-02")]).status, "confirmed");
});

test("a dated appointment with no resignation still counts for a payment after the register was produced", () => {
  const doc = register("REG-OPEN", "Example Trading Ltd", "April 1980");
  assert.equal(assessListMatch({ measured: { list_entry: "LIST-1" } }, [person], [doc], [payment("2026-08-20")]).status, "confirmed");
  const ended = register("REG-ENDED", "Example Trading Ltd", "April 1980", "15 August 2026");
  assert.equal(assessListMatch({ measured: { list_entry: "LIST-1" } }, [person], [ended], [payment("2026-08-20")]).status, "unresolved");
});
