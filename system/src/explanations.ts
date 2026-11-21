import type { BankTransaction, InstitutionCasePack } from "./bank-cases.js";
import { documentedCredits } from "./documented-credits.js";
import type { EvidenceDocument } from "./evidence.js";
import { parseGbp } from "./evidence-extraction.js";
import {
  addDays, daysBetween, field, fields, HIGHER_RISK_COUNTRIES, isoDay, isoMonth, nameKey, norm, onlyPounds, pounds, poundsIn,
  sameAccount, sameName, samePence, surname, tableRows, title, txDay,
} from "./text.js";

export type CloseCode = "COLLECTION_DOCUMENTED" | "BUSINESS_RECORDS_RECONCILE" | "DOCUMENTED_EVENT" | "INVOICE_MATCHES"
  | "OWN_ACCOUNT" | "GROUP_COMPANY" | "THIRD_PARTY_DOCUMENTED" | "REFUND_OF_EARLIER_PAYMENT" | "RETURNING_CUSTOMER"
  | "LIST_MATCH_DIFFERENT_PARTY" | "WITHIN_PROFILE";

/** A document- or history-backed reason that one transaction is legitimate. Not a verdict on its own. */
export interface Explanation {
  readonly code: CloseCode;
  readonly docs: readonly string[];
  /** Other transactions relied on, such as the original payment behind a refund. */
  readonly related: readonly string[];
  readonly fact: string;
  /** The customer's own money moving in from their own name, which brings the 5x profile rule into play. */
  readonly ownFunds?: boolean;
}

export interface ExplanationIndex {
  readonly byTx: ReadonlyMap<string, Explanation>;
  readonly invoicePayeeConflicts: readonly { tx: BankTransaction; doc: EvidenceDocument; payee: string }[];
  /** Payments/FX: client funding whose onward payment is not documented, keyed by the funding transaction. */
  readonly unexplainedOnward: ReadonlyMap<string, BankTransaction>;
}

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const label = (s: string) => s.replace(/\s+/g, " ").trim();
export function describe(tx: BankTransaction): string {
  return `${gbp.format(tx.amount_gbp)} ${tx.direction === "in" ? "from" : "to"} ${label(tx.counterparty_name ?? "an unidentified counterparty")} on ${txDay(tx)} (${tx.transaction_id})`;
}

interface Context {
  readonly pack: InstitutionCasePack;
  readonly name: string;
  readonly docs: readonly EvidenceDocument[];
  /** Same-customer history up to the review window end, plus the held payment. */
  readonly history: readonly BankTransaction[];
  /** Transactions this case may need to explain: review window plus the held payment. */
  readonly subjects: readonly BankTransaction[];
}

type Add = (tx: BankTransaction, explanation: Explanation) => void;

function context(pack: InstitutionCasePack): Context {
  const byId = new Map<string, BankTransaction>();
  for (const tx of [...pack.priorTransactions, ...pack.windowTransactions, ...pack.flaggedTransactions]) byId.set(tx.transaction_id, tx);
  if (pack.heldPayment) byId.set(pack.heldPayment.transaction_id, pack.heldPayment);
  const history = [...byId.values()].sort((a, b) => a.booked_at.localeCompare(b.booked_at) || a.transaction_id.localeCompare(b.transaction_id));
  const subjects = history.filter((tx) => tx.booked_at.slice(0, 10) >= pack.caseRecord.review_window.from
    || pack.flaggedTransactions.includes(tx) || tx === pack.heldPayment);
  const docs = pack.documents.filter((doc) => doc.metadata.customer_id === pack.customer.customer_id && !!isoDay(doc.metadata.dated));
  return { pack, name: pack.customer.name, docs, history, subjects };
}

const ofType = (ctx: Context, ...types: string[]) => ctx.docs.filter((doc) => types.includes(doc.metadata.type));
const dated = (doc: EvidenceDocument) => doc.metadata.dated;
/** The document predates (or shares the day of) the transaction and is no more than `days` older. */
const recentBefore = (doc: EvidenceDocument, tx: BankTransaction, days: number) =>
  dated(doc) <= txDay(tx) && daysBetween(dated(doc), txDay(tx)) <= days;
