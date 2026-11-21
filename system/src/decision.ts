import type { BankAlert, BankTransaction, InstitutionCasePack } from "./bank-cases.js";
import { describe, explainTransactions, type CloseCode, type Explanation, type ExplanationIndex } from "./explanations.js";
import { assessListMatch } from "./list-assessment.js";
import { findSignals, type Signal } from "./signals.js";
import { daysBetween, looksLikeOrganization, nameKey, norm, pence, sameName, txDay } from "./text.js";

export const reasonCodes = {
  CLOSE: ["COLLECTION_DOCUMENTED", "BUSINESS_RECORDS_RECONCILE", "DOCUMENTED_EVENT", "INVOICE_MATCHES", "OWN_ACCOUNT",
    "GROUP_COMPANY", "THIRD_PARTY_DOCUMENTED", "REFUND_OF_EARLIER_PAYMENT", "RETURNING_CUSTOMER", "LIST_MATCH_DIFFERENT_PARTY", "WITHIN_PROFILE"],
  RFI: ["RFI_PURPOSE_DOCUMENTS", "RFI_BUSINESS_RECORDS", "RFI_SOURCE_OF_FUNDS", "RFI_COUNTERPARTY_DETAILS", "RFI_UPDATED_PROFILE"],
  ESCALATE: ["ESC_MULE_ACTIVITY", "ESC_STRUCTURING", "ESC_UNEXPLAINED_FUNDS", "ESC_PASS_THROUGH", "ESC_INVOICE_MISMATCH", "ESC_HIGH_RISK_CORRIDOR",
    "ESC_ACCOUNT_MISUSE", "ESC_THIRD_PARTY_FUNDING", "ESC_EARLY_REDEMPTION", "ESC_LISTED_PARTY"],
} as const;
export type Verdict = keyof typeof reasonCodes;
type Code<V extends Verdict> = (typeof reasonCodes)[V][number];

export interface CaseDecision {
  readonly case_id: string;
  readonly alert_ids: readonly string[];
  readonly verdict: Verdict;
  readonly reason_code: Code<Verdict>;
  readonly reason: string;
  readonly evidence: readonly string[];
}

interface Suspicion { readonly code: Code<"ESCALATE">; readonly fact: string; readonly evidence: readonly string[]; readonly rank: number }
interface Gap { readonly code: Code<"RFI">; readonly fact: string; readonly request: string; readonly evidence: readonly string[]; readonly rank: number }
interface Cover { readonly alert: BankAlert; readonly code: CloseCode; readonly fact?: string; readonly evidence: readonly string[];
  readonly explanations: readonly { tx: BankTransaction; explanation: Explanation }[] }

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const label = (s: string) => s.replace(/\s+/g, " ").trim();
const sentence = (s: string) => `${label(s).replace(/[.!?]+$/, "")}.`;
const distinct = <T>(items: readonly T[]) => [...new Set(items)];
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const largest = (txs: readonly BankTransaction[]) => [...txs].sort((a, b) => b.amount_gbp - a.amount_gbp
  || a.transaction_id.localeCompare(b.transaction_id))[0] as BankTransaction | undefined;
const sumPence = (txs: readonly BankTransaction[]) => txs.reduce((total, tx) => total + (pence(tx.amount_gbp) ?? 0), 0);

/** Escalation precedence when several suspicions apply; the first is the main ground. */
const SUSPICION_ORDER: readonly Code<"ESCALATE">[] = ["ESC_LISTED_PARTY", "ESC_STRUCTURING", "ESC_INVOICE_MISMATCH", "ESC_ACCOUNT_MISUSE",
  "ESC_EARLY_REDEMPTION", "ESC_HIGH_RISK_CORRIDOR", "ESC_UNEXPLAINED_FUNDS", "ESC_MULE_ACTIVITY", "ESC_PASS_THROUGH", "ESC_THIRD_PARTY_FUNDING"];
