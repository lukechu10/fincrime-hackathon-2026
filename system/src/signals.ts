import type { BankTransaction, InstitutionCasePack } from "./bank-cases.js";
import type { EvidenceDocument } from "./evidence.js";
import { describe, type ExplanationIndex } from "./explanations.js";
import {
  field, HIGHER_RISK_COUNTRIES, isoDay, looksLikeOrganization, nameKey, norm, pounds, sameName, samePence, tableRows, title, txDay,
} from "./text.js";

export type SignalCode = "ESC_STRUCTURING" | "ESC_HIGH_RISK_CORRIDOR" | "ESC_ACCOUNT_MISUSE" | "ESC_UNEXPLAINED_FUNDS"
  | "ESC_PASS_THROUGH" | "ESC_INVOICE_MISMATCH" | "ESC_MULE_ACTIVITY";

/** Affirmative evidence of suspicion found in the case file. Each one alone warrants escalation. */
export interface Signal {
  readonly code: SignalCode;
  readonly fact: string;
  readonly evidence: readonly string[];
}

const label = (s: string) => s.replace(/\s+/g, " ").trim();
const largest = (txs: readonly BankTransaction[]) => [...txs].sort((a, b) => b.amount_gbp - a.amount_gbp)[0];

function customerDocs(pack: InstitutionCasePack, ...types: string[]): EvidenceDocument[] {
  return pack.documents.filter((doc) => doc.metadata.customer_id === pack.customer.customer_id && types.includes(doc.metadata.type));
}

function companyOf(doc: EvidenceDocument): string | undefined {
  return field(doc.markdown, "Company") ?? /^Company register extract for (.+?)(?::.*)?$/i.exec(title(doc.markdown))?.[1];
}

/** People recorded as officers or significant controllers in a register, whatever the table layout. */
function controllers(doc: EvidenceDocument): string[] {
  return [
    ...tableRows(doc.markdown, ["officer", "role"]).map((row) => row.officer),
    ...tableRows(doc.markdown, ["person with significant control"]).map((row) => row["person with significant control"]),
    ...tableRows(doc.markdown, ["person", "control"]).map((row) => row.person),
  ].filter(Boolean);
}

const STRUCTURING_LIMIT = /\b(?:below|under|less than)\s+(?:the\s+)?(?:£\s?[\d,]+|a grand|\d+\s?k\b)|\b(?:below|under)\b[^.\n]{0,130}\b(?:threshold|limit)\b/i;
const STRUCTURING_PURPOSE = /\b(?:exempt\w*|avoid\w*|evad\w*|bypass\w*|circumvent\w*|identity|identification|verification|ID checks?|reporting|invoice requirement|source of (?:the )?(?:cash|funds|money)|where (?:it|the cash|the money) came from)\b/i;
/** Keeping amounts under a limit for the purpose of escaping the checks it triggers. "ID" is matched case-sensitively. */
const admitsStructuring = (text: string) => STRUCTURING_LIMIT.test(text) && (STRUCTURING_PURPOSE.test(text) || /\bID\b/.test(text));
/** What the customer themselves wrote in a chat, without the agent's replies. */
const customerTurns = (markdown: string) => [...markdown.matchAll(/^\*\*Customer:\*\*\s*(.+)$/gim)].map((m) => m[1]).join("\n");
/** A customer saying other people use their account ("investing through mine"). */
const ACCOUNT_USED_BY_OTHERS = /^\*\*Customer:\*\*.*\b(?:through|via|using) (?:mine|my account)\b/im;
const REFUSAL = /\b(?:unable|unwilling|declin\w*|evasive|refus\w*|would not|did not (?:explain|provide|clarify))\b|\bno clear\b/i;

