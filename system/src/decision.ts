import type { BankAlert, BankTransaction, InstitutionCasePack } from "./bank-cases.js";
import { assessListMatch } from "./list-assessment.js";
import { matchedInvoices, minor, normalize, ownedAccount } from "./reconciliation.js";

export const reasonCodes = {
  CLOSE: ["COLLECTION_DOCUMENTED", "BUSINESS_RECORDS_RECONCILE", "DOCUMENTED_EVENT", "INVOICE_MATCHES", "OWN_ACCOUNT",
    "GROUP_COMPANY", "THIRD_PARTY_DOCUMENTED", "REFUND_OF_EARLIER_PAYMENT", "RETURNING_CUSTOMER", "LIST_MATCH_DIFFERENT_PARTY", "WITHIN_PROFILE"],
  RFI: ["RFI_PURPOSE_DOCUMENTS", "RFI_BUSINESS_RECORDS", "RFI_SOURCE_OF_FUNDS", "RFI_COUNTERPARTY_DETAILS", "RFI_UPDATED_PROFILE"],
  ESCALATE: ["ESC_MULE_ACTIVITY", "ESC_STRUCTURING", "ESC_UNEXPLAINED_FUNDS", "ESC_PASS_THROUGH", "ESC_INVOICE_MISMATCH", "ESC_HIGH_RISK_CORRIDOR",
    "ESC_ACCOUNT_MISUSE", "ESC_THIRD_PARTY_FUNDING", "ESC_EARLY_REDEMPTION", "ESC_LISTED_PARTY"],
} as const;
export type Verdict = keyof typeof reasonCodes;
type Code<V extends Verdict> = (typeof reasonCodes)[V][number];

