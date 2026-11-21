import type { BankTransaction, InstitutionCasePack } from "./bank-cases.js";
import type { Explanation } from "./explanations.js";
import { accountKey, looksLikeOrganization, norm, pence, sameAccount, sameName, txDay } from "./text.js";

const dayMs = 86_400_000;
// The supplied transaction history typically spans 120 days. Do not let older, dormant activity establish recurrence.
const recipientHistoryMs = 120 * dayMs;
const minimumIncoming = 200_000;
const minimumOnward = minimumIncoming * 4 / 5;
const amountOf = (tx: BankTransaction) => pence(tx.amount_gbp) ?? 0;
const sum = (txs: readonly BankTransaction[]) => txs.reduce((total, tx) => total + amountOf(tx), 0);
const atLeast80Percent = (part: number, whole: number) => 5 * part >= 4 * whole;
const time = (tx: BankTransaction) => Date.parse(tx.booked_at);
const precedesWithin48h = (a: BankTransaction, b: BankTransaction) => time(a) <= time(b) && time(b) - time(a) <= 2 * dayMs;

const domestic = (tx: BankTransaction) => typeof tx.counterparty_country === "string"
  && sameName(tx.counterparty_country, "United Kingdom");
function everydayChannel(tx: BankTransaction): boolean {
  if (tx.direction !== "out" || !domestic(tx)) return false;
  return tx.channel === "cash_withdrawal" || (tx.channel === "wallet_transfer" && !!tx.counterparty_name
    && !looksLikeOrganization(tx.counterparty_name));
}

/** Prior ten-day volume for the same channel, ending before this alert's activity. */
function priorComparable(
  history: readonly BankTransaction[], channel: unknown, first: number, amount: number,
): readonly BankTransaction[] | undefined {
  const sorted = history.filter((tx) => everydayChannel(tx) && tx.channel === channel && time(tx) < first)
    .sort((a, b) => time(b) - time(a) || a.transaction_id.localeCompare(b.transaction_id));
  let start = 0;
  let total = 0;
  for (const [end, tx] of sorted.entries()) {
    total += amountOf(tx);
    while (time(sorted[start]) - time(tx) >= 10 * dayMs) total -= amountOf(sorted[start++]);
    if (total >= amount) return sorted.slice(start, end + 1);
  }
  return undefined;
}

function sameRecipient(a: BankTransaction, b: BankTransaction): boolean {
  if (!sameName(a.counterparty_name, b.counterparty_name)) return false;
  if (!a.counterparty_account && !b.counterparty_account) return true;
  const account = accountKey(a.counterparty_account);
  return !!account && !account.startsWith("ending:") && account === accountKey(b.counterparty_account);
}

/** Repeated prior payments to the recipient, not just payments sharing a memo or an amount. */
function recurringRecipients(
  activity: readonly BankTransaction[], history: readonly BankTransaction[], principal: readonly BankTransaction[], first: number,
): BankTransaction[] | undefined {
  if (activity.some((tx) => tx.channel !== "wallet_transfer"
    || principal.some((leg) => sameName(tx.counterparty_name, leg.counterparty_name)
      || sameAccount(tx.counterparty_account, leg.counterparty_account)))) return undefined;
  const prior = history.filter((tx) => everydayChannel(tx) && tx.channel === "wallet_transfer" && amountOf(tx) > 0
    && time(tx) < first && first - time(tx) <= recipientHistoryMs)
    .sort((a, b) => time(b) - time(a) || a.transaction_id.localeCompare(b.transaction_id));
  const unassigned = new Set(activity);
  const evidence: BankTransaction[] = [];
  for (const tx of activity) {
    if (!unassigned.has(tx)) continue;
    const group = [...unassigned].filter((other) => other === tx || sameRecipient(tx, other));
    const needed = sum(group);
    const days = new Set<string>();
    let amount = 0;
    for (const match of prior.filter((other) => sameRecipient(tx, other))) {
      days.add(txDay(match));
      amount += amountOf(match);
      evidence.push(match);
      if (days.size >= 2 && amount >= needed) break;
    }
    if (days.size < 2 || amount < needed) return undefined;
    for (const item of group) unassigned.delete(item);
  }
  return evidence;
}

