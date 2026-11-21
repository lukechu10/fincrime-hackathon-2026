import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadInstitutionCases, type CaseStub, type InstitutionCasePack } from "./bank-cases.js";
import { decideCase, reasonCodes, type CaseDecision } from "./decision.js";
import { warn } from "./diagnostics.js";

function verify(pack: InstitutionCasePack, result: CaseDecision): void {
  const { case_id, alert_ids } = pack.caseRecord;
  if (result.case_id !== case_id || result.alert_ids.length !== alert_ids.length
    || alert_ids.some((id, i) => result.alert_ids[i] !== id)) {
    throw new Error(`${case_id}: incorrect case or alert coverage`);
  }
  const allowedCodes: readonly string[] = reasonCodes[result.verdict];
  if (!allowedCodes?.includes(result.reason_code) || !result.reason.trim()) {
    throw new Error(`${case_id}: invalid verdict, reason code, or explanation`);
  }
  const validEvidence = new Set([
    ...pack.flaggedTransactions.map((row) => row.transaction_id),
    ...pack.windowTransactions.map((row) => row.transaction_id),
    ...pack.priorTransactions.map((row) => row.transaction_id),
    ...(pack.heldPayment ? [pack.heldPayment.transaction_id] : []),
    ...pack.documents.map((doc) => doc.metadata.doc_id),
    ...pack.internalList.map((row) => row.entry_id),
  ]);
  if (new Set(result.evidence).size !== result.evidence.length || result.evidence.some((id) => !validEvidence.has(id))) {
    throw new Error(`${case_id}: invalid evidence reference`);
  }
}

/**
 * The verdict for a case that could not be assessed: unreadable or inconsistent input, or an internal error.
 * A missing case already counts as an escalation, so escalating keeps every case in the file without
 * claiming more than the system knows, and without contacting the customer.
 */
export function fallbackDecision(stub: CaseStub): CaseDecision {
  return {
    case_id: stub.case_id, alert_ids: [...stub.alert_ids], verdict: "ESCALATE", reason_code: "ESC_UNEXPLAINED_FUNDS",
    reason: "The automated review could not assess this case because some of its input records could not be read or checked. "
      + "Without them the flagged activity is not shown to be explained, so refer the case to the MLRO for manual review without contacting the customer.",
    evidence: [],
  };
}

const inside = (base: string, path: string) => {
  const sub = relative(base, path);
  return !sub || (sub !== ".." && !sub.startsWith(`..${sep}`) && !isAbsolute(sub));
};

export function runSubmission(input: string, output: string): void {
  const target = resolve(output);
  const inputRoot = realpathSync(input);
  const refuse = () => new Error("Output must not overwrite or be placed inside the supplied institution directory");
  // Check before creating any missing output folders, then again once symlinks can be resolved.
  if (inside(resolve(input), target) || inside(inputRoot, target)) throw refuse();
  mkdirSync(dirname(target), { recursive: true });
  const canonical = join(realpathSync(dirname(target)), basename(target));
  if (inside(inputRoot, canonical)) throw refuse();
  const existing = lstatSync(canonical, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.nlink > 1)) {
    throw new Error("Output path must be a regular, unshared file");
  }
  const reader = loadInstitutionCases(inputRoot);
  const lines: string[] = [];
  let fallbacks = 0;
  for (const id of reader.caseIds) {
    let result: CaseDecision;
    try {
      const pack = reader.get(id);
      result = decideCase(pack);
      verify(pack, result);
    } catch (error) {
      // One bad case must not cost the whole institution: escalate it and carry on.
      warn(`${error instanceof Error ? error.message : String(error)}; escalating ${id}`);
      result = fallbackDecision(reader.stub(id) ?? { case_id: id, alert_ids: [] });
      fallbacks++;
    }
    lines.push(JSON.stringify(result));
  }
  if (fallbacks) warn(`${fallbacks} of ${lines.length} cases could not be assessed and were escalated`);
  // Build the full batch before touching the caller's output file.
  writeFileSync(canonical, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}