const refHas = (tx: BankTransaction, ref: string) => typeof tx.reference === "string"
  && new RegExp(`(?:^|[^a-z0-9])${norm(ref).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(norm(tx.reference));
const fromTitle = (doc: EvidenceDocument, pattern: RegExp) => pattern.exec(title(doc.markdown))?.[1]?.trim();
const incoming = (ctx: Context) => ctx.subjects.filter((tx) => tx.direction === "in");
const outgoing = (ctx: Context) => ctx.subjects.filter((tx) => tx.direction === "out");
const isCash = (tx: BankTransaction) => typeof tx.channel === "string" && /cash/.test(tx.channel);

/** Statement evidence that the customer holds the account a transfer came from or went to. */
function ownAccount(ctx: Context, add: Add): void {
  for (const tx of ctx.subjects) {
    if (!tx.counterparty_account || tx.direction === undefined) continue;
    for (const doc of ofType(ctx, "bank_statement")) {
      const md = doc.markdown;
      const holder = field(md, "Account holder");
      const holders = (field(md, "Account holders") ?? "").split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
      const accountName = field(md, "Account name");
      const isHolder = sameName(holder, ctx.name) || holders.some((h) => sameName(h, ctx.name));
      const movements = [...md.matchAll(/^(\d{1,2} [A-Za-z]+ \d{4}):\s+(.+)$/gm)]
        .map((m) => ({ day: isoDay(m[1]), amounts: poundsIn(m[2]), text: m[2] }));
      const moved = movements.some((m) => m.day && Math.abs(daysBetween(m.day, txDay(tx))) <= 2 && m.amounts.some((a) => samePence(tx, a)));
      // "Account IBAN ending 1234 is held by <client>" statements identify a masked account explicitly.
      const heldBy = [...md.matchAll(/Account (.+?) is held by (.+?)\.(?:\s|$)/g)]
        .some((m) => sameName(m[2], ctx.name) && sameAccount(m[1], tx.counterparty_account));
      const account = field(md, "Account");
      const named = !tx.counterparty_name || sameName(tx.counterparty_name, ctx.name) || sameName(tx.counterparty_name, accountName);
      const ok = (heldBy && moved)
        || (isHolder && named && sameAccount(account, tx.counterparty_account)
          && (!/ending/i.test(account ?? "") || moved));
      if (!ok) continue;
      add(tx, { code: "OWN_ACCOUNT", docs: [doc.metadata.doc_id], related: [],
        fact: `${doc.metadata.doc_id} shows ${label(ctx.name)} holds the account used for ${describe(tx)}` });
      break;
    }
  }
}

function invoices(ctx: Context, add: Add): ExplanationIndex["invoicePayeeConflicts"] {
  const matches: { doc: EvidenceDocument; tx: BankTransaction; ref?: string }[] = [];
  const conflicts: { doc: EvidenceDocument; tx: BankTransaction; payee: string }[] = [];
  const docCounts = new Map<EvidenceDocument, number>();
  const txCounts = new Map<string, number>();
  const relevant = new Set(ctx.subjects.map((tx) => tx.transaction_id));
  for (const doc of ofType(ctx, "supplier_invoice", "invoice", "carrier_invoice")) {
    const md = doc.markdown;
    if (doc.extraction.entries.length || tableRows(md, ["invoice", "amount"]).length || /instal+ments?/i.test(md)) continue;
    const titleIssuer = fromTitle(doc, /\bfrom (.+)$/i);
    const issuers = ["Supplier", "Carrier"].flatMap((key) => fields(md, key).map((value) => value.split(",")[0]));
    if (titleIssuer) issuers.push(titleIssuer);
    const buyers = ["Buyer", "Bill to"].flatMap((key) => fields(md, key));
    const amounts = ["Amount", "Amount due", "Total"].flatMap((key) => fields(md, key));
    const amount = amounts.length === 1 ? parseGbp(amounts[0])?.minorUnits : undefined;
    const dates = fields(md, "Dated");
    const destinations = fields(md, "Pay to");
    if (!buyers.length || buyers.some((buyer) => !sameName(buyer, ctx.name)) || !amount || destinations.length > 1
      || dates.some((date) => isoDay(date) !== dated(doc))) continue;
    const payTo = destinations[0];
    const namedDestination = payTo && /^(.+?),\s*((?:IBAN|account)\b.+)$/i.exec(payTo);
    const accountOnly = payTo && /^(?:IBAN|account)\b/i.test(payTo);
    const payee = namedDestination ? namedDestination[1] : accountOnly ? undefined : payTo;
    const account = namedDestination ? namedDestination[2] : accountOnly ? payTo : undefined;
    const ref = /\b(INV \d+|CARRIER \d+|PO \d+)\b/.exec(title(md))?.[1] ?? /\border (PO \d+)\b/i.exec(field(md, "Goods") ?? "")?.[1];
    if (!issuers.length && !payee) continue;
    // Include earlier movements when deciding whether a single invoice supports a unique payment.
    for (const tx of ctx.history) {
      if (tx.direction !== "out" || !samePence(tx, amount) || !recentBefore(doc, tx, 60)
        || issuers.some((issuer) => !sameName(tx.counterparty_name, issuer)) || (ref && !refHas(tx, ref))) continue;
      const accountMatches = !!account && sameAccount(account, tx.counterparty_account);
      if (payee && !sameName(payee, tx.counterparty_name)) {
        if (relevant.has(tx.transaction_id) && (ref || accountMatches)) conflicts.push({ doc, tx, payee });
        continue;
      }
      if (account && !accountMatches) continue;
      matches.push({ doc, tx, ref });
      docCounts.set(doc, (docCounts.get(doc) ?? 0) + 1);
      txCounts.set(tx.transaction_id, (txCounts.get(tx.transaction_id) ?? 0) + 1);
    }
  }
  for (const { doc, tx, ref } of matches) {
    if (!relevant.has(tx.transaction_id) || docCounts.get(doc) !== 1 || txCounts.get(tx.transaction_id) !== 1) continue;
    const supplier = tx.counterparty_name!;
    const support = ofType(ctx, "purchase_order", "supply_contract").filter((other) => dated(other) <= txDay(tx)
      && (other.metadata.type === "purchase_order" ? !!ref && /^PO /.test(ref) && refHasText(other.markdown, ref) : norm(other.markdown).includes(norm(supplier))));
    add(tx, { code: "INVOICE_MATCHES", docs: [doc.metadata.doc_id, ...support.map((d) => d.metadata.doc_id)], related: [],
      fact: `${doc.metadata.doc_id} from ${supplier} bills ${label(ctx.name)}${ref ? ` under ${ref}` : ""} and matches the payee, amount and date of ${describe(tx)}` });
  }
  return conflicts;
}

/** A merchant receipt can explain the purpose of a held payment, but is not an invoice or contract. */
function heldPaymentReceipt(ctx: Context, add: Add): void {
  const held = ctx.pack.heldPayment;
  if (ctx.pack.caseRecord.institution !== "payments_fx" || !held) return;
  const matches = ofType(ctx, "receipt").filter((doc) => {
    const merchant = fromTitle(doc, /^Receipt from (.+)$/i);
    const day = dated(doc);
    const amounts = [...doc.markdown.matchAll(/\bwe(?:['’]ve| have) (?:successfully )?(?:received|processed) your payment of (£[\d,.]+)(?=[.!?\s]|$)/gi)];
    if (amounts.length !== 1 || !sameName(merchant, held.counterparty_name) || txDay(held) !== day
      || isoDay(field(doc.markdown, "Dated")) !== day
      || /\b(?:not received|not processed|not yet|pending|partial payment|declined|reversed|refunded)\b/i.test(doc.markdown)) return false;
    const amount = parseGbp(amounts[0][1].replace(/\.$/, ""))?.minorUnits;
    if (!samePence(held, amount)) return false;
    const transactions = ctx.history.filter((tx) => tx.direction === "out" && txDay(tx) === day
      && sameName(tx.counterparty_name, merchant) && samePence(tx, amount));
    return transactions.length === 1;
  });
  if (matches.length !== 1) return;
  add(held, { code: "WITHIN_PROFILE", docs: [matches[0].metadata.doc_id], related: [],
    fact: `Merchant receipt ${matches[0].metadata.doc_id} documents the order and matches the payee, amount and date of ${describe(held)}` });
}

function credits(ctx: Context, add: Add): void {
  for (const credit of documentedCredits(ctx.pack).values()) {
    const refund = credit.kind === "refund";
    add(credit.payment, { code: refund ? "REFUND_OF_EARLIER_PAYMENT" : "DOCUMENTED_EVENT", docs: [credit.documentId],
      related: credit.original ? [credit.original.transaction_id] : [],
      fact: credit.original
        ? `${credit.documentId} records ${credit.reference} and links the refund of ${describe(credit.payment)} to the original payment of ${describe(credit.original)}`
        : `${credit.documentId} records the accepted ${credit.reference} for ${label(ctx.name)} and matches the payout of ${describe(credit.payment)}` });
  }
}

function payroll(ctx: Context, add: Add): void {
  const employer = typeof ctx.pack.customer.employer === "string" ? ctx.pack.customer.employer : undefined;
  const declared = ctx.pack.customer.declared as Record<string, unknown> | undefined;
  const source = typeof declared?.source_of_funds === "string" ? norm(declared.source_of_funds) : "";
  if (!employer || !/salary|employment/.test(source)) return;
  for (const tx of incoming(ctx)) {
    if (sameName(tx.counterparty_name, employer) && typeof tx.reference === "string" && /^salary\b/.test(norm(tx.reference))) {
      add(tx, { code: "WITHIN_PROFILE", docs: [], related: [], fact: `${describe(tx)} is salary from the declared employer` });
    }
  }
}

function settlementLetters(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "settlement_letter")) {
    const payer = fromTitle(doc, /^Settlement agreement letter from (.+)$/i);
    const amount = onlyPounds(doc.markdown);
    if (!payer || amount === undefined) continue;
    for (const tx of incoming(ctx)) {
      if (sameName(tx.counterparty_name, payer) && samePence(tx, amount) && recentBefore(doc, tx, 30)
        && (!tx.reference || /settlement/i.test(String(tx.reference)))) {
        add(tx, { code: "DOCUMENTED_EVENT", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} confirms a settlement payment from ${payer} of the same amount as ${describe(tx)}` });
      }
    }
  }
}

