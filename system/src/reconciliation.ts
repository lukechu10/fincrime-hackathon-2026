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