/** Give no credit for an unknown opening balance and do not spend the reconciled receipts twice. */
function separateFunding(
  accountActivity: readonly BankTransaction[], topups: readonly BankTransaction[], residualOut: readonly BankTransaction[],
  principal: readonly BankTransaction[], payout: BankTransaction,
): BankTransaction[] | undefined {
  const first = Math.min(...residualOut.map(time));
  const last = Math.max(...residualOut.map(time));
  const earlier = topups.filter((tx) => time(tx) < first && /^top[ -]?up$/.test(norm(String(tx.reference ?? ""))));
  if (!earlier.length) return undefined;
  const credits = new Set(earlier.map((tx) => tx.transaction_id));
  const start = Math.min(...earlier.map(time));
  const evidence: BankTransaction[] = [];
  let available = 0;
  const coveredPayout = sum(principal.filter((tx) => time(tx) < time(payout)));
  if (!Number.isSafeInteger(coveredPayout)) return undefined;
  const movements = accountActivity.filter((tx) => (tx.direction === "out" || credits.has(tx.transaction_id))
    && time(tx) >= start && time(tx) <= last).sort((a, b) => time(a) - time(b)
      || Number(a.direction === "in") - Number(b.direction === "in") || a.transaction_id.localeCompare(b.transaction_id));
  for (const tx of movements) {
    const amount = pence(tx.amount_gbp);
    if (amount === undefined) return undefined;
    const debit = tx.transaction_id === payout.transaction_id ? Math.max(0, amount - coveredPayout) : amount;
    available += tx.direction === "in" ? amount : -debit;
    if (!Number.isSafeInteger(available) || available < 0) return undefined;
    if (tx.direction === "in" || debit > 0) evidence.push(tx);
  }
  return evidence;
}

interface Support {
  readonly tx: BankTransaction;
  readonly explanation: Explanation;
}

type IncidentalAssessment = { status: "covered"; fact: string; evidence: string[] }
  | { status: "unresolved"; reconciled: string; residual: BankTransaction[]; evidence: string[] };

/**
 * A documented main flow can account for what made TM02 fire without assigning a purpose to every
 * transaction attached to the alert. Require a reconciled pair or collection, not merely one covered leg.
 */
