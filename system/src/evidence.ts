import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stripBom, warn } from "./diagnostics.js";
import { extractEvidence, type EvidenceExtraction } from "./evidence-extraction.js";

export interface EvidenceMetadata {
  readonly doc_id: string;
  readonly customer_id: string;
  readonly type: string;
  readonly title: string;
  readonly dated: string;
  readonly file: string;
}

export interface EvidenceDocument {
  readonly metadata: EvidenceMetadata;
  readonly markdown: string;
  readonly extraction: EvidenceExtraction;
}

export interface EvidenceIndex {
  /** All metadata rows for this customer, in evidence.jsonl order. */
  metadataForCustomer(customerId: string): readonly EvidenceMetadata[];
  /** Read and extract only on first access; undefined means no such metadata row. */
  get(docId: string): EvidenceDocument | undefined;
  /** Load this customer's documents only. The caller still decides case relevance. */
  documentsForCustomer(customerId: string): readonly EvidenceDocument[];
  /** Customers named by a metadata row that could not be used; their evidence pack is incomplete. */
  readonly damagedCustomers: ReadonlySet<string>;
}

function isMetadata(value: unknown): value is EvidenceMetadata {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (["doc_id", "customer_id", "type", "title", "dated", "file"] as const).every((key) => {
    const field = row[key];
    return typeof field === "string" && field.trim().length > 0;
  });
}

function within(base: string, file: string): boolean {
  const rel = relative(base, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function loadEvidenceIndex(institutionDir: string): EvidenceIndex {
  const root = realpathSync(institutionDir);
  const indexFile = realpathSync(resolve(root, "evidence.jsonl"));
  if (!within(root, indexFile)) throw new Error("evidence.jsonl resolves outside the institution directory");
  const evidenceDir = resolve(root, "evidence");
  const rows = new Map<string, EvidenceMetadata>();
  const customers = new Map<string, EvidenceMetadata[]>();
  const cache = new Map<string, EvidenceDocument>();

  // A bad metadata row is skipped with a warning; a customer it still names is marked damaged so their cases
  // are escalated rather than decided without that document.
  const damagedCustomers = new Set<string>();
  const markDamaged = (row: unknown) => {
    const customer = typeof row === "object" && row !== null ? (row as Record<string, unknown>).customer_id : undefined;
    if (typeof customer === "string" && customer.trim()) damagedCustomers.add(customer);
  };
  for (const [i, line] of stripBom(readFileSync(indexFile, "utf8")).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const location = `${indexFile}:${i + 1}`;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      warn(`${location}: skipped invalid JSON`);
      continue;
    }
    if (!isMetadata(row)) { warn(`${location}: skipped invalid evidence metadata`); markDamaged(row); continue; }
    const first = rows.get(row.doc_id);
    if (first) { warn(`${location}: skipped duplicate evidence ID ${row.doc_id}`); markDamaged(row); markDamaged(first); continue; }
    if (isAbsolute(row.file) || !row.file.endsWith(".md") || !within(evidenceDir, resolve(root, row.file))) {
      warn(`${location}: skipped ${row.doc_id}, which is not a relative Markdown path under evidence/`);
      markDamaged(row);
      continue;
    }
    rows.set(row.doc_id, row);
    const documents = customers.get(row.customer_id) ?? [];
    documents.push(row);
    customers.set(row.customer_id, documents);
  }

  function load(row: EvidenceMetadata): EvidenceDocument {
    const existing = cache.get(row.doc_id);
    if (existing) return existing;
    let markdown: string;
    try {
      const file = realpathSync(resolve(root, row.file));
      if (!within(evidenceDir, file)) throw new Error("document resolves outside the evidence directory");
      markdown = stripBom(readFileSync(file, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read evidence ${row.doc_id} (${row.file}): ${message}`, { cause: error });
    }
    const document = { metadata: row, markdown, extraction: extractEvidence(row.doc_id, row.type, markdown) };
    cache.set(row.doc_id, document);
    return document;
  }

  return {
    metadataForCustomer: (customerId) => [...(customers.get(customerId) ?? [])],
    get: (docId) => {
      const row = rows.get(docId);
      return row && load(row);
    },
    documentsForCustomer: (customerId) => (customers.get(customerId) ?? []).map(load),
    damagedCustomers,
  };
}
