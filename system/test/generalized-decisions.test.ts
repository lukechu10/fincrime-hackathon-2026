import assert from "node:assert/strict";
import { test } from "node:test";
import type { BankAlert, BankTransaction, Institution, InstitutionCasePack, ListEntry } from "../src/bank-cases.js";
import { decideCase } from "../src/decision.js";
import type { EvidenceDocument } from "../src/evidence.js";
import { extractEvidence } from "../src/evidence-extraction.js";

// Artificial fixtures only: no development case IDs, names or amounts.
function doc(id: string, type: string, markdown: string, dated = "2026-09-10"): EvidenceDocument {
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
function decide(options: { alerts: BankAlert[]; txs: BankTransaction[]; docs?: EvidenceDocument[]; prior?: BankTransaction[];
  institution?: Institution; customer?: Record<string, unknown>; held?: BankTransaction; list?: ListEntry[] }) {
  const pack: InstitutionCasePack = {
    caseRecord: { institution: options.institution ?? "bank", case_id: "CASE", customer_id: "C1", alert_ids: options.alerts.map((a) => a.alert_id),
      review_window: { from: "2026-08-20", to: "2026-09-18" }, held_payment_id: options.held?.transaction_id ?? null },
    customer: { customer_id: "C1", name: "Robin Tester", kind: "individual", employer: "Tester Works Ltd",
      declared: { source_of_funds: "Salary", monthly_income_gbp: 3000 }, ...options.customer },
    alerts: options.alerts, flaggedTransactions: options.txs, windowTransactions: options.txs, priorTransactions: options.prior ?? [],
    documents: options.docs ?? [], internalList: options.list ?? [], previousReviews: [], heldPayment: options.held,
  };
  return decideCase(pack);
}

test("redundancy explains an early fund sale only with a letter and a timely request linking it to the sale", () => {
  const buy = tx("BUY", "out", 2800, "Test Index Fund", { channel: "fund_subscription", booked_at: "2026-08-25T10:00:00Z" });
  const sale = tx("SELL", "in", 2720, "Test Index Fund", { channel: "fund_redemption" });
  const letter = (day: string) => doc("LETTER", "redundancy_letter", "# Letter from Tester Works Ltd\n\nWe are writing to confirm that your role is redundant.", day);
  const email = (day: string) => doc("EMAIL", "customer_email", "# Email from the customer\n\nI've just been made redundant, so I need to sell my fund holding.", day);
  const run = (docs: EvidenceDocument[], redeemed = sale) => decide({
    institution: "investment", alerts: [alert("A1", "TM10", [buy, redeemed])], txs: [buy, redeemed], docs,
  });
  const current = letter("2026-09-03");
  const request = email("2026-09-10");
  const close = run([current, request]);
  assert.equal(close.verdict, "CLOSE");
  assert.equal(close.reason_code, "DOCUMENTED_EVENT");
  assert.deepEqual(new Set(close.evidence), new Set(["LETTER", "EMAIL", "BUY", "SELL"]));
  assert.doesNotMatch(close.reason, /living costs/);
  for (const rfi of [run([letter("2025-07-03"), request]), run([current]), run([current, email("2026-09-13")]),
    run([current, request], { ...sale, counterparty_name: "Unrelated Bond Fund" })]) {
    assert.equal(rfi.verdict, "RFI");
    assert.equal(rfi.reason_code, "RFI_PURPOSE_DOCUMENTS");
  }
});

const giftBody = (amount: string, donor = "Sam Giver", born = "") =>
  `# Gift letter from ${donor}\n\n**Document ID:** G1\n**Dated:** 10 September 2026\n\nI, ${donor},${born} confirm that I am gifting the sum of ${amount} to my child, Robin Tester. It is non-repayable.`;

test("a gift letter closes third-party funding only when donor, recipient and amount match", () => {
  const gift = tx("T1", "in", 15000, "Sam Giver", { counterparty_account: "11-22-33 44556677", reference: "GIFT" });
  const run = (body: string, payer = gift) => decide({ alerts: [alert("A1", "TM08", [payer])], txs: [payer], docs: [doc("G1", "gift_letter", body)], institution: "investment" });
  const ok = run(giftBody("£15,000.00"));
  assert.equal(ok.verdict, "CLOSE");
  assert.equal(ok.reason_code, "THIRD_PARTY_DOCUMENTED");
  assert.deepEqual(ok.evidence, ["G1", "T1"]);
  assert.notEqual(run(giftBody("£14,000.00")).verdict, "CLOSE");
  assert.notEqual(run(giftBody("£15,000.00", "Other Person")).verdict, "CLOSE");
});

test("a gift letter's stated date of birth confirms or rules out a name-only list match", () => {
  const gift = tx("T1", "in", 15000, "Sam Giver", { counterparty_account: "11-22-33 44556677", reference: "GIFT" });
  const list: ListEntry[] = [{ entry_id: "L1", name: "Sam Giver", date_of_birth: "1970-05-04" }];
  const run = (born: string) => decide({ alerts: [alert("A1", "TM22", [gift], { list_entry: "L1", matched_on: "name" }), alert("A2", "TM08", [gift])],
    txs: [gift], docs: [doc("G1", "gift_letter", giftBody("£15,000.00", "Sam Giver", born))], list, institution: "investment" });
  const same = run(" born 4 May 1970,");
  assert.equal(same.verdict, "ESCALATE");
  assert.equal(same.reason_code, "ESC_LISTED_PARTY");
  const different = run(" born 9 June 1981,");
  assert.equal(different.verdict, "CLOSE");
  assert.equal(different.reason_code, "LIST_MATCH_DIFFERENT_PARTY");
  assert.equal(run("").verdict, "RFI", "no stated date of birth leaves the identity unresolved");
});

const bookingBody = [
  "# Booking confirmation TRIP1 from Example Travel Ltd", "", "**Lead traveller:** Robin Tester", "**Travellers:** 3",
  "**Price:** £200.00 per person, £600.00 in total",
  "**Payment:** due by 15 September 2026, by bank transfer to Example Travel Ltd, account 10-20-30 40506070, reference TRIP1", "",
  "1. Robin Tester", "2. Alex One", "3. Casey Two",
].join("\n");

test("a group booking documents a collection only for listed travellers paying the per-person price", () => {
  const payers = [tx("P1", "in", 200, "Alex One"), tx("P2", "in", 200, "Casey Two")];
  const paid = tx("O1", "out", 600, "Example Travel Ltd", { counterparty_account: "10-20-30 40506070", reference: "BOOKING TRIP1" });
  const run = (txs: BankTransaction[]) => decide({ alerts: [alert("A1", "TM02", txs)], txs, docs: [doc("B1", "booking_confirmation", bookingBody, "2026-09-01")] });
  const ok = run([...payers, paid]);
  assert.equal(ok.verdict, "CLOSE");
  assert.equal(ok.reason_code, "COLLECTION_DOCUMENTED");
  const stranger = tx("P3", "in", 2500, "Unlisted Person");
  assert.notEqual(run([...payers, stranger, paid]).verdict, "CLOSE");
});

test("a takings book reconciles cash top-ups row by row; one unrecorded top-up blocks closure", () => {
  const book = doc("K1", "takings_book", ["# Daily takings book", "", "| Date | Market | Takings | Cash topped up |", "|---|---|---|---|",
    "| 2 September 2026 | Town market | £1,100.00 | £950.00 |", "| 3 September 2026 | Town market | £1,000.00 | £900.00 |"].join("\n"));
  const cash = (id: string, day: string, amount: number) => tx(id, "in", amount, null, { channel: "cash_topup", booked_at: `${day}T17:00:00Z` });
  const topups = [cash("C1", "2026-09-02", 950), cash("C2", "2026-09-03", 900)];
  const ok = decide({ alerts: [alert("A1", "TM03", topups)], txs: topups, docs: [book], institution: "emoney" });
  assert.equal(ok.verdict, "CLOSE");
  assert.equal(ok.reason_code, "BUSINESS_RECORDS_RECONCILE");
  const extra = [...topups, cash("C3", "2026-09-04", 990)];
  const gap = decide({ alerts: [alert("A1", "TM03", extra)], txs: extra, docs: [book], institution: "emoney" });
  assert.equal(gap.verdict, "RFI");
  assert.equal(gap.reason_code, "RFI_BUSINESS_RECORDS");
});

test("undocumented rapid movement asks for documents unless the money goes to crypto or unrelated people", () => {
  const inflow = tx("I1", "in", 5000, "Some Lender Ltd");
  const toCompany = tx("O1", "out", 5200, "Car Dealer Ltd", { booked_at: "2026-09-13T10:00:00Z" });
  const rfi = decide({ alerts: [alert("A1", "TM02", [inflow, toCompany])], txs: [inflow, toCompany] });
  assert.equal(rfi.verdict, "RFI");
  assert.equal(rfi.reason_code, "RFI_PURPOSE_DOCUMENTS");
  const toCrypto = tx("O2", "out", 4900, "Fastcoin Exchange Ltd", { booked_at: "2026-09-13T10:00:00Z" });
  assert.equal(decide({ alerts: [alert("A1", "TM02", [inflow, toCrypto])], txs: [inflow, toCrypto] }).verdict, "ESCALATE");
  const people = [tx("O3", "out", 2400, "Jo Person"), tx("O4", "out", 2400, "Ali Other")];
  assert.equal(decide({ alerts: [alert("A1", "TM02", [inflow, ...people])], txs: [inflow, ...people] }).verdict, "ESCALATE");
});

test("TM02 needs the material onward payment explained even when the incoming funds are documented", () => {
  const gift = tx("I1", "in", 15000, "Sam Giver");
  const onward = tx("O1", "out", 13000, "Car Dealer Ltd", { booked_at: "2026-09-13T10:00:00Z" });
  const letter = doc("G1", "gift_letter", giftBody("£15,000.00"));
  const invoice = doc("V1", "invoice", "# Invoice from Car Dealer Ltd\n**Bill to:** Robin Tester\n**Amount due:** £13,000.00\n**Pay to:** Car Dealer Ltd");
  const run = (payment: BankTransaction, docs: EvidenceDocument[] = [letter]) =>
    decide({ alerts: [alert("A1", "TM02", [gift, payment])], txs: [gift, payment], docs });
  const missing = run(onward);
  assert.equal(missing.reason_code, "RFI_PURPOSE_DOCUMENTS");
  assert.match(missing.reason, /onward payment of £13,000\.00 to Car Dealer Ltd/);
  assert.ok(missing.evidence.includes("O1"));
  assert.equal(run({ ...onward, counterparty_name: "Fastcoin Exchange Ltd" }).reason_code, "ESC_PASS_THROUGH");
  assert.equal(run(onward, [invoice]).verdict, "RFI", "the invoice alone does not explain the inflow");
  assert.equal(run(onward, [letter, invoice]).verdict, "CLOSE");
});

test("a staff note about staying under a threshold escalates as structuring, ahead of other findings", () => {
  const cash = [900, 950, 980].map((amount, i) => tx(`C${i}`, "in", amount, null, { channel: "cash_topup" }));
  const note = doc("N1", "staff_note", "# Note by outlet\n\nThe customer asked whether keeping each top-up below £1,000 would avoid identity checks.");
  const result = decide({ alerts: [alert("A1", "TM03", cash)], txs: cash, docs: [note], institution: "emoney" });
  assert.equal(result.verdict, "ESCALATE");
  assert.equal(result.reason_code, "ESC_STRUCTURING");
  assert.ok(result.evidence.includes("N1"));
});

test("a device shared with other customers is account misuse; a dissolved payer is unexplained funds", () => {
  const inflow = tx("I1", "in", 3000, "Gone Trading Ltd", { reference: "CONSULTANCY" });
  const device = doc("D1", "device_export", ["# Device and login export", "", "| Device | First seen | Customers who logged in from it | Login countries |",
    "|---|---|---|---|", "| X1 | 1 September 2026 | C1, C9 | United Kingdom |"].join("\n"));
  assert.equal(decide({ alerts: [alert("A1", "TM01", [inflow])], txs: [inflow], docs: [device] }).reason_code, "ESC_ACCOUNT_MISUSE");
  const register = doc("R1", "company_register_extract", "# Company register extract for Gone Trading Ltd\n\n**Company:** Gone Trading Ltd\n**Status:** Dissolved on 1 March 2025", "2026-09-01");
  const dissolved = decide({ alerts: [alert("A1", "TM01", [inflow])], txs: [inflow], docs: [register] });
  assert.equal(dissolved.verdict, "ESCALATE");
  assert.equal(dissolved.reason_code, "ESC_UNEXPLAINED_FUNDS");
});

test("an invoice table that contradicts the payment it names escalates as an invoice mismatch", () => {
  const paid = tx("O1", "out", 120000, "Far Supplier Co", { reference: "INV 101", counterparty_country: "Hong Kong" });
  const invoices = doc("V1", "supplier_invoices", ["# Invoices from Far Supplier Co", "", "**Buyer:** Robin Tester", "",
    "| Invoice | Dated | Goods | Amount |", "|---|---|---|---|", "| INV 101 | 14 September 2026 | Handsets | £111,000.00 |"].join("\n"));
  const result = decide({ alerts: [alert("A1", "TM01", [tx("I1", "in", 125000, "Robin Tester")])], txs: [tx("I1", "in", 125000, "Robin Tester"), paid], docs: [invoices] });
  assert.equal(result.reason_code, "ESC_INVOICE_MISMATCH");
});

test("payments/FX own funding closes through a proven own-account onward payment, and asks otherwise", () => {
  const customer = { kind: "business", name: "Tester Imports Ltd", declared: { annual_turnover_gbp: 1_200_000 } };
  const funding = tx("F1", "in", 300000, "Tester Imports Ltd", { counterparty_account: "10-20-30 11223344", reference: "FUNDING" });
  const onward = tx("O1", "out", 295000, "Tester Imports Ltd", { booked_at: "2026-09-13T09:00:00Z", counterparty_account: "IBAN ending 4321", reference: "OWN ACCOUNT TRANSFER" });
  const statement = doc("S1", "bank_statement", ["# Statement from Example Banco", "", "**Account holder:** Tester Imports Ltd", "**Account:** Spanish euro account", "",
    "13 September 2026: received £295,000.00 from the payments firm, sent by Tester Imports Ltd. Account IBAN ending 4321 is held by Tester Imports Ltd."].join("\n"), "2026-09-14");
  const run = (multiple: number, docs: EvidenceDocument[]) => decide({ institution: "payments_fx", customer, txs: [funding, onward], docs,
    alerts: [alert("A1", "TM01", [funding], { received_gbp: 300000, baseline_gbp: 300000 / multiple, multiple, limit_multiple: 2 })] });
  const closed = run(3, [statement]);
  assert.equal(closed.verdict, "CLOSE");
  assert.equal(closed.reason_code, "OWN_ACCOUNT");
  assert.equal(run(6, [statement]).reason_code, "RFI_UPDATED_PROFILE");
  const missing = run(3, []);
  assert.equal(missing.verdict, "RFI");
  assert.equal(missing.reason_code, "RFI_PURPOSE_DOCUMENTS");
  assert.ok(missing.evidence.includes("O1"));
});

test("FX release requires evidence for the held payment itself at every amount", () => {
  const gift = tx("I1", "in", 15000, "Sam Giver");
  const held = tx("H1", "out", 10000, "Robin Tester", { counterparty_account: "11-22-33 44556677" });
  const letter = doc("G1", "gift_letter", giftBody("£15,000.00"));
  const statement = doc("S1", "bank_statement", "# External bank statement\n**Account holder:** Robin Tester\n**Account:** 11-22-33 44556677");
  const run = (payment: BankTransaction, docs: EvidenceDocument[] = []) => decide({ institution: "payments_fx", held: payment,
    customer: { kind: "business", declared: { annual_turnover_gbp: 120000 } },
    alerts: [alert("A1", "TM08", [gift])], txs: [gift], docs: [letter, ...docs] });
  const unresolved = run(held);
  assert.equal(unresolved.verdict, "RFI");
  assert.match(unresolved.reason, /statement showing they hold the destination account/);
  assert.ok(unresolved.evidence.includes("H1"));
  const owned = run(held, [statement]);
  assert.equal(owned.verdict, "CLOSE");
  assert.ok(owned.evidence.includes("S1") && owned.evidence.includes("H1"));
  assert.match(owned.reason, /holds the account used for/);
  assert.equal(run({ ...held, counterparty_account: "11-22-33 44556678" }, [statement]).verdict, "RFI");
  assert.equal(run({ ...held, amount_gbp: 9999.99, counterparty_name: "Vendor Ltd" }).verdict, "RFI");
});

test("a payment file can explain a held payment below £10,000 but is not a high-value invoice or contract", () => {
  const held = tx("H1", "out", 10000, "Avery Contractor", { counterparty_country: "Italy" });
  const run = (amount: number) => {
    const payment = { ...held, amount_gbp: amount };
    const paymentFile = doc("P1", "payment_file", `# Payment file\n| Contractor | Country | Amount |\n|---|---|---|\n| Avery Contractor | Italy | £${amount.toFixed(2)} |`);
    return decide({ institution: "payments_fx", held: payment, txs: [payment], docs: [paymentFile], alerts: [alert("A1", "TM07", [payment])] });
  };
  assert.equal(run(9999.99).verdict, "CLOSE");
  assert.equal(run(10000).reason_code, "RFI_PURPOSE_DOCUMENTS");
});

test("a uniquely matching merchant receipt can support a small held payment, but is not an invoice", () => {
  const gift = tx("I1", "in", 15000, "Sam Giver");
  const letter = doc("G1", "gift_letter", giftBody("£15,000.00"));
  const held = tx("H1", "out", 1550, "Vendor Ltd");
  const receipt = (amount: string, merchant = "Vendor Ltd", received = "received") => doc("R1", "receipt",
    `# Receipt from ${merchant}\n**Dated:** 12 September 2026\nWe have successfully ${received} your payment of ${amount}.`, "2026-09-12");
  const run = (docs: EvidenceDocument[], payment = held) => decide({ institution: "payments_fx", held: payment, txs: [gift, payment],
    docs: [letter, ...docs], alerts: [alert("A1", "TM08", [gift])] });
  const close = run([receipt("£1,550.00")]);
  assert.equal(close.verdict, "CLOSE");
  assert.ok(close.evidence.includes("R1") && close.evidence.includes("H1"));
  assert.equal(run([receipt("£1,551.00")]).verdict, "RFI");
  assert.equal(run([receipt("£1,550.00", "Other Ltd")]).verdict, "RFI");
  assert.equal(run([receipt("£1,550.00", "Vendor Ltd", "not received")]).verdict, "RFI");
  assert.equal(run([receipt("£10,000.00")], { ...held, amount_gbp: 10000 }).verdict, "RFI");
});

test("a linked invoice with a contradictory beneficiary blocks FX release even if another invoice matches", () => {
  const payment = tx("H1", "out", 12000, "Vendor Ltd", { counterparty_account: "11-22-33 44556677" });
  const invoice = (id: string, payee: string) => doc(id, "supplier_invoice", `# Invoice from Vendor Ltd\n**Supplier:** Vendor Ltd\n**Bill to:** Robin Tester\n**Amount due:** £12,000.00\n**Pay to:** ${payee}, account 11-22-33 44556677`);
  const good = invoice("V1", "Vendor Ltd");
  const bad = invoice("V2", "Different Ltd");
  const run = (docs: EvidenceDocument[]) => decide({ institution: "payments_fx", held: payment, txs: [payment], docs,
    alerts: [alert("A1", "TM07", [payment])] });
  assert.equal(run([good]).verdict, "CLOSE");
  for (const docs of [[bad], [good, bad]]) {
    const result = run(docs);
    assert.equal(result.reason_code, "ESC_INVOICE_MISMATCH");
    assert.deepEqual(result.evidence, ["V2", "H1"]);
  }
  assert.equal(run([good, invoice("V3", "Vendor Ltd")]).verdict, "RFI", "two candidate documents are not a unique match");
});

test("a single ordinary invoice is not reused for several equal payments", () => {
  const payments = [12, 13, 14].map((day) => tx(`O${day}`, "out", 9500, "Vendor Ltd", { booked_at: `2026-09-${day}T10:00:00Z` }));
  const invoice = doc("V1", "supplier_invoice", "# Invoice from Vendor Ltd\n**Supplier:** Vendor Ltd\n**Bill to:** Robin Tester\n**Amount due:** £9,500.00");
  const result = decide({ institution: "payments_fx", held: payments[0], txs: payments, docs: [invoice], alerts: [alert("A1", "TM03", payments)] });
  assert.equal(result.verdict, "RFI");
  assert.ok(!result.evidence.includes("V1"));
});

test("a single undocumented commercial payment to a higher-risk country is an RFI, a spread to individuals escalates", () => {
  const supplier = tx("O1", "out", 20000, "Dried Fruit Co", { counterparty_country: "Iraq", reference: "INV 9" });
  const single = decide({ alerts: [alert("A1", "TM06", [supplier], { countries: "Iraq", limit_gbp: 5000 })], txs: [supplier] });
  assert.equal(single.verdict, "RFI");
  const people = [tx("O2", "out", 3000, "Jo Person", { counterparty_country: "Haiti" }), tx("O3", "out", 3000, "Ali Other", { counterparty_country: "Haiti" })];
  const spread = decide({ alerts: [alert("A1", "TM06", people, { countries: "Haiti", limit_gbp: 5000 })], txs: people });
  assert.equal(spread.verdict, "ESCALATE");
  assert.equal(spread.reason_code, "ESC_HIGH_RISK_CORRIDOR");
});

test("several requests without suspicion become one RFI, and an explained alert never hides an unexplained one", () => {
  const credit = tx("I1", "in", 20000, "Some Firm LLP client account", { reference: "SALE PROCEEDS", counterparty_account: "10-20-30 99887766" });
  const result = decide({ institution: "investment", txs: [credit],
    alerts: [alert("A1", "TM01", [credit], { received_gbp: 20000, baseline_gbp: 3000, limit_multiple: 3 }), alert("A2", "TM08", [credit])] });
  assert.equal(result.verdict, "RFI");
  assert.match(result.reason, /Ask Robin Tester/);
});

test("a contract payment schedule closes stage payments only on the exact due date and amount", () => {
  const schedule = doc("K1", "contract_schedule", ["# Payment schedule, contract with Italia Fit Srl", "", "**Project:** Harbour fit-out", "**Supplier:** Italia Fit Srl, Italy", "",
    "| Stage | Work | Due | Amount |", "|---|---|---|---|", "| 1 | Joinery | 12 September 2026 | £9,500.00 |"].join("\n"), "2026-08-01");
  const stage = (amount: number) => tx("O1", "out", amount, "Italia Fit Srl", { reference: "HARBOUR STAGE 1", counterparty_country: "Italy" });
  const run = (payment: BankTransaction) => decide({ institution: "payments_fx", customer: { kind: "business", name: "Robin Tester", declared: { annual_turnover_gbp: 900000 } },
    alerts: [alert("A1", "TM03", [payment])], txs: [payment], docs: [schedule] });
  assert.equal(run(stage(9500)).reason_code, "INVOICE_MATCHES");
  assert.notEqual(run(stage(9600)).verdict, "CLOSE");
});
