/**
 * The fallback reader: after the deterministic pass, send the model only the documents that could change an
 * open case and that no parser used, then turn its checked facts into explanations and suspicion for a second,
 * otherwise identical deterministic pass.
 */
import type { InstitutionCasePack } from "../bank-cases.js";
import type { CaseDecision } from "../decision.js";
import type { EvidenceDocument } from "../evidence.js";
import { explainTransactions } from "../explanations.js";
import {
  explainFromDocument, PAYMENT_PURPOSES, signalsFromDocument, type ConcernFacts, type Findings, type OwnershipFact,
  type PaymentDocumentFacts, type PaymentFact,
} from "./facts.js";
import type { DocumentReader } from "./openrouter.js";
import type { TaskKind } from "./prompts.js";

/**
 * Document types never sent as payment evidence: identity, profile and register records the parsers already
 * read structurally, and the statement types handled by the concern task.
 */
const NOT_PAYMENT_EVIDENCE = new Set(["due_diligence_summary", "contact_note", "proof_of_address", "company_register_extract",
  "significant_control_register", "management_accounts", "device_export", "reverification_record", "sending_bank_fraud_report",
  "staff_note", "support_chat", "customer_email", "bank_statement", "employment_contract", "consulting_contract",
  "cash_handling_procedure", "ticket_report", "advert", "insurance_schedule"]);
/** Where a customer's or staff member's own words can show suspicion. */
const CONCERN_TYPES = new Set(["staff_note", "support_chat", "customer_email"]);
const MAX_PAYMENT_DOCS = 4;
const MAX_CONCERN_DOCS = 3;

export interface Task { readonly kind: TaskKind; readonly doc: EvidenceDocument }
const taskKey = (task: Task) => `${task.kind}:${task.doc.metadata.doc_id}`;

/** The documents worth reading for a case, given its deterministic decision. */
export function planTasks(pack: InstitutionCasePack, decision: CaseDecision): Task[] {
  if (decision.verdict === "ESCALATE") return [];
  const { from, to } = pack.caseRecord.review_window;
  const latest = pack.heldPayment && pack.heldPayment.booked_at.slice(0, 10) > to ? pack.heldPayment.booked_at.slice(0, 10) : to;
  const own = pack.documents.filter((doc) => doc.metadata.customer_id === pack.customer.customer_id);
  const tasks: Task[] = [];
  // Payment evidence can only turn an RFI into a close; a closed case needs no more explanation.
  if (decision.verdict === "RFI") {
    const used = new Set([...decision.evidence, ...[...explainTransactions(pack).byTx.values()].flatMap((e) => e.docs)]);
    tasks.push(...own.filter((doc) => !NOT_PAYMENT_EVIDENCE.has(doc.metadata.type) && !used.has(doc.metadata.doc_id) && doc.metadata.dated <= latest)
      .slice(0, MAX_PAYMENT_DOCS).map((doc) => ({ kind: "payments" as const, doc })));
  }
  // A statement of concern can overturn a close or an RFI.
  tasks.push(...own.filter((doc) => CONCERN_TYPES.has(doc.metadata.type) && doc.metadata.dated >= from)
    .slice(0, MAX_CONCERN_DOCS).map((doc) => ({ kind: "concerns" as const, doc })));
  return tasks;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const record = (v: unknown) => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** A model answer for the payments task, keeping only well-formed items. */
export function asPaymentFacts(answer: unknown): PaymentDocumentFacts | undefined {
  const root = record(answer);
  if (!root || !Array.isArray(root.payments) || !Array.isArray(root.ownership)) return;
  const payments = root.payments.flatMap((item): PaymentFact[] => {
    const p = record(item);
    if (!p || !["to_customer", "from_customer"].includes(p.direction as string) || !PAYMENT_PURPOSES.includes(p.purpose as never)
      || !["confirmed", "scheduled", "conditional", "denied", "partial", "unclear"].includes(p.status as string)) return [];
    const strings = [p.counterparty, p.counterparty_quote, p.amount, p.amount_quote].every(isString);
    const optional = [p.reference, p.reference_quote, p.due_date, p.due_date_quote, p.recipient, p.recipient_quote].every(isNullableString);
    return strings && optional ? [p as unknown as PaymentFact] : [];
  });
  const ownership = root.ownership.flatMap((item): OwnershipFact[] => {
    const o = record(item);
    return o && [o.parent, o.subsidiary, o.quote].every(isString) ? [o as unknown as OwnershipFact] : [];
  });
  return { payments, ownership };
}

/** A model answer for the concerns task, with any malformed statement read as absent. */
export function asConcernFacts(answer: unknown): ConcernFacts | undefined {
  const root = record(answer);
  if (!root) return;
  const statement = (v: unknown) => {
    const s = record(v);
    return s && s.present === true && isString(s.quote) ? { present: true, quote: s.quote } : { present: false, quote: null };
  };
  return { structuring: statement(root.structuring), account_used_by_others: statement(root.account_used_by_others),
    refused_to_explain: statement(root.refused_to_explain) };
}

/** Explanations and suspicion for a case from the answers to its tasks. */
export function findingsFor(pack: InstitutionCasePack, tasks: readonly Task[], answers: ReadonlyMap<string, unknown>): Findings {
  const explanations: Findings["explanations"][number][] = [];
  const signals: Findings["signals"][number][] = [];
  for (const task of tasks) {
    const answer = answers.get(taskKey(task));
    if (task.kind === "payments") {
      const facts = asPaymentFacts(answer);
      if (facts) explanations.push(...explainFromDocument(pack, task.doc, facts));
    } else {
      const facts = asConcernFacts(answer);
      if (facts) signals.push(...signalsFromDocument(pack, task.doc, facts));
    }
  }
  return { explanations, signals };
}

/** Read every distinct task once, with at most `concurrency` calls in flight. */
export async function readAll(tasks: readonly { task: Task; customerName: string }[], reader: DocumentReader, concurrency = 8):
  Promise<Map<string, unknown>> {
  const answers = new Map<string, unknown>();
  const distinct = [...new Map(tasks.map((t) => [taskKey(t.task), t])).values()];
  let next = 0;
  async function worker() {
    while (next < distinct.length) {
      const { task, customerName } = distinct[next++];
      answers.set(taskKey(task), await reader.read(task.kind, task.doc, customerName));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, distinct.length) }, worker));
  return answers;
}