function solicitorLetters(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "solicitor_letter")) {
    const firm = fromTitle(doc, /^Letter from (.+)$/i);
    const deceased = /[Ee]state of the late ([A-Z][A-Za-z'’-]+(?: [A-Z][A-Za-z'’-]+)+)/.exec(doc.markdown)?.[1];
    const amount = onlyPounds(doc.markdown);
    if (!firm || !deceased || amount === undefined) continue;
    for (const tx of incoming(ctx)) {
      const payerOk = !!tx.counterparty_name && nameKey(tx.counterparty_name).startsWith(nameKey(firm));
      const refOk = !tx.reference || !/estate/i.test(String(tx.reference)) || norm(String(tx.reference)).includes(norm(deceased));
      if (payerOk && refOk && samePence(tx, amount) && recentBefore(doc, tx, 30)) {
        add(tx, { code: "DOCUMENTED_EVENT", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} from ${firm} confirms ${label(ctx.name)}'s inheritance from the estate of ${deceased}, matching ${describe(tx)}` });
      }
    }
  }
}

function completionStatements(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "completion_statement")) {
    const firm = fromTitle(doc, /^Completion statement from (.+)$/i);
    const paid = pounds(/\*\*Paid to[^*]*:\*\*\s*(£[\d,.]+)/i.exec(doc.markdown)?.[1]);
    const [sale, mortgage, fees] = ["Sale price", "Mortgage redeemed", "Fees"].map((l) => pounds(field(doc.markdown, l)));
    if (!firm || paid === undefined || !sameName(field(doc.markdown, "Client"), ctx.name)) continue;
    // The statement's own arithmetic must hold; allow a penny or two of rounding, no more.
    if (sale !== undefined && mortgage !== undefined && fees !== undefined && Math.abs(sale - mortgage - fees - paid) > 2) continue;
    for (const tx of incoming(ctx)) {
      if (tx.counterparty_name && nameKey(tx.counterparty_name).startsWith(nameKey(firm)) && samePence(tx, paid) && recentBefore(doc, tx, 30)) {
        add(tx, { code: "DOCUMENTED_EVENT", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} from ${firm} shows ${label(ctx.name)}'s property sale proceeds paid as ${describe(tx)}` });
      }
    }
  }
}