export function findSignals(pack: InstitutionCasePack, explained: ExplanationIndex): Signal[] {
  const signals: Signal[] = [];
  const { from } = pack.caseRecord.review_window;
  const flagged = pack.flaggedTransactions;
  const subjects = [...new Map([...pack.windowTransactions, ...flagged, ...(pack.heldPayment ? [pack.heldPayment] : [])]
    .map((tx) => [tx.transaction_id, tx])).values()];
  const currentNotes = customerDocs(pack, "staff_note").filter((doc) => (isoDay(doc.metadata.dated) ?? "") >= from);
  const casePaymentIds = new Set([...flagged, ...(pack.heldPayment ? [pack.heldPayment] : [])].map((tx) => tx.transaction_id));
  for (const { doc, tx, detail } of explained.invoicePayeeConflicts) {
    if (!casePaymentIds.has(tx.transaction_id)) continue;
    signals.push({ code: "ESC_INVOICE_MISMATCH", evidence: [doc.metadata.doc_id, tx.transaction_id],
      fact: `${doc.metadata.doc_id} ${detail}, contradicting ${describe(tx)}` });
  }

  for (const note of currentNotes) {
    const text = note.markdown.replace(/^#.*$/m, "");
    if (admitsStructuring(text)) {
      const split = pack.alerts.filter((alert) => alert.rule_id === "TM03" || alert.rule_id === "TM05").flatMap((alert) => alert.transaction_ids);
      signals.push({ code: "ESC_STRUCTURING", evidence: [note.metadata.doc_id, ...split],
        fact: `Staff note ${note.metadata.doc_id} records ${label(pack.customer.name)} asking how to keep payments below a threshold to avoid the related checks` });
    }
    const countries = pack.alerts.flatMap((alert) => alert.rule_id === "TM06" ? String((alert.measured as Record<string, unknown> | undefined)?.countries ?? "").split(/,\s*/) : [])
      .filter(Boolean);
    const named = [...countries, ...HIGHER_RISK_COUNTRIES].some((country) => norm(text).includes(norm(country)));
    if (countries.length && REFUSAL.test(text) && named) {
      const routed = pack.alerts.filter((alert) => alert.rule_id === "TM06").flatMap((alert) => alert.transaction_ids);
      signals.push({ code: "ESC_HIGH_RISK_CORRIDOR", evidence: [note.metadata.doc_id, ...routed],
        fact: `Staff note ${note.metadata.doc_id} records that the customer could not or would not explain the routing of the flagged payments through ${countries.join(", ")}` });
    }
  }

  for (const chat of customerDocs(pack, "support_chat").filter((doc) => (isoDay(doc.metadata.dated) ?? "") >= from)) {
    // The same admission counts whether a member of staff wrote it down or the customer typed it in a chat.
    if (admitsStructuring(customerTurns(chat.markdown))) {
      const split = pack.alerts.filter((alert) => alert.rule_id === "TM03" || alert.rule_id === "TM05").flatMap((alert) => alert.transaction_ids);
      signals.push({ code: "ESC_STRUCTURING", evidence: [chat.metadata.doc_id, ...split],
        fact: `In chat ${chat.metadata.doc_id} ${label(pack.customer.name)} says they keep each payment under a limit so that the related checks are not triggered` });
    }
    const line = ACCOUNT_USED_BY_OTHERS.exec(chat.markdown)?.[0];
    if (!line) continue;
    const tx = largest(flagged.filter((t) => t.direction === "in" && !sameName(t.counterparty_name, pack.customer.name)));
    signals.push({ code: "ESC_ACCOUNT_MISUSE", evidence: [chat.metadata.doc_id, ...(tx ? [tx.transaction_id] : [])],
      fact: `In chat ${chat.metadata.doc_id} ${label(pack.customer.name)} says other people are using the account (${label(line.replace(/^\*\*Customer:\*\*\s*/, ""))})${tx ? `, which received ${describe(tx)}` : ""}` });
  }

  for (const doc of customerDocs(pack, "device_export")) {
    for (const row of tableRows(doc.markdown, ["customers who logged in from it"])) {
      const users = row["customers who logged in from it"].split(/\s*,\s*/).filter(Boolean);
      if (users.includes(pack.customer.customer_id) && users.length >= 2) {
        const tx = largest(flagged);
        signals.push({ code: "ESC_ACCOUNT_MISUSE", evidence: [doc.metadata.doc_id, ...(tx ? [tx.transaction_id] : [])],
          fact: `Device export ${doc.metadata.doc_id} shows device ${row.device ?? ""} used to log in to ${users.length} different customers' accounts, including ${label(pack.customer.name)}'s, from ${row["login countries"] ?? "several countries"}` });
      }
    }
  }

  const registers = pack.documents.filter((doc) => doc.metadata.type === "company_register_extract" || doc.metadata.type === "significant_control_register");
  for (const tx of flagged.filter((t) => t.direction === "in" && t.counterparty_name)) {
    const register = registers.find((doc) => sameName(companyOf(doc), tx.counterparty_name));
    const dissolved = register && isoDay(/^Dissolved on (.+)$/i.exec(field(register.markdown, "Status") ?? "")?.[1]);
    if (!register || !dissolved || dissolved > txDay(tx)) continue;
    const onward = flagged.filter((t) => t.direction === "out" && !explained.byTx.has(t.transaction_id) && t.amount_gbp >= 500
      && !sameName(t.counterparty_name, pack.customer.name));
    const individuals = new Set(onward.filter((t) => !looksLikeOrganization(t.counterparty_name)).map((t) => nameKey(t.counterparty_name ?? "")));
    const out = largest(onward);
    signals.push({ code: individuals.size >= 2 ? "ESC_PASS_THROUGH" : "ESC_UNEXPLAINED_FUNDS",
      evidence: [register.metadata.doc_id, tx.transaction_id, ...(out ? [out.transaction_id] : [])],
      fact: `Register ${register.metadata.doc_id} shows the payer ${label(tx.counterparty_name!)} was dissolved on ${dissolved}, before it apparently paid ${describe(tx)}${out ? `, and the money was moved on, including ${describe(out)}` : ""}` });
    break;
  }

  const own = registers.filter((doc) => sameName(companyOf(doc), pack.customer.name)).flatMap(controllers).map(nameKey);
  if (own.length) {
    for (const tx of subjects.filter((t) => t.direction === "out" && t.counterparty_name && !explained.byTx.has(t.transaction_id))) {
      const register = registers.find((doc) => sameName(companyOf(doc), tx.counterparty_name) && controllers(doc).some((p) => own.includes(nameKey(p))));
      if (!register) continue;
      const person = controllers(register).find((p) => own.includes(nameKey(p)))!;
      signals.push({ code: "ESC_PASS_THROUGH", evidence: [register.metadata.doc_id, tx.transaction_id],
        fact: `Register ${register.metadata.doc_id} shows ${person}, who controls ${label(pack.customer.name)}, also controls the payee of ${describe(tx)}` });
      break;
    }
  }

  for (const doc of customerDocs(pack, "supplier_invoices", "supplier_invoice", "invoice", "freight_invoices")) {
    const rows = tableRows(doc.markdown, ["invoice", "amount"]);
    const mismatched = subjects.filter((tx) => tx.direction === "out" && !explained.byTx.has(tx.transaction_id)).flatMap((tx) => {
      const row = rows.find((r) => typeof tx.reference === "string" && norm(tx.reference) === norm(r.invoice));
      const dated = row && isoDay(row.dated);
      return row && (!samePence(tx, pounds(row.amount)) || (!!dated && dated > txDay(tx))) ? [{ tx, row }] : [];
    });
    if (mismatched.length) {
      const [{ tx, row }] = mismatched;
      signals.push({ code: "ESC_INVOICE_MISMATCH", evidence: [doc.metadata.doc_id, ...mismatched.map((m) => m.tx.transaction_id)],
        fact: `${doc.metadata.doc_id} does not support ${describe(tx)}: invoice ${row.invoice} is for ${row.amount}${row.dated ? ` dated ${row.dated}` : ""}` });
    }
  }

  for (const doc of customerDocs(pack, "payment_file")) {
    const rows = tableRows(doc.markdown, ["payee", "address", "amount"]);
    const addresses = new Set(rows.map((row) => norm(row.address)));
    if (rows.length >= 10 && addresses.size * 3 <= rows.length) {
      const pool = largest(flagged.filter((t) => t.direction === "in" && !sameName(t.counterparty_name, pack.customer.name)));
      signals.push({ code: "ESC_MULE_ACTIVITY", evidence: [doc.metadata.doc_id, ...(pool ? [pool.transaction_id] : [])],
        fact: `Payment file ${doc.metadata.doc_id} pays ${rows.length} overseas payees who share only ${addresses.size} UK addresses${pool ? `, funded by ${describe(pool)}` : ""}` });
    }
  }
  return signals;
}
