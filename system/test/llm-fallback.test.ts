import assert from "node:assert/strict";
import { test } from "node:test";
import type { BankAlert, BankTransaction, Institution, InstitutionCasePack } from "../src/bank-cases.js";
import { decideCase } from "../src/decision.js";
import type { EvidenceDocument } from "../src/evidence.js";
import { extractEvidence } from "../src/evidence-extraction.js";
import { findingsFor, planTasks, readAll } from "../src/llm/fallback.js";
import { openRouterReader, parseReply, type DocumentReader } from "../src/llm/openrouter.js";

// Artificial fixtures only: no development case IDs, names or amounts.
function doc(id: string, type: string, markdown: string, dated = "2026-09-05"): EvidenceDocument {
  return { metadata: { doc_id: id, customer_id: "C1", type, title: id, dated, file: `evidence/${id}.md` },
    markdown, extraction: extractEvidence(id, type, markdown) };
}
function tx(id: string, direction: "in" | "out", amount: number, counterparty: string | null, extra: Partial<BankTransaction> = {}): BankTransaction {
  return { transaction_id: id, customer_id: "C1", booked_at: "2026-09-12T10:00:00Z", direction, amount_gbp: amount, channel: "faster_payment",
    counterparty_name: counterparty, counterparty_account: null, counterparty_country: "United Kingdom", reference: "PAYMENT", ...extra };
}
function alert(id: string, rule: string, txs: readonly BankTransaction[], measured: Record<string, unknown> = {}): BankAlert {
  return { alert_id: id, case_id: "CASE", customer_id: "C1", rule_id: rule, transaction_ids: txs.map((t) => t.transaction_id), measured };
}
function pack(options: { alerts: BankAlert[]; txs: BankTransaction[]; docs: EvidenceDocument[]; institution?: Institution }): InstitutionCasePack {
  return {
    caseRecord: { institution: options.institution ?? "bank", case_id: "CASE", customer_id: "C1", alert_ids: options.alerts.map((a) => a.alert_id),
      review_window: { from: "2026-08-20", to: "2026-09-18" }, held_payment_id: null },
    customer: { customer_id: "C1", name: "Robin Tester", kind: "individual", employer: "Tester Works Ltd",
      declared: { source_of_funds: "Salary", monthly_income_gbp: 3000 } },
    alerts: options.alerts, flaggedTransactions: options.txs, windowTransactions: options.txs, priorTransactions: [],
    documents: options.docs, internalList: [], previousReviews: [],
  };
}

/** A fake model that returns scripted answers per document and counts its calls. */
function fakeReader(answers: Record<string, unknown>): DocumentReader & { calls: string[] } {
  const calls: string[] = [];
  return { calls, summary: () => "fake", read: async (kind, document) => { calls.push(`${kind}:${document.metadata.doc_id}`); return answers[`${kind}:${document.metadata.doc_id}`]; } };
}
async function decideWith(p: InstitutionCasePack, reader: DocumentReader) {
  const first = decideCase(p);
  const tasks = planTasks(p, first);
  const answers = await readAll(tasks.map((task) => ({ task, customerName: p.customer.name })), reader);
  return { first, tasks, second: decideCase(p, findingsFor(p, tasks, answers)) };
}

// A reworded inheritance letter the deterministic parser does not recognise.
const LETTER = `# Letter from Example Solicitors LLP\n\nDear Robin Tester,\n\nWe act for the personal representatives of Alex Example, deceased. Your legacy under the will comes to £40,125.50. We will send it from our client account within five working days.`;
const legacy = tx("IN", "in", 40125.5, "Example Solicitors LLP client account", { reference: "EXAMPLE ESTATE" });
const inheritanceCase = () => pack({ alerts: [alert("A1", "TM01", [legacy], { received_gbp: 40125.5, baseline_gbp: 3000, limit_multiple: 3 })],
  txs: [legacy], docs: [doc("SOL", "solicitor_letter", LETTER)] });
const payment = (overrides: Record<string, unknown> = {}) => ({ payments: [{
  direction: "to_customer", counterparty: "Example Solicitors LLP", counterparty_quote: "Letter from Example Solicitors LLP",
  amount: "£40,125.50", amount_quote: "Your legacy under the will comes to £40,125.50", reference: null, reference_quote: null,
  due_date: null, due_date_quote: null, recipient: null, recipient_quote: null, purpose: "inheritance", status: "confirmed", ...overrides }], ownership: [] });

test("checked facts from an unrecognised letter close the case through the ordinary matching rules", async () => {
  const p = inheritanceCase();
  const { first, tasks, second } = await decideWith(p, fakeReader({ "payments:SOL": payment() }));
  assert.equal(first.verdict, "RFI");
  assert.deepEqual(tasks.map((t) => `${t.kind}:${t.doc.metadata.doc_id}`), ["payments:SOL"]);
  assert.equal(second.verdict, "CLOSE");
  assert.equal(second.reason_code, "DOCUMENTED_EVENT");
  assert.deepEqual(new Set(second.evidence), new Set(["SOL", "IN"]));
  assert.match(second.reason, /£40,125\.50/);
});