/** Donor, date of birth (if stated) and recipient of a gift letter. */
export function giftLetter(doc: EvidenceDocument): { donor: string; born?: string; recipient?: string; amount?: number } | undefined {
  if (doc.metadata.type !== "gift_letter") return;
  const donor = fromTitle(doc, /^Gift letter from (.+)$/i);
  if (!donor) return;
  const bornText = /\bborn(?: on)? (\d{1,2} [A-Za-z]+ \d{4})|\(DOB:?\s*([^)]+)\)/i.exec(doc.markdown);
  const born = isoDay(bornText?.[1] ?? bornText?.[2]);
  const recipient = /\bto my [a-z -]{1,30}?,\s*([A-Z][A-Za-z'’-]+(?: [A-Z][A-Za-z'’-]+)+)/.exec(doc.markdown)?.[1];
  return { donor, born, recipient, amount: poundsIn(doc.markdown)[0] };
}

function giftLetters(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "gift_letter")) {
    const gift = giftLetter(doc);
    if (!gift?.recipient || !sameName(gift.recipient, ctx.name)) continue;
    for (const tx of incoming(ctx)) {
      if (sameName(tx.counterparty_name, gift.donor) && samePence(tx, gift.amount) && recentBefore(doc, tx, 30)) {
        add(tx, { code: "THIRD_PARTY_DOCUMENTED", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} is a signed gift letter from ${gift.donor} to ${label(ctx.name)} for the amount of ${describe(tx)}` });
      }
    }
  }
}

function saleParties(md: string): { seller?: string; buyer?: string } {
  const person = String.raw`([A-Z][A-Za-z'’-]+(?: [A-Z][A-Za-z'’-]+)+)`;
  const seller = field(md, "Seller")?.split(",")[0] ?? new RegExp(String.raw`\bfrom ${person} to ${person}`).exec(md)?.[1]
    // First-person or "X has sold" wording identifies the seller; a purchase wording would not.
    ?? new RegExp(String.raw`\bI, ${person}, (?:hereby |have (?:today |this day )?)?(?:sold|confirm the sale|acknowledge the sale)`).exec(md)?.[1]
    ?? new RegExp(String.raw`\b${person} has sold\b`).exec(md)?.[1]
    ?? new RegExp(String.raw`^Seller:\s*${person}`, "m").exec(md)?.[1];
  const buyer = field(md, "Buyer")?.split(",")[0] ?? new RegExp(String.raw`\bfrom ${person} to ${person}`).exec(md)?.[2]
    ?? new RegExp(String.raw`\bto ${person}(?:\.| for\b|,)`).exec(md)?.[1] ?? new RegExp(String.raw`^Buyer:\s*${person}`, "m").exec(md)?.[1]
    ?? new RegExp(String.raw`Received from ${person}`).exec(md)?.[1];
  return { seller, buyer };
}

function saleReceipts(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "sale_receipt", "vehicle_sale_receipt")) {
    const { seller, buyer } = saleParties(doc.markdown);
    const amount = onlyPounds(doc.markdown);
    if (!sameName(seller, ctx.name) || sameName(buyer, ctx.name) || amount === undefined) continue;
    const registration = /registration ([A-Z]{2}\d{2} ?[A-Z]{3})/.exec(doc.markdown)?.[1];
    const support = ofType(ctx, "insurance_schedule", "advert").filter((other) => other.metadata.type === "advert"
      ? new RegExp(`Seller:\\s*${ctx.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(other.markdown)
      : !!registration && sameName(field(other.markdown, "Policyholder"), ctx.name)
        && norm(field(other.markdown, "Vehicle") ?? "").includes(norm(registration)));
    for (const tx of incoming(ctx)) {
      if (isCash(tx) && samePence(tx, amount) && recentBefore(doc, tx, 7)) {
        add(tx, { code: "DOCUMENTED_EVENT", docs: [doc.metadata.doc_id, ...support.map((d) => d.metadata.doc_id)], related: [],
          fact: `${doc.metadata.doc_id} records ${label(ctx.name)} selling ${registration ? `vehicle ${registration}` : "an item"} to ${buyer ?? "a buyer"} for cash equal to ${describe(tx)}` });
      }
    }
  }
}

function takingsBooks(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "takings_book")) {
    const rows = tableRows(doc.markdown, ["date", "takings", "cash topped up"]);
    const used = new Set<number>();
    for (const tx of incoming(ctx).filter(isCash)) {
      const index = rows.findIndex((row, i) => !used.has(i) && isoDay(row.date) === txDay(tx)
        && samePence(tx, pounds(row["cash topped up"])) && (pounds(row.takings) ?? 0) >= (pounds(row["cash topped up"]) ?? Infinity));
      if (index < 0) continue;
      used.add(index);
      add(tx, { code: "BUSINESS_RECORDS_RECONCILE", docs: [doc.metadata.doc_id], related: [],
        fact: `${doc.metadata.doc_id} records ${rows[index].takings} of takings on ${txDay(tx)}, from which the ${describe(tx)} cash top-up was paid in` });
    }
  }
}

