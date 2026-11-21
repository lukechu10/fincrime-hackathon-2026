import type { BankTransaction, InstitutionCasePack } from "./bank-cases.js";
import type { EvidenceDocument } from "./evidence.js";
import { parseGbp } from "./evidence-extraction.js";
import { minor, normalize } from "./reconciliation.js";

export interface DocumentedCredit {
  readonly kind: "insurance_payout" | "refund";
  readonly reference: string;
  readonly documentId: string;
  readonly payment: BankTransaction;
  readonly original?: BankTransaction;
}

interface CreditTerms {
  readonly kind: DocumentedCredit["kind"];
  readonly party: string;
  readonly amount: number;
  readonly reference: string;
}

function one<T>(items: readonly T[]): T | undefined { return items.length === 1 ? items[0] : undefined; }
function field(markdown: string, label: string): string | undefined {
  return one([...markdown.matchAll(new RegExp(`^\\*\\*${label}:\\*\\*[ \\t]*(.+)$`, "gim"))].map((match) => match[1].trim()));
}
function refMatches(text: string, kind: "booking" | "claim"): string | undefined {
  // Require a digit while matching, so e.g. "booking BOOKING 12345" does not consume the real prefix.
  const matches = [...text.matchAll(new RegExp(`\\b${kind}[ \\t]+(?=[A-Z0-9-]*\\d)[A-Z0-9]+(?:-[A-Z0-9]+)*\\b`, "gi"))];
  return one([...new Set(matches.map((m) => normalize(m[0])))]);
}
function oneAmount(text: string): number | undefined {
  const amounts = [...text.matchAll(/£[ \t]*[\d,]+(?:\.\d+)?/g)];
  const amount = one(amounts);
  return amount && parseGbp(amount[0])?.minorUnits;
}