test("facts the document does not back, or that do not match a transaction, change nothing", async () => {
  const p = inheritanceCase();
  for (const answer of [
    payment({ amount_quote: "Your legacy comes to £40,125.50" }), // not a verbatim quote
    payment({ amount: "£40,000.00" }), // amount not in its quote
    payment({ amount: "£40,000.00", amount_quote: "£40,000.00" }), // quote not in the document
    payment({ status: "conditional" }),
    payment({ counterparty: "Other Partners LLP", counterparty_quote: "Other Partners LLP" }),
    payment({ recipient: "Sam Other", recipient_quote: "Sam Other" }),
    payment({ purpose: "other" }),
    { payments: "not a list" }, undefined,
  ]) {
    const { second } = await decideWith(p, fakeReader({ "payments:SOL": answer }));
    assert.equal(second.verdict, "RFI", JSON.stringify(answer));
  }
  // The same letter for a different amount does not match the credit.
  const wrongAmount = pack({ ...{ alerts: [alert("A1", "TM01", [{ ...legacy, amount_gbp: 41000 }], { received_gbp: 41000, baseline_gbp: 3000, limit_multiple: 3 })] },
    txs: [{ ...legacy, amount_gbp: 41000 }], docs: [doc("SOL", "solicitor_letter", LETTER)] });
  assert.equal((await decideWith(wrongAmount, fakeReader({ "payments:SOL": payment() }))).second.verdict, "RFI");
});

test("the customer's own words in a chat can show structuring; the agent's cannot", async () => {
  const topups = ["T1", "T2", "T3", "T4"].map((id, i) => tx(id, "in", 900 + i * 20, null, { channel: "cash_topup", reference: "CASH" }));
  const chat = doc("CHAT", "support_chat", "# Chat\n\n**Customer:** I put it in a bit at a time so nobody starts asking questions about it.\n\n**Agent:** Splitting cash to avoid checks is not allowed.", "2026-09-12");
  const p = pack({ institution: "emoney", alerts: [alert("A1", "TM03", topups)], txs: topups, docs: [chat] });
  const answer = (quote: string) => ({ "concerns:CHAT": { structuring: { present: true, quote }, account_used_by_others: { present: false, quote: null }, refused_to_explain: { present: false, quote: null } } });
  const customer = await decideWith(p, fakeReader(answer("I put it in a bit at a time so nobody starts asking questions about it")));
  assert.equal(customer.first.verdict, "RFI");
  assert.equal(customer.second.verdict, "ESCALATE");
  assert.equal(customer.second.reason_code, "ESC_STRUCTURING");
  assert.ok(customer.second.evidence.includes("CHAT"));
  const agent = await decideWith(p, fakeReader(answer("Splitting cash to avoid checks is not allowed")));
  assert.equal(agent.second.verdict, "RFI");
});

test("the model is not asked about escalated cases, and closed cases only for statements of concern", async () => {
  const salary = tx("SAL", "in", 3000, "Tester Works Ltd", { reference: "SALARY SEPTEMBER" });
  const closed = pack({ alerts: [alert("A1", "TM01", [salary], { received_gbp: 3000, baseline_gbp: 3000, limit_multiple: 3 })], txs: [salary],
    docs: [doc("SOL", "solicitor_letter", LETTER), doc("NOTE", "staff_note", "# Note\n\nCustomer called about a card.", "2026-09-01")] });
  const reader = fakeReader({});
  const { first } = await decideWith(closed, reader);
  assert.equal(first.verdict, "CLOSE");
  assert.deepEqual(reader.calls, ["concerns:NOTE"]);
  const fraud = doc("RPT", "sending_bank_fraud_report", "**Subject:** Scam report", "2026-09-13");
  const escalated = pack({ ...{ alerts: inheritanceCase().alerts }, txs: [legacy], docs: [doc("SOL", "solicitor_letter", LETTER), fraud] });
  const silent = fakeReader({});
  assert.equal((await decideWith(escalated, silent)).first.verdict, "ESCALATE");
  assert.deepEqual(silent.calls, []);
});

test("the OpenRouter reader sends a strict JSON-schema request and survives errors", async () => {
  const requests: Record<string, unknown>[] = [];
  let status = 503;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    if (status === 503) { status = 200; return new Response("busy", { status: 503 }); }
    return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{\"payments\":[],\"ownership\":[]}\n```" } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }));
  }) as typeof fetch;
  const reader = openRouterReader({ apiKey: "test-key", fetchImpl, attempts: 2 });
  const answer = await reader.read("payments", doc("SOL", "solicitor_letter", LETTER), "Robin Tester");
  assert.deepEqual(answer, { payments: [], ownership: [] });
  assert.equal(requests.length, 2);
  const body = requests[1] as { model: string; response_format: { type: string; json_schema: { strict: boolean } } };
  assert.equal(body.model, "anthropic/claude-haiku-5.5");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.match(reader.summary(), /US\$0\.0010/);
  const failing = openRouterReader({ apiKey: "test-key", attempts: 1, fetchImpl: (async () => new Response("no", { status: 401 })) as typeof fetch });
  assert.equal(await failing.read("payments", doc("SOL", "solicitor_letter", LETTER), "Robin Tester"), undefined);
  assert.equal(parseReply("not json"), undefined);
});