function collectionReports(ctx: Context, add: Add): void {
  const branches = new Map<string, string>();
  const procedures = ofType(ctx, "cash_handling_procedure");
  for (const doc of procedures) {
    for (const m of doc.markdown.matchAll(/^(.+? car park):.*?\bat (.+? branch)\b/gim)) branches.set(norm(m[1]), norm(m[2]));
  }
  for (const doc of ofType(ctx, "cash_collection_reports")) {
    const rows = tableRows(doc.markdown, ["site", "emptied", "notes", "coins", "total", "safe bag"]);
    if (new Set(rows.map((row) => row["safe bag"])).size !== rows.length) continue;
    const used = new Set<number>();
    for (const tx of incoming(ctx).filter(isCash)) {
      const index = rows.findIndex((row, i) => {
        const emptied = isoDay(row.emptied);
        const total = pounds(row.total);
        const branch = branches.get(norm(row.site));
        return !used.has(i) && !!emptied && typeof tx.reference === "string" && norm(tx.reference) === `${norm(row.site)} takings`
          && samePence(tx, total) && (pounds(row.notes) ?? 0) + (pounds(row.coins) ?? 0) === total
          && daysBetween(emptied, txDay(tx)) >= 1 && daysBetween(emptied, txDay(tx)) <= 3
          && (!branch || (typeof tx.location === "string" && norm(tx.location) === branch));
      });
      if (index < 0) continue;
      used.add(index);
      const row = rows[index];
      add(tx, { code: "BUSINESS_RECORDS_RECONCILE", docs: [doc.metadata.doc_id, ...procedures.map((d) => d.metadata.doc_id)], related: [],
        fact: `${doc.metadata.doc_id} records ${row.site} emptied on ${row.emptied} with ${row.total} counted into safe bag ${row["safe bag"]}, banked as ${describe(tx)}` });
    }
  }
}

function cashReconciliations(ctx: Context, add: Add): void {
  const reports = ofType(ctx, "ticket_report").map((d) => d.metadata.doc_id);
  for (const doc of ofType(ctx, "cash_reconciliation")) {
    const rows = tableRows(doc.markdown, ["point", "cash counted", "banked"]);
    const used = new Set<number>();
    for (const tx of incoming(ctx).filter(isCash)) {
      const index = rows.findIndex((row, i) => !used.has(i) && typeof tx.reference === "string"
        && norm(tx.reference) === `${norm(row.point)} takings` && samePence(tx, pounds(row["cash counted"])) && isoDay(row.banked) === txDay(tx));
      if (index < 0) continue;
      used.add(index);
      add(tx, { code: "BUSINESS_RECORDS_RECONCILE", docs: [doc.metadata.doc_id, ...reports], related: [],
        fact: `${doc.metadata.doc_id} reconciles ${rows[index]["cash counted"]} counted at ${rows[index].point} and banked on ${txDay(tx)} as ${describe(tx)}` });
    }
  }
}

