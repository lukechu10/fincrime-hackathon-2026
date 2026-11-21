/**
 * Facts a language model read from a document, and the deterministic checks that decide whether they count.
 *
 * The model is an untrusted reader. A fact is used only when every value it relies on is backed by a quote
 * that appears word for word in the document, and the value can be read from that quote. Matching facts to
 * transactions then uses the same literal rules as the parsers: exact pence, the same party, the reference,
 * and a date window. The model never decides whether something explains a payment or is suspicious enough
 * to escalate; it only reports what the document says.
 */
import type { BankTransaction, InstitutionCasePack } from "../bank-cases.js";
import type { EvidenceDocument } from "../evidence.js";
import { describe, type CloseCode, type Explanation } from "../explanations.js";
import type { Signal } from "../signals.js";
import { daysBetween, isoDay, nameKey, norm, poundsIn, sameName, samePence, txDay } from "../text.js";

export const PAYMENT_PURPOSES = ["gift", "inheritance", "legal_settlement", "insurance_payout", "refund", "loan", "asset_sale",
  "deposit_return", "investment_redemption", "supplier_payment", "salary", "other"] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

/** One payment a document records or commits to. */
export interface PaymentFact {
  readonly direction: "to_customer" | "from_customer";
  /** The other party: who pays the customer, or whom the customer pays. */
  readonly counterparty: string;
  readonly counterparty_quote: string;
  /** The amount actually paid, e.g. the net amount after an excess, as written ("£6,690.00"). */
  readonly amount: string;
  readonly amount_quote: string;
  readonly reference: string | null;
  readonly reference_quote: string | null;
  /** For a scheduled payment: the date it is due, as written. */
  readonly due_date: string | null;
  readonly due_date_quote: string | null;
  /** Who the document says receives the money, if it names them. */
  readonly recipient: string | null;
  readonly recipient_quote: string | null;
  readonly purpose: PaymentPurpose;
  readonly status: "confirmed" | "scheduled" | "conditional" | "denied" | "partial" | "unclear";
}

/** A company that owns all of another. */
export interface OwnershipFact {
  readonly parent: string;
  readonly subsidiary: string;
  readonly quote: string;
}

export interface PaymentDocumentFacts {
  readonly payments: readonly PaymentFact[];
  readonly ownership: readonly OwnershipFact[];
}

interface Statement { readonly present: boolean; readonly quote: string | null }
/** Statements of concern in a staff note, chat or email. */
export interface ConcernFacts {
  /** Someone says amounts are kept or split below a limit to escape the checks it triggers. */
  readonly structuring: Statement;
  /** Someone other than the customer uses or controls the account. */
  readonly account_used_by_others: Statement;
  /** The customer would not or could not explain the flagged payments when asked. */
  readonly refused_to_explain: Statement;
}

/** What the fallback adds to a case: extra transaction explanations and extra suspicion. */
export interface Findings {
  readonly explanations: readonly { readonly tx: BankTransaction; readonly explanation: Explanation }[];
  readonly signals: readonly Signal[];
}
export const NO_FINDINGS: Findings = { explanations: [], signals: [] };

