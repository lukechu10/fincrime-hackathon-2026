import type { BankCasePack, BankTransaction } from "./bank-cases.js";
import type { EvidenceDocument } from "./evidence.js";
import type { EvidenceFact } from "./evidence-extraction.js";

export interface InvoiceMatch {
  readonly documentId: string;
  readonly transactionId: string;
}

export interface BankRouting {
  readonly route: "llm_review" | "continue_policy";
  readonly reasons: readonly ("FRAUD_REPORT_REQUIRES_REVIEW" | "NO_COMPLETE_INVOICE_COVERAGE" | "INVOICE_COVERAGE_CANDIDATE")[];
  readonly invoiceMatches: readonly InvoiceMatch[];
  readonly fraudReportIds: readonly string[];
  readonly alertsWithoutInvoiceCoverage: readonly string[];
  readonly unparsedDocumentIds: readonly string[];
}

const normalizedName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

function ukAccount(value: string): string | undefined {
  const withoutLabel = value.replace(/^account\s+/i, "");
  if (!/^[\d -]+$/.test(withoutLabel)) return;
  const digits = withoutLabel.replace(/[ -]/g, "");
  if (digits.length === 14) return digits;
}

function pence(amount: number): number | undefined {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  if (!match) return;
  const out = Number(match[1] + (match[2] ?? "").padEnd(2, "0"));
  if (Number.isSafeInteger(out)) return out;
}

function values(facts: readonly EvidenceFact[], field: EvidenceFact["field"]) {
  return facts.filter((fact) => fact.field === field).map((fact) => fact.value);
}

function oneText(facts: readonly EvidenceFact[], field: EvidenceFact["field"]): string | undefined {
  const found = values(facts, field);
  if (found.length === 1 && typeof found[0] === "string") return found[0];
}

/** Conservative match of a single invoice to one flagged outgoing payment, not proof an alert is benign. */
function matchesInvoice(pack: BankCasePack, document: EvidenceDocument, tx: BankTransaction): boolean {
  // Start with ordinary, single-payment invoices. Multi-row and other invoice layouts go to review.
  if (document.metadata.type !== "invoice" || document.extraction.kind !== "invoice"
    || document.extraction.entries.length || tx.direction !== "out" || !tx.counterparty_name) return false;
  const { facts } = document.extraction;
  const billTo = oneText(facts, "billedTo");
  const payee = oneText(facts, "payee");
  const dated = oneText(facts, "documentDate");
  const amounts = values(facts, "amountDue");
  const amount = amounts.length === 1 && typeof amounts[0] !== "string" ? amounts[0].minorUnits : undefined;
  const { from, to } = pack.caseRecord.review_window;
  const booked = tx.booked_at.slice(0, 10);
  // This is a narrow routing guard, not an SOP deadline or a tolerance for invoice settlement.
  if (!dated || dated !== document.metadata.dated || dated < from || dated > booked || booked > to
    || !billTo || normalizedName(billTo) !== normalizedName(pack.customer.name)
    || !payee || normalizedName(payee) !== normalizedName(tx.counterparty_name)
    || amount === undefined || amount <= 0 || amount !== pence(tx.amount_gbp)) return false;
  const destinations = values(facts, "paymentDestination");
  if (!destinations.length) return true;
  if (destinations.length !== 1 || typeof destinations[0] !== "string" || !tx.counterparty_account) return false;
  const account = ukAccount(destinations[0]);
  return account !== undefined && account === ukAccount(tx.counterparty_account);
}

export function routeBankCase(pack: BankCasePack): BankRouting {
  const fraudReportIds: string[] = [];
  const candidates: InvoiceMatch[] = [];
  for (const doc of pack.documents) {
    if (doc.metadata.type === "sending_bank_fraud_report") {
      // The document date is not the incident date. Don't exclude a same-customer report on date alone.
      fraudReportIds.push(doc.metadata.doc_id);
    }
    if (doc.metadata.type !== "invoice") continue;
    for (const tx of pack.flaggedTransactions) {
      if (matchesInvoice(pack, doc, tx)) candidates.push({ documentId: doc.metadata.doc_id, transactionId: tx.transaction_id });
    }
  }
  const documentCounts = new Map<string, number>();
  const transactionCounts = new Map<string, number>();
  for (const { documentId, transactionId } of candidates) {
    documentCounts.set(documentId, (documentCounts.get(documentId) ?? 0) + 1);
    transactionCounts.set(transactionId, (transactionCounts.get(transactionId) ?? 0) + 1);
  }
  const invoiceMatches = candidates.filter(({ documentId, transactionId }) =>
    documentCounts.get(documentId) === 1 && transactionCounts.get(transactionId) === 1);
  const matched = new Set(invoiceMatches.map((match) => match.transactionId));
  const alertsWithoutInvoiceCoverage = pack.alerts.filter((alert) => !alert.transaction_ids.length
    || alert.transaction_ids.some((id) => !matched.has(id))).map((alert) => alert.alert_id);
  const hasCoverage = pack.alerts.length > 0 && alertsWithoutInvoiceCoverage.length === 0;
  const reasons: BankRouting["reasons"][number][] = [];
  if (fraudReportIds.length) reasons.push("FRAUD_REPORT_REQUIRES_REVIEW");
  reasons.push(hasCoverage ? "INVOICE_COVERAGE_CANDIDATE" : "NO_COMPLETE_INVOICE_COVERAGE");
  return {
    route: fraudReportIds.length || !hasCoverage ? "llm_review" : "continue_policy",
    reasons, invoiceMatches, fraudReportIds, alertsWithoutInvoiceCoverage,
    unparsedDocumentIds: pack.documents.filter((doc) => doc.extraction.kind === "unparsed").map((doc) => doc.metadata.doc_id),
  };
}
