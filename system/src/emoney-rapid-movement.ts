import type { BankTransaction, InstitutionCasePack } from "./bank-cases.js";
import type { Explanation } from "./explanations.js";
import { looksLikeOrganization, pence, sameName } from "./text.js";

const dayMs = 86_400_000;
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

interface Support {
  readonly tx: BankTransaction;
  readonly explanation: Explanation;
}

/**
 * A documented main flow can account for what made TM02 fire without assigning a purpose to every
 * transaction attached to the alert. Require a reconciled pair or collection, not merely one covered leg.
 */
export function incidentalEmoneyMovements(
  pack: InstitutionCasePack, txs: readonly BankTransaction[], open: readonly BankTransaction[], explained: readonly Support[],
  isCrypto: (tx: BankTransaction) => boolean,
): { fact: string; evidence: string[] } | undefined {
  if (pack.caseRecord.institution !== "emoney") return undefined;
  const wallet = txs[0]?.account_id;
  if (typeof wallet !== "string" || !wallet || txs.some((tx) => tx.account_id !== wallet)) return undefined;
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
  const history = [...pack.priorTransactions, ...pack.windowTransactions].filter((tx) => tx.account_id === wallet && !isCrypto(tx));
  const comparisons: BankTransaction[] = [];
  for (const channel of new Set(residualOut.map((tx) => tx.channel))) {
    const prior = priorComparable(history, channel, first, sum(residualOut.filter((tx) => tx.channel === channel)));
    if (!prior) return undefined;
    comparisons.push(...prior);
  }
  const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
  const topUp = contribution ? ` (including a ${gbp.format(amountOf(contribution) / 100)} top-up in the customer's name)` : "";
  return {
    fact: `TM02 centres on ${gbp.format(coreIn / 100)} received${topUp} and the documented ${gbp.format(coreOut / 100)} payout; the other ${gbp.format(residualPaid / 100)} paid out fits prior activity on the same channels and is too small to trigger TM02 separately`,
    evidence: [...residualOut, ...comparisons, ...(contribution ? [contribution] : [])].map((tx) => tx.transaction_id),
  };
}