/** Text compared loosely for quotes: case, whitespace, Markdown emphasis and typographic punctuation ignored. */
function quoteKey(text: string): string {
  return norm(text.replace(/\*\*/g, "").replace(/[“”]/g, "\"").replace(/[–—]/g, "-"));
}
/** The quote appears in the text word for word, apart from case, spacing and emphasis. */
export function quoted(text: string, quote: string | null | undefined): quote is string {
  const key = quote ? quoteKey(quote) : "";
  return key.length >= 3 && quoteKey(text).includes(key);
}
/** The value is quoted and the quote contains it. */
function backed(text: string, value: string | null | undefined, quote: string | null | undefined): value is string {
  return !!value && quoted(text, quote) && quoteKey(quote!).includes(quoteKey(value));
}
const short = (quote: string) => {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
};
const label = (s: string) => s.replace(/\s+/g, " ").trim();
const refHas = (tx: BankTransaction, ref: string) => typeof tx.reference === "string"
  && new RegExp(`(?:^|[^a-z0-9])${norm(ref).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(norm(tx.reference));
const isCash = (tx: BankTransaction) => typeof tx.channel === "string" && tx.channel.includes("cash");

/** A validated payment, with the amount in pence and the due day, if any, as an ISO date. */
interface CheckedPayment { readonly fact: PaymentFact; readonly pence: number; readonly due?: string; readonly reference?: string }

/** Keep only payments whose values are all backed by quotes and whose status is a firm commitment. */
export function checkPayments(doc: EvidenceDocument, facts: PaymentDocumentFacts): CheckedPayment[] {
  const md = doc.markdown;
  return facts.payments.flatMap((fact) => {
    if (fact.status !== "confirmed" && fact.status !== "scheduled") return [];
    if (!backed(md, fact.counterparty, fact.counterparty_quote) || !quoted(md, fact.amount_quote)) return [];
    const [pence] = poundsIn(fact.amount);
    if (pence === undefined || !poundsIn(fact.amount_quote).includes(pence)) return [];
    // An unbacked reference is ignored rather than trusted. It only ever narrows matching, so the remaining
    // backed values (party, exact amount, and a due date or the arrival window) must still match on their own.
    const reference = fact.reference && backed(md, fact.reference, fact.reference_quote) ? fact.reference : undefined;
    if (fact.recipient && !backed(md, fact.recipient, fact.recipient_quote)) return [];
    let due: string | undefined;
    if (fact.due_date) {
      if (!backed(md, fact.due_date, fact.due_date_quote)) return [];
      due = isoDay(fact.due_date);
      if (!due) return [];
    }
    return [{ fact, pence, due, reference }];
  });
}

const OWNS_ALL = /\b(?:100\s?%|entire|all (?:of )?the (?:issued )?shares|whole of the (?:issued )?share|wholly[- ]owned)/i;
/** Keep only ownership statements that name both companies and say the parent owns all of the subsidiary. */
export function checkOwnership(doc: EvidenceDocument, facts: PaymentDocumentFacts): OwnershipFact[] {
  return facts.ownership.filter((fact) => quoted(doc.markdown, fact.quote) && quoteKey(fact.quote).includes(quoteKey(fact.parent))
    && quoteKey(fact.quote).includes(quoteKey(fact.subsidiary)) && OWNS_ALL.test(fact.quote));
}

const CLOSE_FOR: Partial<Record<PaymentPurpose, CloseCode>> = {
  gift: "THIRD_PARTY_DOCUMENTED", inheritance: "DOCUMENTED_EVENT", legal_settlement: "DOCUMENTED_EVENT",
  insurance_payout: "DOCUMENTED_EVENT", loan: "DOCUMENTED_EVENT", asset_sale: "DOCUMENTED_EVENT", deposit_return: "DOCUMENTED_EVENT",
  investment_redemption: "DOCUMENTED_EVENT", refund: "REFUND_OF_EARLIER_PAYMENT", supplier_payment: "INVOICE_MATCHES",
};
/** Document types that can stand as an invoice or contract for a payment the customer makes. */
const PURPOSE_DOCUMENT = /invoice|contract|schedule|agreement|purchase_order/;
/** How long after a document a payment it announces may arrive. */
const ARRIVAL_DAYS = 60;

/** The payer named on the transaction is the counterparty, or the counterparty's own client or trust account. */
const paidBy = (tx: BankTransaction, party: string) => !!tx.counterparty_name
  && (sameName(tx.counterparty_name, party) || nameKey(tx.counterparty_name).startsWith(nameKey(party)));

function unique<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/**
 * Explanations for the case's transactions from one document's checked facts, using literal matching:
 * exact pence, the same party, the stated reference, the customer as recipient, and a date window.
 */
export function explainFromDocument(pack: InstitutionCasePack, doc: EvidenceDocument, facts: PaymentDocumentFacts):
  { tx: BankTransaction; explanation: Explanation }[] {
  const customer = pack.customer.name;
  const day = doc.metadata.dated;
  const history = [...pack.priorTransactions, ...pack.windowTransactions, ...(pack.heldPayment ? [pack.heldPayment] : [])];
  const subjects = [...new Map([...pack.windowTransactions, ...pack.flaggedTransactions, ...(pack.heldPayment ? [pack.heldPayment] : [])]
    .map((tx) => [tx.transaction_id, tx])).values()];
  const results: { tx: BankTransaction; explanation: Explanation }[] = [];
  const cite = (q: string) => `"${short(q)}"`;

  for (const { fact, pence, due, reference } of checkPayments(doc, facts)) {
    const code = CLOSE_FOR[fact.purpose];
    if (!code) continue;
    // A named recipient must be the customer; a gift always needs one.
    const toCustomer = fact.recipient ? sameName(fact.recipient, customer) || /^you(?:rself)?$/i.test(fact.recipient.trim()) : fact.purpose !== "gift";
    if (fact.direction === "to_customer") {
      if (!toCustomer || code === "INVOICE_MATCHES") continue;
      const tx = unique(subjects.filter((t) => t.direction === "in" && !isCash(t) && samePence(t, pence) && paidBy(t, fact.counterparty)
        && txDay(t) >= day && daysBetween(day, txDay(t)) <= ARRIVAL_DAYS && (!reference || refHas(t, reference))));
      if (!tx) continue;
      if (code === "REFUND_OF_EARLIER_PAYMENT") {
        const original = unique(history.filter((t) => t.direction === "out" && t.booked_at < tx.booked_at && samePence(t, pence)
          && sameName(t.counterparty_name, tx.counterparty_name) && (!reference || refHas(t, reference))));
        if (!original) continue;
        results.push({ tx, explanation: { code, docs: [doc.metadata.doc_id], related: [original.transaction_id],
          fact: `${doc.metadata.doc_id} confirms a refund from ${label(fact.counterparty)} (${cite(fact.amount_quote)}), linking ${describe(tx)} to the original payment of ${describe(original)}` } });
        continue;
      }
      results.push({ tx, explanation: { code, docs: [doc.metadata.doc_id], related: [],
        fact: `${doc.metadata.doc_id} from ${label(fact.counterparty)} records the ${fact.purpose.replace(/_/g, " ")} for ${label(customer)} (${cite(fact.amount_quote)}), matching ${describe(tx)}` } });
    } else {
      // A payment the customer makes is supported only by an invoice- or contract-type document naming the payee,
      // the exact amount, and either its due date or its reference.
      if (code !== "INVOICE_MATCHES" || !PURPOSE_DOCUMENT.test(doc.metadata.type) || (!due && !reference)) continue;
      const tx = unique(subjects.filter((t) => t.direction === "out" && samePence(t, pence) && sameName(t.counterparty_name, fact.counterparty)
        && day <= txDay(t) && (!due || txDay(t) === due) && (!reference || refHas(t, reference))));
      if (!tx) continue;
      results.push({ tx, explanation: { code, docs: [doc.metadata.doc_id], related: [],
        fact: `${doc.metadata.doc_id} sets a payment of ${cite(fact.amount_quote)} to ${label(fact.counterparty)}${due ? ` due on ${due}` : ""}${reference ? ` under ${reference}` : ""}, matching ${describe(tx)}` } });
    }
  }

  // Group funding: money from the customer's parent, or from a company with the same parent.
  const owned = checkOwnership(doc, facts);
  const parentOf = (company: string) => owned.find((o) => sameName(o.subsidiary, company))?.parent;
  for (const tx of subjects.filter((t) => t.direction === "in" && t.counterparty_name && day <= txDay(t))) {
    const payer = tx.counterparty_name!;
    if (sameName(payer, customer)) continue;
    const parent = parentOf(customer);
    const link = parent && sameName(parent, payer) ? owned.find((o) => sameName(o.parent, payer) && sameName(o.subsidiary, customer))
      : parent && parentOf(payer) && sameName(parentOf(payer), parent) ? owned.find((o) => sameName(o.subsidiary, payer)) : undefined;
    if (!link) continue;
    results.push({ tx, explanation: { code: "GROUP_COMPANY", docs: [doc.metadata.doc_id], related: [],
      fact: `${doc.metadata.doc_id} states ${cite(link.quote)}, so ${label(payer)} and ${label(customer)} are in the same wholly owned group, explaining ${describe(tx)}` } });
  }
  return results;
}

/** What the customer typed in a chat; staff notes and emails are read whole. */
function speakerText(doc: EvidenceDocument): string {
  if (doc.metadata.type !== "support_chat") return doc.markdown.replace(/^#.*$/m, "");
  return [...doc.markdown.matchAll(/^\*\*Customer:\*\*\s*(.+)$/gim)].map((m) => m[1]).join("\n");
}

/** Suspicion from one document's checked concern statements. Each quote must be in the customer's or staff's own words. */
export function signalsFromDocument(pack: InstitutionCasePack, doc: EvidenceDocument, facts: ConcernFacts): Signal[] {
  const text = speakerText(doc);
  const id = doc.metadata.doc_id;
  const name = label(pack.customer.name);
  const signals: Signal[] = [];
  const largest = (txs: readonly BankTransaction[]) => [...txs].sort((a, b) => b.amount_gbp - a.amount_gbp
    || a.transaction_id.localeCompare(b.transaction_id))[0];
  const ruleTxs = (...rules: string[]) => pack.alerts.filter((a) => rules.includes(a.rule_id)).flatMap((a) => a.transaction_ids);
  if (facts.structuring.present && quoted(text, facts.structuring.quote)) {
    signals.push({ code: "ESC_STRUCTURING", evidence: [id, ...ruleTxs("TM03", "TM05")],
      fact: `${id} records amounts being kept under a limit to avoid the related checks: "${short(facts.structuring.quote)}"` });
  }
  if (facts.account_used_by_others.present && quoted(text, facts.account_used_by_others.quote)) {
    const tx = largest(pack.flaggedTransactions.filter((t) => t.direction === "in" && !sameName(t.counterparty_name, pack.customer.name)));
    signals.push({ code: "ESC_ACCOUNT_MISUSE", evidence: [id, ...(tx ? [tx.transaction_id] : [])],
      fact: `${id} records someone other than ${name} using the account: "${short(facts.account_used_by_others.quote)}"${tx ? `; it received ${describe(tx)}` : ""}` });
  }
  // A refusal escalates as a corridor concern only when a higher-risk-country payment was flagged.
  const routed = ruleTxs("TM06");
  if (routed.length && facts.refused_to_explain.present && quoted(text, facts.refused_to_explain.quote)) {
    signals.push({ code: "ESC_HIGH_RISK_CORRIDOR", evidence: [id, ...routed],
      fact: `${id} records that ${name} would not explain the flagged higher-risk-country payments: "${short(facts.refused_to_explain.quote)}"` });
  }
  return signals;
}
