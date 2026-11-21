import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { loadEvidenceIndex, type EvidenceDocument } from "./evidence.js";

type Row = Readonly<Record<string, unknown>>;
export type Institution = "bank" | "emoney" | "investment" | "payments_fx";
export const institutions: readonly Institution[] = ["bank", "emoney", "investment", "payments_fx"];
export type BankCase = Row & {
  institution: Institution; case_id: string; customer_id: string; alert_ids: string[];
  review_window: { from: string; to: string }; held_payment_id?: string | null;
};
export type BankAlert = Row & { alert_id: string; case_id: string; customer_id: string; rule_id: string; transaction_ids: string[] };
export type BankTransaction = Row & {
  transaction_id: string; customer_id: string; booked_at: string; direction: "in" | "out";
  amount_gbp: number; counterparty_name: string | null; counterparty_account: string | null;
};
export type BankCustomer = Row & { customer_id: string; name: string };
export type ListEntry = Row & { entry_id: string; name: string };
export type PreviousReview = Row & { review_id: string; customer_id: string; note: string };

export interface BankCasePack {
  readonly caseRecord: BankCase;
  readonly customer: BankCustomer;
  readonly alerts: readonly BankAlert[];
  readonly flaggedTransactions: readonly BankTransaction[];
  readonly documents: readonly EvidenceDocument[];
}

export interface InstitutionCasePack extends BankCasePack {
  readonly windowTransactions: readonly BankTransaction[];
  readonly internalList: readonly ListEntry[];
  readonly previousReviews: readonly PreviousReview[];
  readonly heldPayment?: BankTransaction;
}

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const nullableText = (value: unknown) => value === null || text(value);

function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function bankCase(row: Row): row is BankCase {
  const w = row.review_window;
  return text(row.case_id) && text(row.customer_id) && institutions.some((value) => value === row.institution)
    && ids(row.alert_ids) && (row.held_payment_id === undefined || nullableText(row.held_payment_id))
    && isRow(w) && isDay(w.from) && isDay(w.to) && w.from <= w.to;
}
function bankAlert(row: Row): row is BankAlert {
  return text(row.alert_id) && text(row.case_id) && text(row.customer_id) && text(row.rule_id) && ids(row.transaction_ids);
}
function bankTransaction(row: Row): row is BankTransaction {
  return text(row.transaction_id) && text(row.customer_id) && text(row.booked_at)
    && isDay(row.booked_at.slice(0, 10)) && Number.isFinite(Date.parse(row.booked_at))
    && (row.direction === "in" || row.direction === "out")
    && typeof row.amount_gbp === "number" && Number.isFinite(row.amount_gbp) && row.amount_gbp >= 0
    && nullableText(row.counterparty_name) && nullableText(row.counterparty_account);
}
function bankCustomer(row: Row): row is BankCustomer {
  return text(row.customer_id) && text(row.name);
}

function indexRows<T extends Row, K extends keyof T>(
  path: string, valid: (row: Row) => row is T, idKey: K,
): Map<T[K], T> {
  const result = new Map<T[K], T>();
  for (const [i, line] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); }
    catch (cause) { throw new Error(`${path}:${i + 1}: invalid JSON`, { cause }); }
    if (!isRow(row) || !valid(row)) throw new Error(`${path}:${i + 1}: invalid row`);
    const id = row[idKey];
    if (result.has(id)) throw new Error(`${path}:${i + 1}: duplicate ID ${String(id)}`);
    result.set(id, row);
  }
  return result;
}

function listEntry(row: Row): row is ListEntry { return text(row.entry_id) && text(row.name); }
function previousReview(row: Row): row is PreviousReview {
  return text(row.review_id) && text(row.customer_id) && typeof row.note === "string";
}

function groupByCustomer<T extends { customer_id: string }>(rows: Iterable<T>): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.customer_id);
    if (group) group.push(row);
    else groups.set(row.customer_id, [row]);
  }
  return groups;
}

function loadCases(directory: string, bankDiagnostic: boolean) {
  const root = realpathSync(directory);
  function input(name: string): string {
    const path = realpathSync(join(root, name));
    const sub = relative(root, path);
    if (!sub || sub === ".." || sub.startsWith(`..${sep}`) || isAbsolute(sub)) {
      throw new Error(`${name} resolves outside the institution directory`);
    }
    return path;
  }
  const cases = indexRows(input("cases.jsonl"), bankCase, "case_id");
  const alerts = indexRows(input("alerts.jsonl"), bankAlert, "alert_id");
  const transactions = indexRows(input("transactions.jsonl"), bankTransaction, "transaction_id");
  const customers = indexRows(input("customers.jsonl"), bankCustomer, "customer_id");
  const evidence = loadEvidenceIndex(root);
  const caseInstitutions = new Set([...cases.values()].map((record) => record.institution));
  if (caseInstitutions.size > 1 || (bankDiagnostic && [...caseInstitutions].some((value) => value !== "bank"))) {
    throw new Error(bankDiagnostic ? "Expected Bank case records" : "Input folder mixes institutions");
  }
  const txByCustomer = groupByCustomer(transactions.values());
  const internalList = bankDiagnostic ? [] : [...indexRows(input("internal_list.jsonl"), listEntry, "entry_id").values()];
  const reviewsByCustomer = groupByCustomer(bankDiagnostic ? [] : indexRows(input("previous_reviews.jsonl"), previousReview, "review_id").values());

  function get(caseId: string): InstitutionCasePack {
    const caseRecord = cases.get(caseId);
    if (!caseRecord) throw new Error(`Unknown Bank case ${caseId}`);
    const customer = customers.get(caseRecord.customer_id);
    if (!customer) throw new Error(`${caseId}: missing customer ${caseRecord.customer_id}`);
    const flagged = new Map<string, BankTransaction>();
    const caseAlerts = caseRecord.alert_ids.map((id) => {
      const alert = alerts.get(id);
      if (!alert || alert.case_id !== caseId || alert.customer_id !== customer.customer_id) {
        throw new Error(`${caseId}: missing or unrelated alert ${id}`);
      }
      for (const transactionId of alert.transaction_ids) {
        const tx = transactions.get(transactionId);
        if (!tx || tx.customer_id !== customer.customer_id) {
          throw new Error(`${caseId}: alert ${id} refers to missing or unrelated transaction ${transactionId}`);
        }
        flagged.set(transactionId, tx);
      }
      return alert;
    });
    const heldPayment = caseRecord.held_payment_id ? transactions.get(caseRecord.held_payment_id) : undefined;
    if (caseRecord.held_payment_id && (!heldPayment || heldPayment.customer_id !== customer.customer_id || heldPayment.direction !== "out")) {
      throw new Error(`${caseId}: missing or unrelated held payment ${caseRecord.held_payment_id}`);
    }
    const { from, to } = caseRecord.review_window;
    const windowTransactions = (txByCustomer.get(customer.customer_id) ?? []).filter((tx) => {
      const day = tx.booked_at.slice(0, 10);
      return day >= from && day <= to;
    });
    return { caseRecord, customer, alerts: caseAlerts, flaggedTransactions: [...flagged.values()],
      documents: evidence.documentsForCustomer(customer.customer_id), windowTransactions, heldPayment,
      previousReviews: reviewsByCustomer.get(customer.customer_id) ?? [], internalList };
  }

  return { root, caseIds: [...cases.keys()], get };
}

export function loadBankCases(directory: string) { return loadCases(directory, true); }
export function loadInstitutionCases(directory: string) { return loadCases(directory, false); }