type Finding = {
  [V in Verdict]: { verdict: V; code: Code<V>; sentences: readonly [string, string]; evidence: readonly string[]; request?: string };
}[Verdict];
export interface CaseDecision {
  readonly case_id: string;
  readonly alert_ids: readonly string[];
  readonly verdict: Verdict;
  readonly reason_code: Code<Verdict>;
  readonly reason: string;
  readonly evidence: readonly string[];
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const label = (s: string) => s.replace(/\s+/g, " ").trim();
const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const txText = (tx: BankTransaction) => `${gbp.format(tx.amount_gbp)} ${tx.direction === "in" ? "from" : "to"} ${label(tx.counterparty_name ?? "an unidentified counterparty")} on ${tx.booked_at.slice(0, 10)} (${tx.transaction_id})`;
const sentence = (s: string) => `${label(s).replace(/[.!?]+$/, "")}.`;
const distinct = (ids: readonly string[]) => [...new Set(ids)];

function finding<V extends Verdict>(verdict: V, code: Code<V>, facts: string, action: string, evidence: readonly string[], request?: string) {
  return { verdict, code, sentences: [sentence(facts), sentence(action)] as const, evidence, request };
}

function anchor(txs: readonly BankTransaction[], direction?: BankTransaction["direction"]) {
  return txs.reduce<BankTransaction | undefined>((largest, tx) =>
    (!direction || tx.direction === direction) && (!largest || tx.amount_gbp > largest.amount_gbp) ? tx : largest, undefined);
}

function profile(pack: InstitutionCasePack, alert?: BankAlert) {
  const measured = record(alert?.measured);
  const declared = record(pack.customer.declared);
  const incoming = pack.windowTransactions.filter((t) => t.direction === "in");
  const annual = declared.annual_turnover_gbp;
  const income = declared.monthly_income_gbp;
  const baseline = typeof measured.baseline_gbp === "number" && measured.baseline_gbp > 0 ? measured.baseline_gbp
    : typeof income === "number" && income > 0 ? income
    : typeof annual === "number" && annual > 0 ? annual / 12 : undefined;
  const measuredReceived = measured.received_gbp;
  const total = typeof measuredReceived === "number" ? measuredReceived : incoming.reduce((sum, tx) => sum + (minor(tx.amount_gbp) ?? 0), 0) / 100;
  return { baseline, total, incoming };
}

const escalationByRule: Readonly<Record<string, Code<"ESCALATE">>> = {
  TM02: "ESC_PASS_THROUGH", TM06: "ESC_HIGH_RISK_CORRIDOR", TM10: "ESC_EARLY_REDEMPTION",
};

export function decideCase(pack: InstitutionCasePack): CaseDecision {
  const { caseRecord, customer, alerts, documents, heldPayment } = pack;
  const all = new Map(pack.flaggedTransactions.map((tx) => [tx.transaction_id, tx]));
  if (heldPayment) all.set(heldPayment.transaction_id, heldPayment);
  const invoiceIds = matchedInvoices(pack, [...all.values()]);
  const ownership = new Map([...all.values()].map((tx) => [tx.transaction_id, ownedAccount(pack, tx)]));
  const global: Finding[] = [];
  const alertFindings: Finding[] = [];
  const { from } = caseRecord.review_window;
  const currentDocs = documents.filter((doc) => doc.metadata.dated >= from);
  const reports = currentDocs.filter(({ metadata }) => metadata.type === "sending_bank_fraud_report");
  const sample = anchor([...all.values()], "in") ?? anchor([...all.values()]);
  if (reports.length) {
    const subjects = reports.flatMap((doc) => {
      const subject = /^\*\*Subject:\*\*\s*(.+)$/im.exec(doc.markdown)?.[1];
      return subject ? [label(subject)] : [];
    });
    global.push(finding("ESCALATE", "ESC_MULE_ACTIVITY",
      `Sending-bank fraud ${reports.length === 1 ? "report" : "reports"} ${reports.map((d) => d.metadata.doc_id).join(", ")} ${subjects.length ? `record ${distinct(subjects).join("; ")} for activity on` : "raise a fraud concern on"} ${label(customer.name)}'s account`,
      `Refer the account to the MLRO${sample ? ` and review the flagged flow including ${txText(sample)}` : " before any customer contact"}`,
      [...reports.map((d) => d.metadata.doc_id), ...(sample ? [sample.transaction_id] : [])]));
  }

  for (const alert of alerts) {
    const txs = alert.transaction_ids.map((id) => all.get(id)!);
    const tx = alert.rule_id === "TM01" ? anchor(txs, "in") ?? anchor(txs) : anchor(txs);
    const evidence = tx ? [tx.transaction_id] : [];
    const trigger = tx ? `${alert.rule_id} flagged ${txText(tx)} in ${label(customer.name)}'s case`
      : `${alert.rule_id} flagged activity in ${label(customer.name)}'s ${caseRecord.review_window.from} to ${caseRecord.review_window.to} review`;
    const notes = currentDocs.filter((doc) => doc.metadata.type === "staff_note");
    if (alert.rule_id === "TM22") {
      const assessment = assessListMatch({ measured: alert.measured }, pack.internalList, documents, txs);
      const assessedTx = txs.find((t) => t.transaction_id === assessment.transactionId) ?? tx;
      const reliedOn = [...assessment.evidence, ...(assessedTx ? [assessedTx.transaction_id] : [])];
      if (assessment.status === "confirmed") {
        const subject = assessedTx ? txText(assessedTx) : alert.alert_id;
        alertFindings.push(finding("ESCALATE", "ESC_LISTED_PARTY", assessment.detail,
          `Refer the internal-list match for ${subject} to the MLRO`, reliedOn));
      } else if (assessment.status === "different") {
        // An identity mismatch explains TM22, not the commercial purpose of unrelated transfers.
        const invoices = txs.flatMap((t) => invoiceIds.get(t.transaction_id) ?? []);
        alertFindings.push(finding("CLOSE", "LIST_MATCH_DIFFERENT_PARTY", assessment.detail,
          `${trigger}${invoices.length ? `, and ${distinct(invoices).join(", ")} reconciles the flagged payment evidence` : ""}`,
          [...reliedOn, ...alert.transaction_ids, ...invoices]));
      } else {
        alertFindings.push(finding("RFI", "RFI_COUNTERPARTY_DETAILS", assessment.detail,
          `For ${assessedTx ? txText(assessedTx) : alert.alert_id}, ask for official identification of the matched counterparty or officer that distinguishes them from the listed party`,
          reliedOn, `counterparty:${assessedTx?.transaction_id ?? alert.alert_id}`));
      }
      continue;
    }
    if (alert.rule_id === "TM03") {
      const note = notes.find((d) => /\b(?:below|under)\b[^.\n]{0,130}\b(?:threshold|reporting|verification|exempt)|\b(?:avoid|evade|bypass)\b[^.\n]{0,100}\b(?:threshold|reporting|verification|checks|invoice)/i.test(d.markdown));
      if (note) {
        alertFindings.push(finding("ESCALATE", "ESC_STRUCTURING",
          `${trigger}; staff note ${note.metadata.doc_id} records a discussion of staying below the applicable checks`,
          "Refer the repeated subthreshold activity to the MLRO rather than contacting the customer", [note.metadata.doc_id, ...alert.transaction_ids]));
        continue;
      }
    }
    if (alert.rule_id === "TM06") {
      const note = notes.find((d) => /\b(?:unwilling|refused|declined)\s+to\s+(?:explain|clarify|disclose|identify|provide)/i.test(d.markdown));
      if (note) {
        alertFindings.push(finding("ESCALATE", "ESC_HIGH_RISK_CORRIDOR", `${trigger}; staff note ${note.metadata.doc_id} records a refusal to explain or substantiate the activity`,
          "Pass the unexplained higher-risk activity to the MLRO", [note.metadata.doc_id, ...evidence]));
        continue;
      }
    }
    const own = txs.flatMap((t) => ownership.get(t.transaction_id) ?? []);
    const invoice = txs.flatMap((t) => invoiceIds.get(t.transaction_id) ?? []);
    if (txs.length && own.length === txs.length && ["TM01", "TM02", "TM06", "TM08"].includes(alert.rule_id)) {
      const p = profile(pack, alert.rule_id === "TM01" ? alert : undefined);
      const tied = [...distinct(own), ...alert.transaction_ids];
      if (!p.baseline || Number(p.total.toFixed(2)) >= Number((5 * p.baseline).toFixed(2))) {
        const ratio = p.baseline ? `${gbp.format(p.total)} against a declared monthly baseline of ${gbp.format(p.baseline)}` : "no usable declared monthly amount for comparison";
        alertFindings.push(finding("RFI", "RFI_UPDATED_PROFILE", `${distinct(own).join(", ")} documents the other account ownership for ${tx ? txText(tx) : alert.alert_id}, with ${ratio}`,
          `Ask ${label(customer.name)} for their updated expected monthly income or payment volume`, tied, "profile"));
      } else {
        alertFindings.push(finding("CLOSE", "OWN_ACCOUNT", `${distinct(own).join(", ")} identifies the other accounts as held by ${label(customer.name)} and supports the flagged transfers`,
          `${trigger}; reviewed inflows of ${gbp.format(p.total)} are below five times the ${gbp.format(p.baseline)} monthly baseline`, tied));
      }
      continue;
    }
    if (txs.length && invoice.length === txs.length && ["TM04", "TM06"].includes(alert.rule_id)) {
      alertFindings.push(finding("CLOSE", "INVOICE_MATCHES", `${distinct(invoice).join(", ")} reconciles the billed customer, payee, date and amount for the flagged payments`,
        `${trigger}; the invoices explain the flagged outgoing activity`, [...distinct(invoice), ...alert.transaction_ids]));
      continue;
    }
    if (alert.rule_id === "TM02" && txs.some((t) => t.direction === "in") && txs.some((t) => t.direction === "out")
      && new Set(txs.filter((t) => !ownership.get(t.transaction_id)).map((t) => normalize(t.counterparty_name ?? ""))).size > 1) {
      const incoming = anchor(txs, "in")!;
      const outgoing = anchor(txs, "out")!;
      alertFindings.push(finding("ESCALATE", "ESC_PASS_THROUGH",
        `The rapid-movement alert links ${txText(incoming)} and ${txText(outgoing)}`,
        "The available reconciliations do not explain the flows between the parties; refer the linked movements to the MLRO",
        [incoming.transaction_id, outgoing.transaction_id]));
      continue;
    }
    const subjectTx = alert.rule_id === "TM01" || alert.rule_id === "TM05" ? tx : heldPayment ?? tx;
    const description = subjectTx ? txText(subjectTx) : `alert ${alert.alert_id}`;
    const requestEvidence = subjectTx ? [subjectTx.transaction_id, ...evidence] : evidence;
    if (alert.rule_id === "TM03" && caseRecord.institution !== "payments_fx") {
      alertFindings.push(finding("RFI", "RFI_BUSINESS_RECORDS", `${trigger}; the repeated cash activity has not been reconciled to the underlying receipts`,
        `Ask for the cash receipts ledger covering the flagged deposits or top-ups in the ${caseRecord.review_window.from} to ${caseRecord.review_window.to} window`,
        alert.transaction_ids, "cash-ledger"));
    } else if (alert.rule_id === "TM01" || alert.rule_id === "TM05") {
      const p = profile(pack, alert.rule_id === "TM01" ? alert : undefined);
      const appendix = alert.rule_id === "TM01" && p.baseline ? `; the review records ${gbp.format(p.total)} against a ${gbp.format(p.baseline)} monthly baseline` : "";
      const inflows = txs.filter((t) => t.direction === "in");
      const scope = alert.rule_id === "TM01" && inflows.length > 1 ? `${description} and the other flagged inflows in the review window` : description;
      alertFindings.push(finding("RFI", "RFI_SOURCE_OF_FUNDS", trigger + appendix,
        `Ask for the source-of-funds record showing how the money for ${scope} was obtained`, requestEvidence, `source:${subjectTx?.transaction_id ?? alert.alert_id}`));
    } else if (alert.rule_id === "TM08") {
      alertFindings.push(finding("RFI", "RFI_COUNTERPARTY_DETAILS", `${trigger}; the other account's ownership or relationship to the customer is not established`,
        `Ask for the originating or receiving account statement naming its holder for ${description}`, requestEvidence, `counterparty:${subjectTx?.transaction_id ?? alert.alert_id}`));
    } else {
      const purpose = alert.rule_id === "TM07" ? "the instruction documenting why the dormant account was reactivated for"
        : alert.rule_id === "TM10" ? "the redemption instruction documenting the purpose of"
        : "the underlying invoice or signed payment instruction showing the purpose of";
      alertFindings.push(finding("RFI", "RFI_PURPOSE_DOCUMENTS", `${trigger}; the records do not substantiate the purpose of the flagged activity`,
        `Ask for ${purpose} ${description}`, requestEvidence, `purpose:${subjectTx?.transaction_id ?? alert.alert_id}`));
    }
  }

  if (caseRecord.institution === "payments_fx" && heldPayment && heldPayment.amount_gbp >= 10_000
    && !ownership.get(heldPayment.transaction_id) && !invoiceIds.has(heldPayment.transaction_id)) {
    const hasBill = documents.some((doc) => doc.extraction.kind === "invoice" || /contract/.test(doc.metadata.type));
    if (!hasBill) {
      global.push(finding("RFI", "RFI_PURPOSE_DOCUMENTS", `The held payment of ${txText(heldPayment)} requires an invoice or contract before release`,
        "Ask for the invoice or signed contract naming the beneficiary and tying the amount to this held payment",
        [heldPayment.transaction_id], `purpose:${heldPayment.transaction_id}`));
    } else {
      // A document that did not reconcile is not necessarily fraudulent. Do not release or imply verification.
      global.push(finding("RFI", "RFI_PURPOSE_DOCUMENTS", `No invoice or contract has been reconciled to the held payment of ${txText(heldPayment)}`,
        "Ask for the invoice or signed contract that identifies this beneficiary and supports the exact held amount",
        [heldPayment.transaction_id], `purpose:${heldPayment.transaction_id}`));
    }
  }

  const decisions = [...global, ...alertFindings];
  const suspicion = decisions.find((f) => f.verdict === "ESCALATE");
  const gaps = decisions.filter((f) => f.verdict === "RFI");
  let primary: Finding;
  let reliedOn: readonly Finding[];
  let extra = "";
  if (suspicion) {
    primary = suspicion;
    reliedOn = [primary];
  } else if (gaps.length && new Set(gaps.map((f) => f.request)).size === 1) {
    primary = gaps[0];
    reliedOn = decisions;
  } else if (gaps.length || !decisions.length) {
    const relevant = alerts.find((a) => a.rule_id === "TM02") ?? alerts.find((a) => a.rule_id === "TM06") ?? alerts[0];
    const codes = relevant ? escalationByRule[relevant.rule_id] : undefined;
    const context = sample ? `, including ${txText(sample)}` : "";
    primary = finding("ESCALATE", codes ?? "ESC_UNEXPLAINED_FUNDS",
      `The review of ${label(customer.name)} leaves ${gaps.length || "unassessed"} material evidence gaps${context}`,
      "No single request would settle the outstanding activity, so refer the case to the MLRO rather than close it",
      sample ? [sample.transaction_id] : []);
    reliedOn = [primary, ...gaps];
  } else {
    primary = decisions.find((f) => f.code === "LIST_MATCH_DIFFERENT_PARTY") ?? decisions[0];
    reliedOn = decisions;
  }
  if (primary.verdict !== "ESCALATE" && reliedOn.length > 1) {
    const other = reliedOn.find((f) => f !== primary && f.verdict === "CLOSE" && f.sentences[0] !== primary.sentences[0]);
    if (other) extra = ` ${other.sentences[0]}`;
  }
  return { case_id: caseRecord.case_id, alert_ids: caseRecord.alert_ids, verdict: primary.verdict, reason_code: primary.code,
    reason: primary.sentences.join(" ") + extra, evidence: distinct(reliedOn.flatMap((f) => f.evidence)) };
}
