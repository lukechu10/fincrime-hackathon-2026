import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadInstitutionCases, type CaseStub, type InstitutionCasePack } from "./bank-cases.js";
import { decideCase, reasonCodes, type CaseDecision } from "./decision.js";
import { warn } from "./diagnostics.js";
import { findingsFor, planTasks, readAll, type Task } from "./llm/fallback.js";
import { openRouterReader, type DocumentReader } from "./llm/openrouter.js";

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

export interface RunOptions {
  /** Reads documents the parsers could not use. Defaults to OpenRouter when OPENROUTER_API_KEY is set; null disables it. */
  readonly reader?: DocumentReader | null;
}

/** The fallback reader for this run, if the evaluator supplied a key. */
function defaultReader(): DocumentReader | undefined {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  // OPENROUTER_MODEL overrides the pinned model, e.g. to try a free model during development.
  const model = process.env.OPENROUTER_MODEL?.trim() || undefined;
  return apiKey ? openRouterReader({ apiKey, model }) : undefined;
}

export async function runSubmission(input: string, output: string, options: RunOptions = {}): Promise<void> {
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
  const cases = loadInstitutionCases(inputRoot);
  const results: CaseDecision[] = [];
  const open: { index: number; pack: InstitutionCasePack; tasks: Task[] }[] = [];
  const reader = options.reader === undefined ? defaultReader() : options.reader ?? undefined;
  let fallbacks = 0;
  // First pass: the deterministic decision for every case.
  for (const id of cases.caseIds) {
    let result: CaseDecision;
    try {
      const pack = cases.get(id);
      result = decideCase(pack);
      verify(pack, result);
      const tasks = reader ? planTasks(pack, result) : [];
      if (tasks.length) open.push({ index: results.length, pack, tasks });
    } catch (error) {
      // One bad case must not cost the whole institution: escalate it and carry on.
      warn(`${error instanceof Error ? error.message : String(error)}; escalating ${id}`);
      result = fallbackDecision(cases.stub(id) ?? { case_id: id, alert_ids: [] });
      fallbacks++;
    }
    results.push(result);
  }
  if (fallbacks) warn(`${fallbacks} of ${results.length} cases could not be assessed and were escalated`);
  // Second pass, only with a key: read the documents no parser used, then decide those cases again with the checked facts.
  if (reader && open.length) {
    const answers = await readAll(open.flatMap(({ pack, tasks }) => tasks.map((task) => ({ task, customerName: pack.customer.name }))), reader);
    let changed = 0;
    for (const { index, pack, tasks } of open) {
      try {
        const findings = findingsFor(pack, tasks, answers);
        if (!findings.explanations.length && !findings.signals.length) continue;
        const revised = decideCase(pack, findings);
        verify(pack, revised);
        if (revised.verdict !== results[index].verdict || revised.reason_code !== results[index].reason_code) changed++;
        results[index] = revised;
      } catch (error) {
        warn(`${pack.caseRecord.case_id}: fallback findings not used (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    warn(`fallback reader: ${open.length} cases had unread documents; ${changed} changed verdict or reason code; ${reader.summary()}`);
  }
  const lines = results.map((result) => JSON.stringify(result));
  // Build the full batch before touching the caller's output file.
  writeFileSync(canonical, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}