function terms(doc: EvidenceDocument, customerName: string): CreditTerms | undefined {
  const { markdown } = doc;
  // These parsers deliberately identify limited document forms, not mentions in chats or free text.
  if (doc.metadata.type === "insurer_letter") {
    const issuer = /^# Claim settlement letter from (.+)$/im.exec(markdown)?.[1]?.trim();
    const salutation = /^Dear[ \t]+(.+?),[ \t]*$/im.exec(markdown)?.[1];
    const beneficiary = /\bto[ \t]+([^\n.,]+?)[ \t]+(?:via|by)[ \t]+bank transfer\b/i.exec(markdown)?.[1];
    const addressed = salutation && normalize(salutation) === normalize(customerName);
    const namedBeneficiary = beneficiary && normalize(beneficiary) === normalize(customerName);
    const reference = refMatches(markdown, "claim");
    const amount = oneAmount(markdown);
    const accepted = /\b(?:accepted your claim|your claim[^.\n]{0,100}has been accepted)\b/i.test(markdown);
    const disputed = /\b(?:not (?:yet )?accepted|declined|rejected|not approved|subject to approval|pending|provisional|partial|cannot confirm|can['’]t confirm|unable to confirm|will not pay|under review)\b/i.test(markdown);
    if (issuer && reference && amount && accepted && !disputed && (addressed || namedBeneficiary)
      && (!beneficiary || /^(?:you|your account)$/i.test(beneficiary) || namedBeneficiary)) {
      return { kind: "insurance_payout", party: issuer, amount, reference };
    }
  }
  if (doc.metadata.type === "venue_email") {
    const issuer = /^# Email from (.+)$/im.exec(markdown)?.[1]?.trim();
    const reference = refMatches(markdown, "booking");
    const amount = oneAmount(markdown);
    if (issuer && reference && amount && /\bcancell?ation\b|\bcancell?ed\b/i.test(markdown) && /\brefund\b/i.test(markdown)
      && !/\b(?:no refund|not refunded|non.refundable|not refunding|unable to refund|partial refund|refund (?:is )?(?:declined|denied|not due|not issued)|will not (?:be )?refund|forfeited|retained)\b/i.test(markdown)) {
      return { kind: "refund", party: issuer, amount, reference };
    }
  }
  if (doc.metadata.type === "credit_note") {
    const issuer = /^# Credit note from (.+)$/im.exec(markdown)?.[1]?.trim();
    const supplier = field(markdown, "Supplier");
    const customer = field(markdown, "Customer");
    const cause = field(markdown, "Credit for");
    const refund = field(markdown, "Refund");
    const reference = cause && refMatches(cause, "booking");
    const amount = refund && parseGbp(refund)?.minorUnits;
    if (issuer && supplier && (normalize(supplier) === normalize(issuer) || normalize(supplier).startsWith(`${normalize(issuer)}, `))
      && customer && normalize(customer) === normalize(customerName)
      && cause && /\bcancell?ed\b/i.test(cause) && !/\b(?:not|never)\s+cancell?ed\b/i.test(cause) && reference && amount) {
      return { kind: "refund", party: issuer, amount, reference };
    }
  }
}

function mentions(text: string, identifier: string): boolean {
  const literal = normalize(identifier).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9-])${literal}(?![a-z0-9-])`).test(normalize(text));
}

function validDate(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

const txReference = (tx: BankTransaction) => typeof tx.reference === "string" ? normalize(tx.reference) : "";
const namesParty = (tx: BankTransaction, party: string) => !!tx.counterparty_name && normalize(tx.counterparty_name) === normalize(party);

function originalPayment(credit: CreditTerms, payment: BankTransaction, dated: string, history: readonly BankTransaction[]) {
  return one(history.filter((tx) => tx.direction === "out" && tx.customer_id === payment.customer_id
    && Date.parse(tx.booked_at) < Date.parse(payment.booked_at) && tx.booked_at.slice(0, 10) <= dated
    && txReference(tx) === credit.reference && minor(tx.amount_gbp) === credit.amount && namesParty(tx, credit.party)
    && tx.counterparty_country === payment.counterparty_country));
}

/** Match a documented credit to a unique booking/claim and payment, not simply a matching amount. */
export function documentedCredits(pack: InstitutionCasePack): Map<string, DocumentedCredit> {
  const candidates = pack.documents.flatMap((doc) => {
    const credit = doc.metadata.customer_id === pack.customer.customer_id ? terms(doc, pack.customer.name) : undefined;
    return credit ? [{ doc, credit }] : [];
  });
  const byDocument = new Map(candidates.map(({ doc, credit }) => [doc, credit]));
  const history = [...pack.priorTransactions, ...pack.windowTransactions].filter((tx) => tx.transaction_id !== pack.heldPayment?.transaction_id);
  const matches: DocumentedCredit[] = [];
  for (const { doc, credit } of candidates) {
    if (!validDate(doc.metadata.dated)) continue;
    // Inspect all related documents, including denials and partial settlements that did not parse as positive terms.
    const unresolved = pack.documents.some((other) => {
      if (other === doc || other.metadata.customer_id !== pack.customer.customer_id) return false;
      if (mentions(other.markdown, doc.metadata.doc_id)
        && /\b(?:forged|altered|fabricat\w*|unverified|could not verify|suspicious)\b/i.test(other.markdown)) return true;
      if (!mentions(other.markdown, credit.reference)) return false;
      const terms = byDocument.get(other);
      return !terms || terms.kind !== credit.kind || terms.reference !== credit.reference
        || terms.amount !== credit.amount || normalize(terms.party) !== normalize(credit.party);
    });
    if (unresolved) continue;
    const reference = credit.kind === "refund" ? `refund ${credit.reference}` : credit.reference;
    const payment = one(history.filter((tx) => tx.direction === "in" && tx.customer_id === pack.customer.customer_id
      && txReference(tx) === reference && minor(tx.amount_gbp) === credit.amount && namesParty(tx, credit.party)));
    if (!payment) continue;
    const day = payment.booked_at.slice(0, 10);
    const { from, to } = pack.caseRecord.review_window;
    if (day < from || day > to || doc.metadata.dated > day) continue;
    const original = credit.kind === "refund" ? originalPayment(credit, payment, doc.metadata.dated, history) : undefined;
    if (credit.kind === "refund" && !original) continue;
    matches.push({ kind: credit.kind, reference: credit.reference.toUpperCase(), documentId: doc.metadata.doc_id, payment, original });
  }
  const counts = new Map<string, number>();
  for (const { payment } of matches) counts.set(payment.transaction_id, (counts.get(payment.transaction_id) ?? 0) + 1);
  return new Map(matches.filter(({ payment }) => counts.get(payment.transaction_id) === 1).map((match) => [match.payment.transaction_id, match]));
}