/** RFI precedence by the alert that raised the gap: identity first, then the released payment, then purpose before source. */
const GAP_ORDER = ["TM22", "RELEASE", "TM08", "TM02", "TM04", "TM03", "TM10", "TM06", "TM07", "TM05", "TM01", "PROFILE"];
/** Close-code precedence: specific relationships before the explanation with the largest amount. */
const CLOSE_OVERRIDES: readonly CloseCode[] = ["LIST_MATCH_DIFFERENT_PARTY", "RETURNING_CUSTOMER", "GROUP_COMPANY", "COLLECTION_DOCUMENTED", "REFUND_OF_EARLIER_PAYMENT"];
const RELEASE_DOCUMENT_TYPES = new Set(["invoice", "supplier_invoice", "carrier_invoice", "dealer_invoice", "hospital_invoice", "contract_schedule"]);

/** Card spending never counts as moving money on; household direct debits and standing orders are not the activity under review. */
function material(alert: BankAlert, tx: BankTransaction): boolean {
  if (tx.channel === "card") return false;
  if (["TM02", "TM04", "TM07"].includes(alert.rule_id) && tx.direction === "out"
    && (tx.channel === "direct_debit" || tx.channel === "standing_order")) return false;
  return true;
}

function baselineOf(pack: InstitutionCasePack, alert?: BankAlert): number | undefined {
  const measured = num(record(alert?.measured).baseline_gbp);
  if (measured && measured > 0) return measured;
  const declared = record(pack.customer.declared);
  const income = num(declared.monthly_income_gbp);
  const annual = num(declared.annual_turnover_gbp);
  return income && income > 0 ? income : annual && annual > 0 ? annual / 12 : undefined;
}

/**
 * Activity against the declared monthly baseline for the 5x own-account rule, compared in pence:
 * the TM01 measurement when there is one, otherwise the review window's inflows.
 */
function profileRatio(pack: InstitutionCasePack): { multiple: number; atLeastFive: boolean } | undefined {
  const tm01 = pack.alerts.find((alert) => alert.rule_id === "TM01");
  const baseline = baselineOf(pack, tm01);
  const received = num(record(tm01?.measured).received_gbp);
  const total = received !== undefined ? pence(received) ?? Math.round(received * 100) : sumPence(pack.windowTransactions.filter((tx) => tx.direction === "in"));
  if (!baseline) {
    const multiple = num(record(tm01?.measured).multiple);
    return multiple === undefined ? undefined : { multiple, atLeastFive: multiple >= 5 };
  }
  return { multiple: total / 100 / baseline, atLeastFive: total >= Math.round(5 * baseline * 100) };
}

function closeCode(items: readonly { tx: BankTransaction; explanation: Explanation }[]): CloseCode {
  for (const code of CLOSE_OVERRIDES) if (items.some((item) => item.explanation.code === code)) return code;
  const documented = items.filter((item) => item.explanation.code !== "WITHIN_PROFILE");
  const top = [...(documented.length ? documented : items)].sort((a, b) => b.tx.amount_gbp - a.tx.amount_gbp
    || a.tx.transaction_id.localeCompare(b.tx.transaction_id))[0];
  return top?.explanation.code ?? "WITHIN_PROFILE";
}

/** Whether the explained activity removes the reason the rule fired, judged against the rule's own threshold. */
function covered(pack: InstitutionCasePack, alert: BankAlert, txs: readonly BankTransaction[], open: readonly BankTransaction[]): boolean {
  const measured = record(alert.measured);
  switch (alert.rule_id) {
    case "TM01": {
      if (txs.some((tx) => tx.direction === "out" && open.includes(tx))) return false;
      // What remains unexplained may only be the customer's own small top-ups, and together they must stay
      // within the rule's own multiple. Unexplained third-party money is never left over.
      const residual = open.filter((tx) => tx.direction === "in");
      if (residual.some((tx) => !sameName(tx.counterparty_name, pack.customer.name))) return false;
      const baseline = baselineOf(pack, alert);
      const multiple = num(measured.limit_multiple) ?? (pack.customer.kind === "business" ? 2 : 3);
      return !!baseline && sumPence(residual) <= Math.round(multiple * baseline * 100);
    }
    case "TM10":
      // An early redemption is explained only when the redemption itself is.
      return open.length === 0 && txs.some((tx) => tx.channel === "fund_redemption");
    case "TM02":
      // The inflow floor does not explain the purpose of a flagged onward payment.
      return !open.some((tx) => tx.direction === "out")
        && sumPence(open.filter((tx) => tx.direction === "in")) < 200_000;
    case "TM04": {
      const limit = num(measured.limit) ?? 6;
      return new Set(open.map((tx) => nameKey(tx.counterparty_name ?? tx.transaction_id))).size <= limit;
    }
    case "TM06":
    case "TM07":
      return sumPence(open) < Math.round((num(measured.limit_gbp) ?? 5_000) * 100);
    default:
      return open.length === 0;
  }
}