function bookingConfirmations(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "booking_confirmation")) {
    const md = doc.markdown;
    const [perPerson, total] = poundsIn(field(md, "Price") ?? "");
    const count = Number(field(md, "Travellers"));
    const payment = /to (.+?), account (.+?), reference (\S+)/.exec(field(md, "Payment") ?? "");
    const due = isoDay(/due by (\d{1,2} [A-Za-z]+ \d{4})/.exec(field(md, "Payment") ?? "")?.[1]);
    const travellers = [...md.matchAll(/^\s*\d+\.\s+(.+?)\s*$/gm)].map((m) => m[1]);
    if (!sameName(field(md, "Lead traveller"), ctx.name) || !perPerson || !total || !payment
      || perPerson * count !== total || travellers.length !== count) continue;
    const unpaid = new Set(travellers.filter((t) => !sameName(t, ctx.name)).map(nameKey));
    for (const tx of incoming(ctx)) {
      const key = tx.counterparty_name ? nameKey(tx.counterparty_name) : "";
      if (unpaid.has(key) && samePence(tx, perPerson) && txDay(tx) >= dated(doc)) {
        unpaid.delete(key);
        add(tx, { code: "COLLECTION_DOCUMENTED", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} lists ${label(tx.counterparty_name!)} as a traveller on ${label(ctx.name)}'s group booking at ${gbp.format(perPerson / 100)} per person, matching ${describe(tx)}` });
      }
    }
    for (const tx of outgoing(ctx)) {
      if (sameName(tx.counterparty_name, payment[1]) && sameAccount(tx.counterparty_account, payment[2]) && samePence(tx, total)
        && refHas(tx, payment[3]) && txDay(tx) >= dated(doc) && (!due || txDay(tx) <= due)) {
        add(tx, { code: "COLLECTION_DOCUMENTED", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} shows a ${count}-person booking costing ${gbp.format(total / 100)} payable to ${payment[1]} under reference ${payment[3]}, paid as ${describe(tx)}` });
      }
    }
  }
}

function tenancyDeposits(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "deposit_return_letter")) {
    const agent = fromTitle(doc, /^Deposit return from (.+)$/i);
    const amount = onlyPounds(doc.markdown);
    for (const tx of incoming(ctx)) {
      if (agent && sameName(tx.counterparty_name, agent) && samePence(tx, amount) && recentBefore(doc, tx, 7)) {
        add(tx, { code: "DOCUMENTED_EVENT", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} confirms ${agent} returned the tenancy deposit paid in as ${describe(tx)}` });
      }
    }
  }
  for (const doc of ofType(ctx, "holding_deposit_receipt")) {
    const landlord = fromTitle(doc, /^Holding deposit receipt from (.+)$/i);
    const amount = onlyPounds(doc.markdown);
    for (const tx of outgoing(ctx)) {
      if (landlord && sameName(tx.counterparty_name, landlord) && samePence(tx, amount) && Math.abs(daysBetween(dated(doc), txDay(tx))) <= 3) {
        add(tx, { code: "DOCUMENTED_EVENT", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} confirms ${landlord} received the holding deposit for the new tenancy, paid as ${describe(tx)}` });
      }
    }
  }
}

function vehicleFinance(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "loan_agreement")) {
    const lender = fromTitle(doc, /^Personal loan agreement with (.+)$/i);
    const amount = onlyPounds(doc.markdown);
    if (!lender || !norm(doc.markdown).includes(norm(ctx.name))) continue;
    for (const tx of incoming(ctx)) {
      if (sameName(tx.counterparty_name, lender) && samePence(tx, amount) && recentBefore(doc, tx, 14)) {
        add(tx, { code: "DOCUMENTED_EVENT", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} is ${label(ctx.name)}'s personal loan from ${lender}, advanced as ${describe(tx)}` });
      }
    }
  }
  for (const doc of ofType(ctx, "dealer_invoice")) {
    const heading = /^Invoice (INV \d+) from (.+)$/i.exec(title(doc.markdown));
    const amount = pounds(field(doc.markdown, "Paid by bank transfer")) ?? pounds(field(doc.markdown, "Price"));
    if (!heading || !sameName(field(doc.markdown, "Customer"), ctx.name)) continue;
    for (const tx of outgoing(ctx)) {
      if (sameName(tx.counterparty_name, heading[2]) && refHas(tx, heading[1]) && samePence(tx, amount) && recentBefore(doc, tx, 14)) {
        add(tx, { code: "INVOICE_MATCHES", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} (${heading[1]}) from ${heading[2]} bills ${label(ctx.name)} for ${field(doc.markdown, "Vehicle") ?? "a vehicle"}, matching ${describe(tx)}` });
      }
    }
  }
}

function hospitalInvoices(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "hospital_invoice")) {
    const patient = field(doc.markdown, "Patient");
    const amount = pounds(field(doc.markdown, "Amount due"));
    const payee = field(doc.markdown, "Pay to")?.split(",")[0];
    if (!patient || !payee || surname(patient) !== surname(ctx.name)) continue;
    const chats = ofType(ctx, "support_chat").filter((chat) => norm(chat.markdown).includes(norm(patient)));
    for (const tx of outgoing(ctx)) {
      if (sameName(tx.counterparty_name, payee) && samePence(tx, amount) && recentBefore(doc, tx, 60)
        && typeof tx.reference === "string" && norm(tx.reference) === `patient ${norm(patient)}`) {
        add(tx, { code: "INVOICE_MATCHES", docs: [doc.metadata.doc_id, ...chats.map((c) => c.metadata.doc_id)], related: [],
          fact: `${doc.metadata.doc_id} from ${payee} bills treatment for ${patient}, a relative of ${label(ctx.name)}, and matches ${describe(tx)}` });
      }
    }
  }
}

function cancellations(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "cancellation_confirmation")) {
    const md = doc.markdown;
    // Read the facts, not the phrasing: one amount, the date the subscription was received, one account.
    const amount = onlyPounds(md);
    const received = isoDay(/\breceived(?: on)? (\d{1,2} [A-Za-z]+ \d{4})/i.exec(md)?.[1]);
    const accounts = [...new Set([...md.matchAll(/\b(\d{2}-\d{2}-\d{2} \d{8})\b/g)].map((m) => m[1]))];
    const account = accounts.length === 1 ? accounts[0] : undefined;
    if (!/\bcancel/i.test(md) || !account || amount === undefined || !received) continue;
    const paidIn = incoming(ctx).find((tx) => samePence(tx, amount) && txDay(tx) === received && sameAccount(tx.counterparty_account, account)
      && sameName(tx.counterparty_name, ctx.name));
    const refund = outgoing(ctx).find((tx) => samePence(tx, amount) && txDay(tx) >= received && sameAccount(tx.counterparty_account, account));
    if (!paidIn || !refund) continue;
    const fact = `${doc.metadata.doc_id} confirms the cancelled subscription of ${describe(paidIn)} was returned to the same account in ${label(ctx.name)}'s name as ${describe(refund)}`;
    for (const tx of [paidIn, refund]) add(tx, { code: "REFUND_OF_EARLIER_PAYMENT", docs: [doc.metadata.doc_id], related: [paidIn.transaction_id, refund.transaction_id], fact });
  }
}

function redundancy(ctx: Context, add: Add): void {
  const employer = typeof ctx.pack.customer.employer === "string" ? ctx.pack.customer.employer : undefined;
  const letters = ofType(ctx, "redundancy_letter").filter((doc) => /redundan/i.test(doc.markdown)
    && !!employer && sameName(fromTitle(doc, /^Letter from (.+)$/i), employer));
  if (!letters.length) return;
  const emails = ofType(ctx, "customer_email").filter((doc) => /redundan/i.test(doc.markdown) && /\bsell\b/i.test(doc.markdown));
  const fundMoves = ctx.subjects.filter((tx) => tx.channel === "fund_redemption" || tx.channel === "fund_subscription");
  const redemptions = fundMoves.filter((tx) => tx.channel === "fund_redemption");
  for (const tx of fundMoves) {
    const letter = letters.find((doc) => redemptions.some((r) => dated(doc) <= txDay(r)));
    if (!letter) continue;
    add(tx, { code: "DOCUMENTED_EVENT", docs: [letter.metadata.doc_id, ...emails.map((e) => e.metadata.doc_id)], related: [],
      fact: `${letter.metadata.doc_id} from ${employer} confirms ${label(ctx.name)} was made redundant before the fund sale, which the customer requested to cover living costs (${describe(tx)})` });
  }
}

function cashRedeposits(ctx: Context, add: Add): void {
  for (const chat of ofType(ctx, "support_chat")) {
    const claim = /(£[\d,]+\.\d{2}) I withdrew (?:back )?in ([A-Za-z]+ \d{4})/.exec(chat.markdown);
    const amount = pounds(claim?.[1]);
    const month = isoMonth(claim?.[2]);
    if (amount === undefined || !month) continue;
    const withdrawals = ctx.history.filter((tx) => tx.direction === "out" && tx.channel === "cash_withdrawal"
      && samePence(tx, amount) && txDay(tx).startsWith(month));
    if (withdrawals.length !== 1) continue;
    const reviewed = ctx.pack.previousReviews.some((review) => review.rule_id === "TM05" && /^closed\b/i.test(review.note)
      && /cash withdrawal/i.test(review.note) && typeof review.reviewed_on === "string" && review.reviewed_on >= txDay(withdrawals[0]));
    if (!reviewed) continue;
    for (const tx of incoming(ctx)) {
      if (isCash(tx) && samePence(tx, amount) && txDay(tx) > txDay(withdrawals[0]) && dated(chat) >= txDay(tx)) {
        add(tx, { code: "WITHIN_PROFILE", docs: [chat.metadata.doc_id], related: [withdrawals[0].transaction_id],
          fact: `${chat.metadata.doc_id} records ${label(ctx.name)} re-depositing the same cash withdrawn as ${describe(withdrawals[0])} for a private car purchase that a prior review closed, matching ${describe(tx)}` });
      }
    }
  }
}

const refHasText = (text: string, ref: string) => new RegExp(`\\b${ref.replace(/\s+/g, "\\s+")}\\b`, "i").test(text);

function contractSchedules(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "contract_schedule")) {
    const supplier = field(doc.markdown, "Supplier")?.split(",")[0];
    const prefix = field(doc.markdown, "Project")?.split(/\s+/)[0];
    const rows = tableRows(doc.markdown, ["stage", "due", "amount"]);
    if (!supplier || !prefix) continue;
    for (const tx of outgoing(ctx)) {
      const row = rows.find((r) => isoDay(r.due) === txDay(tx) && samePence(tx, pounds(r.amount))
        && typeof tx.reference === "string" && norm(tx.reference) === norm(`${prefix} stage ${r.stage}`));
      if (row && sameName(tx.counterparty_name, supplier) && dated(doc) <= txDay(tx)) {
        add(tx, { code: "INVOICE_MATCHES", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} schedules stage ${row.stage} (${row.work ?? "contract work"}) to ${supplier} for ${row.amount} due on ${row.due}, matching ${describe(tx)}` });
      }
    }
  }
}

function contractorFiles(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "payment_file")) {
    const rows = tableRows(doc.markdown, ["contractor", "country", "amount"]);
    const used = new Set<number>();
    for (const tx of outgoing(ctx)) {
      const index = rows.findIndex((row, i) => !used.has(i) && sameName(row.contractor, tx.counterparty_name)
        && samePence(tx, pounds(row.amount)) && norm(row.country) === norm(String(tx.counterparty_country ?? ""))
        && Math.abs(daysBetween(dated(doc), txDay(tx))) <= 7);
      if (index < 0) continue;
      used.add(index);
      add(tx, { code: "INVOICE_MATCHES", docs: [doc.metadata.doc_id], related: [],
        fact: `${doc.metadata.doc_id} lists ${rows[index].contractor} under contract ${rows[index].contract ?? ""} for ${rows[index].amount}, matching ${describe(tx)}` });
    }
  }
}

function freightInvoices(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "freight_invoices")) {
    if (!sameName(fromTitle(doc, /issued by (.+)$/i), ctx.name)) continue;
    const rows = tableRows(doc.markdown, ["invoice", "exporter", "amount"]);
    for (const tx of incoming(ctx)) {
      const row = rows.find((r) => sameName(r.exporter, tx.counterparty_name) && samePence(tx, pounds(r.amount)) && refHas(tx, r.invoice));
      if (row) {
        add(tx, { code: "INVOICE_MATCHES", docs: [doc.metadata.doc_id], related: [],
          fact: `${doc.metadata.doc_id} shows ${label(ctx.name)} invoiced ${row.exporter} ${row.amount} under ${row.invoice}, paid as ${describe(tx)}` });
      }
    }
  }
}

function groupCompanies(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "group_structure")) {
    const owner = new Map<string, string>();
    for (const row of [...tableRows(doc.markdown, ["company", "owner", "share"]), ...tableRows(doc.markdown, ["company", "owned by", "share"])]) {
      const parent = row.owner ?? row["owned by"];
      if (parent && /^100\s*%$/.test(row.share.trim())) owner.set(nameKey(row.company), nameKey(parent));
    }
    const client = nameKey(ctx.name);
    for (const tx of incoming(ctx)) {
      if (!tx.counterparty_name || dated(doc) > txDay(tx)) continue;
      const payer = nameKey(tx.counterparty_name);
      const linked = (owner.has(payer) && owner.get(payer) === owner.get(client)) || owner.get(client) === payer || owner.get(payer) === client;
      if (!linked || payer === client) continue;
      const emails = ofType(ctx, "email").filter((e) => norm(e.markdown).includes(norm(tx.counterparty_name!)));
      add(tx, { code: "GROUP_COMPANY", docs: [doc.metadata.doc_id, ...emails.map((e) => e.metadata.doc_id)], related: [],
        fact: `${doc.metadata.doc_id} shows ${label(tx.counterparty_name)} and ${label(ctx.name)} are wholly owned within the same group, explaining ${describe(tx)}` });
    }
  }
}

function invoiceFinance(ctx: Context, add: Add): void {
  for (const doc of ofType(ctx, "remittance_advice")) {
    const financier = fromTitle(doc, /^Remittance advice from (.+)$/i);
    const advance = pounds(/\*\*Advance[^*]*:\*\*\s*(£[\d,.]+)/i.exec(doc.markdown)?.[1]);
    if (!financier || !sameName(field(doc.markdown, "Client"), ctx.name)) continue;
    const agreements = ofType(ctx, "factoring_agreement").filter((a) => norm(a.markdown).includes(norm(financier)) && norm(a.markdown).includes(norm(ctx.name)));
    for (const tx of incoming(ctx)) {
      if (sameName(tx.counterparty_name, financier) && samePence(tx, advance) && recentBefore(doc, tx, 3)) {
        add(tx, { code: "THIRD_PARTY_DOCUMENTED", docs: [doc.metadata.doc_id, ...agreements.map((a) => a.metadata.doc_id)], related: [],
          fact: `${doc.metadata.doc_id} from ${financier} shows an invoice-finance advance to ${label(ctx.name)} equal to ${describe(tx)}` });
      }
    }
  }
}

/** A payee the customer already paid at least twice, on the same account, before the review window. */
function establishedPayees(ctx: Context, add: Add): void {
  const { from } = ctx.pack.caseRecord.review_window;
  for (const tx of outgoing(ctx)) {
    if (!tx.counterparty_name || !tx.counterparty_account || sameName(tx.counterparty_name, ctx.name)
      || HIGHER_RISK_COUNTRIES.has(norm(String(tx.counterparty_country ?? "")))) continue;
    const earlier = ctx.history.filter((h) => h.direction === "out" && txDay(h) < from && sameName(h.counterparty_name, tx.counterparty_name)
      && sameAccount(h.counterparty_account, tx.counterparty_account));
    if (earlier.length >= 2) {
      add(tx, { code: "WITHIN_PROFILE", docs: [], related: [],
        fact: `${describe(tx)} is to an established payee paid ${earlier.length} times before the review window` });
    }
  }
}

/** Payments/FX: own-name funding is the product's normal use; a large dedicated funding must be explained by its onward payment. */
function clientFunding(ctx: Context, add: Add, explained: ReadonlyMap<string, Explanation>, gaps: Map<string, BankTransaction>): void {
  if (ctx.pack.caseRecord.institution !== "payments_fx") return;
  for (const tx of incoming(ctx)) {
    if (!sameName(tx.counterparty_name, ctx.name) || explained.has(tx.transaction_id)) continue;
    if (!tx.counterparty_account) {
      add(tx, { code: "WITHIN_PROFILE", docs: [], related: [], ownFunds: true, fact: `${describe(tx)} is routine funding from ${label(ctx.name)}'s own bank` });
      continue;
    }
    const onward = ctx.history.find((out) => out.direction === "out" && out.booked_at > tx.booked_at && daysBetween(txDay(tx), txDay(out)) <= 3
      && out.amount_gbp <= tx.amount_gbp && out.amount_gbp >= 0.9 * tx.amount_gbp);
    const reason = onward && explained.get(onward.transaction_id);
    if (onward && reason && reason.code !== "WITHIN_PROFILE") {
      add(tx, { code: reason.code, docs: reason.docs, related: [onward.transaction_id, ...reason.related],
        fact: `${describe(tx)} funded the onward payment of ${describe(onward)}; ${reason.fact}` });
    } else if (onward) {
      gaps.set(tx.transaction_id, onward);
    }
  }
}

/** Build every transaction explanation for a case. The first matching explanation for a transaction wins. */
export function explainTransactions(pack: InstitutionCasePack): ExplanationIndex {
  const ctx = context(pack);
  const byTx = new Map<string, Explanation>();
  const add: Add = (tx, explanation) => { if (!byTx.has(tx.transaction_id)) byTx.set(tx.transaction_id, explanation); };
  ownAccount(ctx, add);
  const invoicePayeeConflicts = invoices(ctx, add);
  for (const explain of [credits, cancellations, settlementLetters, solicitorLetters, completionStatements,
    giftLetters, saleReceipts, takingsBooks, collectionReports, cashReconciliations, bookingConfirmations, tenancyDeposits,
    vehicleFinance, hospitalInvoices, redundancy, cashRedeposits, contractSchedules, contractorFiles,
    freightInvoices, groupCompanies, invoiceFinance, payroll, heldPaymentReceipt, establishedPayees]) {
    explain(ctx, add);
  }
  const unexplainedOnward = new Map<string, BankTransaction>();
  clientFunding(ctx, add, byTx, unexplainedOnward);
  return { byTx, invoicePayeeConflicts, unexplainedOnward };
}