export function incidentalEmoneyMovements(
  pack: InstitutionCasePack, txs: readonly BankTransaction[], open: readonly BankTransaction[], explained: readonly Support[],
  isCrypto: (tx: BankTransaction) => boolean,
): IncidentalAssessment | undefined {
  if (pack.caseRecord.institution !== "emoney") return undefined;
  const wallet = txs[0]?.account_id;
  if (typeof wallet !== "string" || !wallet || txs.some((tx) => tx.account_id !== wallet || pence(tx.amount_gbp) === undefined)) return undefined;
  const residualOut = open.filter((tx) => tx.direction === "out");
  const residualIn = open.filter((tx) => tx.direction === "in");
  if (!residualOut.length || !residualOut.every((tx) => everydayChannel(tx) && !isCrypto(tx)) || sum(residualIn) >= minimumIncoming) return undefined;
  // These small credits may be background top-ups; a name is not documentary proof of ownership.
  if (residualIn.some((tx) => !sameName(tx.counterparty_name, pack.customer.name)
    || !domestic(tx) || tx.channel !== "faster_payment")) return undefined;

  const payouts = explained.filter(({ tx }) => tx.direction === "out");
  const credits = explained.filter(({ tx }) => tx.direction === "in");
  if (payouts.length !== 1 || !credits.length) return undefined;
  const [{ tx: payout, explanation }] = payouts;
  const coreOut = amountOf(payout);
  const residualPaid = sum(residualOut);
  // At least the policy's 80% share of flagged payouts must be documented. The residual must also
  // fall short of the £1,600 minimum payout that can participate in a separate qualifying flow.
  if (!explanation.docs.length || coreOut < minimumOnward
    || !atLeast80Percent(coreOut, coreOut + residualPaid) || residualPaid >= minimumOnward) return undefined;

  const docTypes = new Map(pack.documents.map(({ metadata }) => [metadata.doc_id, metadata.type]));
  const onlyCredit = credits.length === 1 ? credits[0] : undefined;
  let principalCredits: readonly BankTransaction[];
  let contribution: BankTransaction | undefined;
  if (explanation.code === "COLLECTION_DOCUMENTED" && credits.every(({ tx, explanation: credit }) =>
    time(tx) <= time(payout) && credit.code === "COLLECTION_DOCUMENTED"
    && credit.docs.some((id) => explanation.docs.includes(id) && docTypes.get(id) === "booking_confirmation"))) {
    // A booking schedules the collected contributions as a batch, not a series of unrelated payouts.
    principalCredits = credits.map(({ tx }) => tx);
  } else if (onlyCredit && explanation.code === "OWN_ACCOUNT" && onlyCredit.explanation.code === "OWN_ACCOUNT"
    && onlyCredit.explanation.docs.length && amountOf(onlyCredit.tx) === coreOut && precedesWithin48h(onlyCredit.tx, payout)) {
    principalCredits = [onlyCredit.tx];
  } else if (onlyCredit && explanation.docs.some((id) => docTypes.get(id) === "holding_deposit_receipt")
    && onlyCredit.explanation.docs.some((id) => docTypes.get(id) === "deposit_return_letter")
    && precedesWithin48h(onlyCredit.tx, payout)) {
    const difference = coreOut - amountOf(onlyCredit.tx);
    const matches = residualIn.filter((tx) => amountOf(tx) === difference && precedesWithin48h(tx, payout));
    if (difference < 0 || (difference > 0 && matches.length !== 1)) return undefined;
    contribution = difference > 0 ? matches[0] : undefined;
    principalCredits = contribution ? [onlyCredit.tx, contribution] : [onlyCredit.tx];
  } else return undefined;

  const coreIn = sum(principalCredits);
  if (coreIn < minimumIncoming || !atLeast80Percent(coreIn, sum(txs.filter((tx) => tx.direction === "in")))
    || !atLeast80Percent(coreOut, coreIn)) return undefined;

  const first = Math.min(...txs.map(time));
  const accountActivity = [...new Map([...pack.priorTransactions, ...pack.windowTransactions, ...txs]
    .filter((tx) => tx.account_id === wallet).map((tx) => [tx.transaction_id, tx])).values()];
  const history = accountActivity.filter((tx) => !isCrypto(tx));
  const comparisons: BankTransaction[] = [];
  const unmatched: BankTransaction[] = [];
  for (const channel of new Set(residualOut.map((tx) => tx.channel))) {
    const activity = residualOut.filter((tx) => tx.channel === channel);
    const prior = priorComparable(history, channel, first, sum(activity));
    if (prior) comparisons.push(...prior);
    else unmatched.push(...activity);
  }
  const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
  const topUp = contribution ? ` (including a ${gbp.format(amountOf(contribution) / 100)} top-up in the customer's name)` : "";
  const reconciled = `TM02 centres on ${gbp.format(coreIn / 100)} received${topUp} and the documented ${gbp.format(coreOut / 100)} payout`;
  const baseEvidence = [...residualOut, ...comparisons, ...(contribution ? [contribution] : [])].map((tx) => tx.transaction_id);
  if (!unmatched.length) return {
    status: "covered",
    fact: `${reconciled}; the other ${gbp.format(residualPaid / 100)} paid out fits prior activity on the same channels and is too small to trigger TM02 separately`,
    evidence: baseEvidence,
  };

  // Over the channel baseline is not automatically part of the alerted flow. Use the stronger
  // combination of recurring recipients and enough separate funds, after every intervening debit.
  const recipients = recurringRecipients(unmatched, history, [...principalCredits, payout], first);
  const funds = recipients && separateFunding(accountActivity, residualIn.filter((tx) => tx !== contribution), residualOut, principalCredits, payout);
  if (recipients && funds) return {
    status: "covered",
    fact: `${reconciled}; the ${gbp.format(sum(unmatched) / 100)} in wallet payments above prior volume went to recurring recipients, and ${gbp.format(sum(funds.filter((tx) => tx.direction === "in")) / 100)} in earlier own-name top-ups could cover the residual payments and other debits without drawing on those receipts`,
    evidence: [...baseEvidence, ...recipients.map((tx) => tx.transaction_id), ...funds.map((tx) => tx.transaction_id)],
  };
  return {
    status: "unresolved", reconciled, residual: unmatched,
    evidence: [...baseEvidence, ...explained.flatMap(({ tx, explanation }) => [tx.transaction_id, ...explanation.docs, ...explanation.related])],
  };
}