/** A crypto purchase, recognised from the payee's name or from a payment reference naming a crypto asset. */
const isCrypto = (tx: BankTransaction) => /\b(?:exchange|crypto\w*|coin\w*|digital assets?|digital currenc\w*|blockchain|tokens?)\b/i.test(tx.counterparty_name ?? "")
  || /\b(?:btc|eth|usdt|usdc|bitcoin|ethereum|crypto\w*|stablecoin\w*)\b/i.test(typeof tx.reference === "string" ? tx.reference : "");
const abroad = (tx: BankTransaction) => !!tx.counterparty_country && norm(String(tx.counterparty_country)) !== "united kingdom";

/** Unexplained rapid movement escalates only on a concrete pattern; otherwise one request can settle it. */
function rapidMovementSuspicion(pack: InstitutionCasePack, open: readonly BankTransaction[]): Suspicion | undefined {
  const outs = open.filter((tx) => tx.direction === "out" && tx.amount_gbp >= 500 && !sameName(tx.counterparty_name, pack.customer.name));
  const ins = open.filter((tx) => tx.direction === "in");
  const individuals = new Set(outs.filter((tx) => !looksLikeOrganization(tx.counterparty_name)).map((tx) => nameKey(tx.counterparty_name ?? "")));
  const crypto = outs.filter(isCrypto);
  const overseasPeople = outs.filter((tx) => abroad(tx) && !looksLikeOrganization(tx.counterparty_name));
  if (!crypto.length && !overseasPeople.length && individuals.size < 2) return;
  const out = largest(crypto.length ? crypto : overseasPeople.length ? overseasPeople : outs)!;
  const inn = largest(ins);
  const payers = new Set(ins.filter((tx) => tx.counterparty_name && !sameName(tx.counterparty_name, pack.customer.name)).map((tx) => nameKey(tx.counterparty_name!)));
  const cash = ins.some((tx) => typeof tx.channel === "string" && tx.channel.includes("cash"));
  const code = crypto.length && payers.size >= 2 ? "ESC_MULE_ACTIVITY" : cash ? "ESC_UNEXPLAINED_FUNDS" : "ESC_PASS_THROUGH";
  const where = crypto.length ? `to the crypto exchange ${label(out.counterparty_name ?? "")}` : overseasPeople.length
    ? `to an individual abroad` : `to ${individuals.size} unrelated individuals`;
  return { code, rank: 0, evidence: [...(inn ? [inn.transaction_id] : []), out.transaction_id],
    fact: inn
      ? `${describe(inn)} was received and funds moved on within days ${where}, including ${describe(out)}, with neither leg explained`
      : `Funds moved on within days ${where}, including ${describe(out)}, and the onward payment has no credible explanation` };
}

