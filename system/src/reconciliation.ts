import type { BankTransaction, InstitutionCasePack } from "./bank-cases.js";
import type { EvidenceDocument } from "./evidence.js";
import type { EvidenceFact } from "./evidence-extraction.js";

export const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export function minor(amount: number): number | undefined {
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  const minor = parts && Number(parts[1] + (parts[2] ?? "").padEnd(2, "0"));
  return typeof minor === "number" && Number.isSafeInteger(minor) ? minor : undefined;
}
const compactAccount = (s: string) => s.replace(/^account\s+/i, "").replace(/[ -]/g, "").toUpperCase();
const fullAccount = (s: string) => /^(?:\d{14}|[A-Z]{2}\d{2}[A-Z\d]{11,30})$/.test(s);
const shortAccount = (s: string) => /^(?:(?:account|iban)\s+)?ending\s+(\d{4})$/i.exec(s.trim())?.[1];

function oneText(facts: readonly EvidenceFact[], keys: readonly EvidenceFact["field"][]): string | undefined {
  const values = facts.filter((f) => keys.includes(f.field) && typeof f.value === "string").map((f) => f.value as string);
  if (values.length === 1) return values[0];
}

function agreesWithDate(pack: InstitutionCasePack, doc: EvidenceDocument, tx: BankTransaction): boolean {
  const dated = oneText(doc.extraction.facts, ["documentDate"]);
  const { from, to } = pack.caseRecord.review_window;
  const day = tx.booked_at.slice(0, 10);
  // Conservative reconciliation window, not a policy rule or proof of payment terms.
  return !!dated && dated === doc.metadata.dated && from <= dated && dated <= day && day <= to;
}

function invoiceMatches(pack: InstitutionCasePack, doc: EvidenceDocument, tx: BankTransaction): boolean {
  if (doc.extraction.kind !== "invoice" || doc.extraction.entries.length || tx.direction !== "out"
    || !tx.counterparty_name || !agreesWithDate(pack, doc, tx)) return false;
  const facts = doc.extraction.facts;
  const payer = oneText(facts, ["billedTo", "buyer"]);
  const payee = oneText(facts, ["payee"]);
  const supplier = oneText(facts, ["supplier", "carrier"]);
  const name = normalize(tx.counterparty_name);
  const country = typeof tx.counterparty_country === "string" ? normalize(tx.counterparty_country) : "";
  const samePayee = (value: string) => normalize(value) === name || (!!country && normalize(value) === `${name}, ${country}`);
  if (!payer || normalize(payer) !== normalize(pack.customer.name) || (!payee && !supplier)
    || (payee && !samePayee(payee)) || (supplier && !samePayee(supplier))) return false;
  const values = facts.filter((fact) => ["amountDue", "amount", "total"].includes(fact.field));
  if (values.length !== 1 || typeof values[0].value === "string" || values[0].value.minorUnits <= 0
    || values[0].value.minorUnits !== minor(tx.amount_gbp)) return false;
  if (facts.some((fact) => fact.field === "terms" && typeof fact.value === "string" && /instal[l]?ment/i.test(fact.value))) return false;
  const destinations = facts.filter((fact) => fact.field === "paymentDestination");
  if (!destinations.length) return true;
  if (destinations.length !== 1 || typeof destinations[0].value !== "string" || !tx.counterparty_account) return false;
  const dest = compactAccount(destinations[0].value);
  const account = compactAccount(tx.counterparty_account);
  return fullAccount(dest) && dest === account;
}

export function matchedInvoices(pack: InstitutionCasePack, transactions: readonly BankTransaction[]): Map<string, string> {
  const matches: { tx: string; doc: string }[] = [];
  const documentCounts = new Map<string, number>();
  const transactionCounts = new Map<string, number>();
  for (const doc of pack.documents) {
    if (doc.extraction.kind !== "invoice") continue;
    for (const tx of transactions) {
      if (!invoiceMatches(pack, doc, tx)) continue;
      const id = doc.metadata.doc_id;
      matches.push({ tx: tx.transaction_id, doc: id });
      documentCounts.set(id, (documentCounts.get(id) ?? 0) + 1);
      transactionCounts.set(tx.transaction_id, (transactionCounts.get(tx.transaction_id) ?? 0) + 1);
    }
  }
  return new Map(matches.filter(({ doc, tx }) => documentCounts.get(doc) === 1 && transactionCounts.get(tx) === 1)
    .map(({ doc, tx }) => [tx, doc]));
}

/** Full account identifiers directly identify an account; a masking suffix also requires the exact movement. */
export function ownedAccount(pack: InstitutionCasePack, tx: BankTransaction): string | undefined {
  if (!tx.counterparty_account) return;
  for (const doc of pack.documents) {
    if (doc.extraction.kind !== "bankStatement") continue;
    const accountHolder = oneText(doc.extraction.facts, ["accountHolder"]);
    if (!accountHolder || normalize(accountHolder) !== normalize(pack.customer.name)) continue;
    if (tx.counterparty_name && normalize(tx.counterparty_name) !== normalize(pack.customer.name)) continue;
    const statementAccount = oneText(doc.extraction.facts, ["account"]);
    if (!statementAccount) continue;
    const account = compactAccount(statementAccount);
    if (fullAccount(account) && account === compactAccount(tx.counterparty_account)) return doc.metadata.doc_id;
    const suffix = shortAccount(statementAccount);
    if (!suffix || suffix !== shortAccount(tx.counterparty_account)) continue;
    const linked = doc.extraction.entries.some(({ kind, facts }) => kind === "statementMovement"
      && oneText(facts, ["movementDate"]) === tx.booked_at.slice(0, 10)
      && facts.some((f) => f.field === "amount" && typeof f.value !== "string" && f.value.minorUnits === minor(tx.amount_gbp)));
    if (linked) return doc.metadata.doc_id;
  }
}
