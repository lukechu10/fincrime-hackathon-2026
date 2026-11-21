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

test("does not infer a list match from the selected name or premises alone", () => {
  const result = assessListMatch(
    { measured: { list_entry: "LIST-1" } }, [person], [], ["Jordan Example"],
  );
  assert.equal(result.status, "unresolved");
  assert.deepEqual(result.evidence, ["LIST-1"]);
  assert.match(result.detail, /name or premises match alone is not conclusive/);
});

test("confirms only with the selected entry's matching register birth month/year and an active role", () => {
  const doc = register("REG-1", "Example Trading Ltd", "April 1980");
  const result = assessListMatch(
    { measured: { list_entry: "LIST-1" } }, [person], [doc], ["Example Trading Ltd"],
  );
  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.evidence, ["LIST-1", "REG-1"]);
});

test("uses a live register birth-month conflict to distinguish a same-name person", () => {
  const doc = register("REG-2", "Example Trading Ltd", "September 1980");
  const result = assessListMatch(
    { measured: { list_entry: "LIST-1" } }, [person], [doc], ["Example Trading Ltd"],
  );
  assert.equal(result.status, "different");
  assert.deepEqual(result.evidence, ["LIST-1", "REG-2"]);
});

test("does not use a register row whose role had ended before its snapshot", () => {
  const doc = register("REG-3", "Example Trading Ltd", "April 1980", "1 July 2026");
  const result = assessListMatch(
    { measured: { list_entry: "LIST-1" } }, [person], [doc], ["Example Trading Ltd"],
  );
  assert.equal(result.status, "unresolved");
  assert.deepEqual(result.evidence, ["LIST-1", "REG-3"]);
});

test("does not substitute a name-based entry when measured.list_entry is absent", () => {
  const result = assessListMatch({}, [person], [], ["Jordan Example"]);
  assert.equal(result.status, "unresolved");
  assert.deepEqual(result.evidence, []);
});