function gapFor(pack: InstitutionCasePack, alert: BankAlert, open: readonly BankTransaction[], index: ExplanationIndex): Gap {
  const name = label(pack.customer.name);
  const rank = GAP_ORDER.indexOf(alert.rule_id) >= 0 ? GAP_ORDER.indexOf(alert.rule_id) : GAP_ORDER.length;
  const subject = largest(open) ?? largest(alert.transaction_ids.map((id) => pack.flaggedTransactions.find((tx) => tx.transaction_id === id)!).filter(Boolean));
  const evidence = subject ? [subject.transaction_id] : [];
  const what = subject ? describe(subject) : `the activity flagged by ${alert.alert_id}`;
  const onward = open.map((tx) => index.unexplainedOnward.get(tx.transaction_id)).find(Boolean);
  const fact = `${alert.rule_id} flagged ${what} and nothing on file explains it`;
  if (onward) {
    return { code: "RFI_PURPOSE_DOCUMENTS", rank, evidence: [...evidence, onward.transaction_id],
      fact: `${alert.rule_id} flagged ${what}, which funded ${describe(onward)} with no invoice or contract on file`,
      request: `Ask ${name} for the invoice, purchase order or contract supporting the payment of ${describe(onward)}` };
  }
  switch (alert.rule_id) {
    case "TM01": case "TM05":
      return { code: "RFI_SOURCE_OF_FUNDS", rank, evidence, fact,
        request: `Ask ${name} for documents showing where the money for ${what} came from, such as a sale, settlement, inheritance or account statement` };
    case "TM07": {
      const out = largest(open.filter((tx) => tx.direction === "out"));
      return out
        ? { code: "RFI_PURPOSE_DOCUMENTS", rank, evidence: distinct([...evidence, out.transaction_id]), fact,
          request: `Ask ${name} for the invoice or instruction supporting ${describe(out)} after the account reactivated` }
        : { code: "RFI_SOURCE_OF_FUNDS", rank, evidence, fact,
          request: `Ask ${name} for a statement of the sending account, in their name, that shows the source of ${what}` };
    }
    case "TM03":
      return pack.caseRecord.institution === "payments_fx"
        ? { code: "RFI_PURPOSE_DOCUMENTS", rank, evidence: alert.transaction_ids, fact: `${alert.rule_id} flagged repeated payments just under £10,000, including ${what}, with no contract or schedule on file`,
          request: `Ask ${name} for the contract or payment schedule that sets the amount and timing of each flagged payment` }
        : { code: "RFI_BUSINESS_RECORDS", rank, evidence: alert.transaction_ids, fact: `${alert.rule_id} flagged repeated cash amounts just under the threshold, including ${what}, with no business records on file`,
          request: `Ask ${name} for the takings or collection records behind each flagged cash payment in the review window` };
    case "TM08":
      return { code: "RFI_COUNTERPARTY_DETAILS", rank, evidence, fact: `${alert.rule_id} flagged ${what} from an account not in ${name}'s name`,
        request: `Ask ${name} who ${subject?.counterparty_name ? label(subject.counterparty_name) : "the other party"} is, their relationship to the customer, and the document behind the transfer` };
    case "TM10": {
      const sold = largest(open.filter((tx) => tx.channel === "fund_redemption")) ?? subject;
      const bought = largest(open.filter((tx) => tx.channel === "fund_subscription"));
      return { code: "RFI_PURPOSE_DOCUMENTS", rank, evidence: distinct([...(bought ? [bought.transaction_id] : []), ...(sold ? [sold.transaction_id] : [])]),
        fact: `${alert.rule_id} flagged fund units ${bought ? `bought as ${describe(bought)} and ` : ""}sold back early${sold ? ` as ${describe(sold)}` : ""}, and nothing on file explains why`,
        request: `Ask ${name} why the units were sold within 90 days of purchase and for a document supporting that reason, such as evidence of the change in circumstances` };
    }
    case "TM02": {
      const inn = largest(open.filter((tx) => tx.direction === "in"));
      const out = largest(open.filter((tx) => tx.direction === "out"));
      if (out && !inn) {
        return { code: "RFI_PURPOSE_DOCUMENTS", rank, evidence: open.filter((tx) => tx.direction === "out").map((tx) => tx.transaction_id),
          fact: `${alert.rule_id} flagged rapid movement of funds, but the onward payment of ${describe(out)} is not explained`,
          request: `Ask ${name} for the invoice, contract or transfer instruction supporting the unexplained onward payment${open.length === 1 ? "" : "s"}` };
      }
      return { code: "RFI_PURPOSE_DOCUMENTS", rank, evidence: distinct([...(inn ? [inn.transaction_id] : []), ...(out ? [out.transaction_id] : [])]),
        fact: `${alert.rule_id} flagged money moving through the account within days${inn ? `, including ${describe(inn)}` : ""}${out ? ` and ${describe(out)}` : ""}; no document on file explains the unresolved activity`,
        request: `Ask ${name} for the documents behind ${inn ? "the incoming payment" : "the funds"}${out ? " and the onward payment, such as the agreement, letter or invoice for each" : ""}` };
    }
    case "TM04":
      return { code: "RFI_PURPOSE_DOCUMENTS", rank, evidence, fact: `${alert.rule_id} flagged payments with many different counterparties, including ${what}`,
        request: `Ask ${name} for the booking, payment file or invoices that show who the counterparties are and what each payment was for` };
    default:
      return { code: "RFI_PURPOSE_DOCUMENTS", rank, evidence, fact,
        request: `Ask ${name} for the invoice, agreement or instruction showing the purpose of ${what}` };
  }
}

