import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadInstitutionCases, type InstitutionCasePack } from "./bank-cases.js";
import { decideCase, reasonCodes, type CaseDecision } from "./decision.js";

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

export function runSubmission(input: string, output: string): void {
  const target = resolve(output);
  const canonical = join(realpathSync(dirname(target)), basename(target));
  const inputRoot = realpathSync(input);
  const sub = relative(inputRoot, canonical);
  if (!sub || (sub !== ".." && !sub.startsWith(`..${sep}`) && !isAbsolute(sub))) {
    throw new Error("Output must not overwrite or be placed inside the supplied institution directory");
  }
  const existing = lstatSync(canonical, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.nlink > 1)) {
    throw new Error("Output path must be a regular, unshared file");
  }
  const reader = loadInstitutionCases(inputRoot);
  const lines: string[] = [];
  for (const id of reader.caseIds) {
    const pack = reader.get(id);
    const result = decideCase(pack);
    verify(pack, result);
    lines.push(JSON.stringify(result));
  }
  // Validate the full batch before touching the caller's output file.
  writeFileSync(canonical, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}