export function decideCase(pack: InstitutionCasePack): CaseDecision {
  const { caseRecord, customer, alerts, documents, heldPayment } = pack;
  const index = explainTransactions(pack);
  const flagged = new Map(pack.flaggedTransactions.map((tx) => [tx.transaction_id, tx]));
  if (heldPayment) flagged.set(heldPayment.transaction_id, heldPayment);
  const suspicions: Suspicion[] = [];
  const gaps: Gap[] = [];
  const covers: Cover[] = [];
  const rankOf = (code: Code<"ESCALATE">) => SUSPICION_ORDER.indexOf(code) + 1;

  const { from } = caseRecord.review_window;
  const reports = documents.filter(({ metadata }) => metadata.type === "sending_bank_fraud_report" && metadata.dated >= from);
  if (reports.length) {
    const subjects = distinct(reports.flatMap((doc) => /^\*\*Subject:\*\*\s*(.+)$/im.exec(doc.markdown)?.[1] ?? []).map(label));
    const sample = largest(pack.flaggedTransactions.filter((tx) => tx.direction === "in"));
    suspicions.push({ code: "ESC_MULE_ACTIVITY", rank: 0, evidence: [...reports.map((d) => d.metadata.doc_id), ...(sample ? [sample.transaction_id] : [])],
      fact: `Sending-bank fraud ${reports.length === 1 ? "report" : "reports"} ${reports.map((d) => d.metadata.doc_id).join(", ")} ${subjects.length ? `record ${subjects.join("; ")} for money paid into` : "raise a fraud concern about"} ${label(customer.name)}'s account${sample ? `, including ${describe(sample)}` : ""}` });
  }
  for (const signal of findSignals(pack, index)) suspicions.push({ ...signal, rank: rankOf(signal.code) });

  for (const alert of alerts) {
    const txs = alert.transaction_ids.map((id) => flagged.get(id)!).filter(Boolean);
    if (alert.rule_id === "TM22") {
      const assessment = assessListMatch({ measured: alert.measured }, pack.internalList, documents, txs);
      const tx = txs.find((t) => t.transaction_id === assessment.transactionId) ?? largest(txs);
      const evidence = distinct([...assessment.evidence, ...(tx ? [tx.transaction_id] : [])]);
      if (assessment.status === "confirmed") {
        suspicions.push({ code: "ESC_LISTED_PARTY", rank: rankOf("ESC_LISTED_PARTY"), evidence, fact: assessment.detail });
      } else if (assessment.status === "different") {
        covers.push({ alert, code: "LIST_MATCH_DIFFERENT_PARTY", fact: assessment.detail, evidence,
          explanations: txs.flatMap((t) => index.byTx.has(t.transaction_id) ? [{ tx: t, explanation: index.byTx.get(t.transaction_id)! }] : []) });
      } else {
        gaps.push({ code: "RFI_COUNTERPARTY_DETAILS", rank: GAP_ORDER.indexOf("TM22"), evidence, fact: assessment.detail,
          request: `For ${tx ? describe(tx) : alert.alert_id}, ask for official identification of the matched counterparty or officer that distinguishes them from the listed party` });
      }
      continue;
    }
    const relevant = txs.filter((tx) => material(alert, tx));
    const open = relevant.filter((tx) => !index.byTx.has(tx.transaction_id));
    const explanations = relevant.flatMap((tx) => index.byTx.has(tx.transaction_id) ? [{ tx, explanation: index.byTx.get(tx.transaction_id)! }] : []);
    if (explanations.length && covered(pack, alert, relevant, open)) {
      const first = [...relevant].sort((a, b) => a.booked_at.localeCompare(b.booked_at))[0];
      const reverified = alert.rule_id === "TM07" && first && documents.find((doc) => doc.metadata.type === "reverification_record"
        && doc.metadata.dated <= txDay(first) && daysBetween(doc.metadata.dated, txDay(first)) <= 14 && /re-?verified/i.test(doc.markdown));
      covers.push(reverified
        ? { alert, code: "RETURNING_CUSTOMER", evidence: [reverified.metadata.doc_id], explanations,
          fact: `${reverified.metadata.doc_id} re-verified ${label(customer.name)}'s identity on ${reverified.metadata.dated}, before the dormant account reactivated` }
        : { alert, code: closeCode(explanations), evidence: [], explanations });
      continue;
    }
    if (alert.rule_id === "TM02") {
      const suspicion = rapidMovementSuspicion(pack, open);
      if (suspicion) { suspicions.push({ ...suspicion, rank: rankOf(suspicion.code) }); continue; }
    }
    if (alert.rule_id === "TM06") {
      // Several unrelated private individuals sending or receiving money through a higher-risk country is a
      // corridor pattern; a single undocumented commercial payment is a missing document.
      const people = new Set(open.filter((tx) => !looksLikeOrganization(tx.counterparty_name) && !sameName(tx.counterparty_name, customer.name))
        .map((tx) => nameKey(tx.counterparty_name ?? "")));
      if (people.size >= 2) {
        const risky = largest(open)!;
        const countries = String(record(alert.measured).countries ?? (risky.counterparty_country ?? "a higher-risk country"));
        suspicions.push({ code: "ESC_HIGH_RISK_CORRIDOR", rank: rankOf("ESC_HIGH_RISK_CORRIDOR"), evidence: open.map((tx) => tx.transaction_id),
          fact: `${alert.rule_id} flagged payments with ${people.size} unrelated individuals involving ${countries}, a higher-risk country ${label(customer.name)} did not declare, including ${describe(risky)}, and nothing on file explains them` });
        continue;
      }
    }
    if (alert.rule_id === "TM08") {
      const payouts = open.filter((tx) => tx.direction === "out" && !sameName(tx.counterparty_name, customer.name));
      if (payouts.length) {
        const code = alerts.some((a) => a.rule_id === "TM10") ? "ESC_EARLY_REDEMPTION" : "ESC_THIRD_PARTY_FUNDING";
        const payout = largest(payouts)!;
        const deposit = largest(open.filter((tx) => tx.direction === "in"));
        suspicions.push({ code, rank: rankOf(code), evidence: [...(deposit ? [deposit.transaction_id] : []), payout.transaction_id],
          fact: `${deposit ? `${describe(deposit)} came from a third party and ` : ""}${describe(payout)} was paid out to someone other than ${label(customer.name)}${code === "ESC_EARLY_REDEMPTION" ? " after fund units were bought and quickly sold" : ""}, with no relationship documented` });
        continue;
      }
    }
    gaps.push(gapFor(pack, alert, open, index));
  }

  let heldSupport: { tx: BankTransaction; explanation: Explanation } | undefined;
  if (caseRecord.institution === "payments_fx" && heldPayment) {
    const support = index.byTx.get(heldPayment.transaction_id);
    const large = heldPayment.amount_gbp >= 10_000;
    const owned = support?.code === "OWN_ACCOUNT" && support.docs.length > 0;
    const evidencedPurpose = support?.code === "INVOICE_MATCHES" && documents.some((doc) =>
      RELEASE_DOCUMENT_TYPES.has(doc.metadata.type) && support.docs.includes(doc.metadata.doc_id));
    if (support && (!large || owned || evidencedPurpose)) {
      heldSupport = { tx: heldPayment, explanation: support };
    } else {
      const payee = label(heldPayment.counterparty_name ?? "the beneficiary");
      const ownName = sameName(heldPayment.counterparty_name, customer.name);
      gaps.push({ code: "RFI_PURPOSE_DOCUMENTS", rank: GAP_ORDER.indexOf("RELEASE"), evidence: [heldPayment.transaction_id],
        fact: `The held payment of ${describe(heldPayment)} ${ownName
          ? "names the client but the destination account has not been shown to belong to them"
          : large ? "is £10,000 or more and no invoice or contract on file supports it"
            : "is not explained by the evidence on file"}`,
        request: ownName
          ? `Ask ${label(customer.name)} for a statement showing they hold the destination account for the exact held payment before release`
          : `Ask ${label(customer.name)} for ${large ? "the invoice or signed contract" : "the invoice, contract or payment instruction"} that names ${payee} and supports the exact held amount before release` });
    }
  }

  const items = covers.flatMap((cover) => cover.explanations);
  if (heldSupport && !items.some(({ tx }) => tx.transaction_id === heldSupport.tx.transaction_id)) items.push(heldSupport);
  // The 5x rule applies when own-account transfers are what explains the activity.
  const own = items.filter((item) => item.explanation.code === "OWN_ACCOUNT" || item.explanation.ownFunds);
  const ratio = own.length ? profileRatio(pack) : undefined;
  if (ratio?.atLeastFive) {
    gaps.push({ code: "RFI_UPDATED_PROFILE", rank: GAP_ORDER.indexOf("PROFILE"), evidence: distinct(own.flatMap((item) => [...item.explanation.docs, item.tx.transaction_id])),
      fact: `${own[0].explanation.fact}, but the activity is ${ratio.multiple.toFixed(2)} times ${label(customer.name)}'s declared monthly income or volume, at least the 5x limit`,
      request: `Ask ${label(customer.name)} for an updated expected monthly income or payment volume` });
  }

  const name = label(customer.name);
  const rules = distinct(alerts.map((alert) => alert.rule_id)).join(" and ");
  let verdict: Verdict;
  let code: Code<Verdict>;
  let reason: string[];
  let evidence: string[];
  if (suspicions.length) {
    const ordered = [...suspicions].sort((a, b) => a.rank - b.rank);
    const [primary, second] = ordered;
    verdict = "ESCALATE";
    code = primary.code;
    reason = [primary.fact, ...(second && second.fact !== primary.fact ? [second.fact] : []),
      `Refer the case to the MLRO without contacting ${name}, as the activity behind ${rules} is not credibly explained`];
    evidence = distinct([...primary.evidence, ...(second?.evidence ?? [])]);
  } else if (gaps.length) {
    const ordered = [...gaps].sort((a, b) => a.rank - b.rank);
    const primary = ordered[0];
    const others = distinct(ordered.slice(1).map((gap) => gap.request).filter((request) => request !== primary.request));
    verdict = "RFI";
    code = primary.code;
    reason = [primary.fact, `${primary.request}${others.length ? `, and also ${others.map((r) => r.replace(/^Ask \S+(?: \S+)*? for /, "")).join("; ")}` : ""}`];
    const closed = covers.find((cover) => cover.fact || cover.explanations.some((item) => item.explanation.docs.length));
    if (closed) reason.splice(1, 0, `${closed.fact ?? closed.explanations.find((item) => item.explanation.docs.length)!.explanation.fact}, which settles ${closed.alert.rule_id}`);
    evidence = distinct(ordered.flatMap((gap) => gap.evidence));
  } else {
    const special = covers.find((cover) => cover.code === "LIST_MATCH_DIFFERENT_PARTY") ?? covers.find((cover) => cover.code === "RETURNING_CUSTOMER");
    const best = special?.code ?? closeCode(items);
    verdict = "CLOSE";
    code = best;
    const documented = distinct(items.filter((item) => item.explanation.code !== "WITHIN_PROFILE" || item.explanation.docs.length)
      .sort((a, b) => b.tx.amount_gbp - a.tx.amount_gbp).map((item) => item.explanation.fact));
    const lead = special?.fact;
    const facts = distinct([...(lead ? [lead] : []), ...(heldSupport ? [heldSupport.explanation.fact] : []), ...documented]).slice(0, 2);
    reason = [...(facts.length ? facts : [`The flagged activity fits ${name}'s declared profile`]),
      `Together the evidence explains all the activity behind ${rules}${heldPayment ? ", so the held payment can be released" : ""}`];
    // Cite every explained transaction that coverage relied on, except routine own-name funding.
    evidence = distinct([...covers.flatMap((cover) => cover.evidence),
      ...items.filter((item) => !item.explanation.ownFunds)
        .flatMap((item) => [...item.explanation.docs, item.tx.transaction_id, ...item.explanation.related])]);
    if (!evidence.length) evidence = distinct(items.map((item) => item.tx.transaction_id)).slice(0, 3);
  }
  return { case_id: caseRecord.case_id, alert_ids: caseRecord.alert_ids, verdict, reason_code: code,
    reason: reason.map(sentence).join(" "), evidence: evidence.filter((id) => validEvidence(pack).has(id)) };
}

function validEvidence(pack: InstitutionCasePack): Set<string> {
  return new Set([...pack.flaggedTransactions, ...pack.windowTransactions, ...pack.priorTransactions, ...(pack.heldPayment ? [pack.heldPayment] : [])]
    .map((tx) => tx.transaction_id).concat(pack.documents.map((doc) => doc.metadata.doc_id), pack.internalList.map((entry) => entry.entry_id)));
}

