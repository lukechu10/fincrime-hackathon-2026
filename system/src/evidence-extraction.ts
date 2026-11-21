export interface EvidenceSource {
  readonly docId: string;
  readonly line: number;
  readonly excerpt: string;
}

export interface Money {
  readonly currency: "GBP";
  readonly minorUnits: number;
}

const invoiceFields = {
  "bill to": "billedTo", buyer: "buyer", customer: "customer", patient: "patient",
  supplier: "supplier", carrier: "carrier", description: "description", goods: "goods",
  service: "service", treatment: "treatment", vehicle: "vehicle", terms: "terms",
} as const;
const statementFields = {
  "account holder": "accountHolder", "account holders": "accountHolders",
  "account name": "accountName", bank: "bank", account: "account",
} as const;
const companyFields = {
  company: "company", "company number": "companyNumber", "registered office": "registeredOffice",
  "nature of business": "natureOfBusiness", status: "companyStatus",
} as const;
const invoiceAmounts = {
  "amount due": "amountDue", amount: "amount", total: "total",
  price: "price", "paid by bank transfer": "amountPaidByTransfer",
} as const;

type ValueOf<T> = T[keyof T];
type TextField = ValueOf<typeof invoiceFields> | ValueOf<typeof statementFields>
  | ValueOf<typeof companyFields> | "title" | "payee" | "paymentDestination" | "invoiceNumber"
  | "exporter" | "person" | "role" | "birthDetail" | "control" | "movementDetails";
type DateField = "documentDate" | "incorporationDate" | "dissolutionDate" | "invoiceDate"
  | "movementDate" | "appointedDate" | "resignedDate" | "notifiedDate" | "ceasedDate";
type AmountField = ValueOf<typeof invoiceAmounts>;

export type EvidenceFact =
  | { readonly field: TextField | DateField; readonly value: string; readonly source: EvidenceSource }
  | { readonly field: AmountField; readonly value: Money; readonly source: EvidenceSource };

export interface EvidenceEntry {
  readonly kind: "invoiceLine" | "statementMovement" | "companyOfficer" | "significantControl";
  readonly facts: readonly EvidenceFact[];
}

export interface EvidenceExtraction {
  readonly kind: "invoice" | "bankStatement" | "companyRegister" | "unparsed";
  readonly facts: readonly EvidenceFact[];
  readonly entries: readonly EvidenceEntry[];
}

const invoiceTypes = new Set([
  "invoice", "dealer_invoice", "hospital_invoice", "supplier_invoice", "supplier_invoices",
  "carrier_invoice", "freight_invoices",
]);
const registerTypes = new Set(["company_register_extract", "significant_control_register"]);
const months = "January February March April May June July August September October November December".split(" ");
const gbpNumber = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?`;

function parseGbp(text: string): Money | undefined {
  const match = new RegExp(`^£\\s*(${gbpNumber})$`).exec(text);
  if (!match) return;
  const [pounds, pence = "00"] = match[1].replaceAll(",", "").split(".");
  const minorUnits = Number(pounds + pence);
  if (Number.isSafeInteger(minorUnits)) return { currency: "GBP", minorUnits };
}

function parseDate(text: string): string | undefined {
  const named = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(text);
  let normalized = text;
  if (named) {
    const [, day, name, year] = named;
    const month = months.findIndex((m) => m.toLowerCase() === name.toLowerCase()) + 1;
    if (!month) return;
    normalized = `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return;
  }
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized) return normalized;
}

function textFact(out: EvidenceFact[], field: TextField | DateField, value: string | undefined, source: EvidenceSource): void {
  if (value && value !== "—" && value !== "-") out.push({ field, value, source });
}

function dateFact(out: EvidenceFact[], field: DateField, value: string | undefined, source: EvidenceSource): void {
  textFact(out, field, value && parseDate(value), source);
}

function amountFact(out: EvidenceFact[], field: AmountField, value: string | undefined, source: EvidenceSource): void {
  const normalized = value && parseGbp(value);
  if (normalized) out.push({ field, value: normalized, source });
}

function lookup<T extends Record<string, string>>(map: T, key: string): T[keyof T] | undefined {
  return Object.hasOwn(map, key) ? map[key as keyof T] : undefined;
}

function tableEntry(kind: EvidenceExtraction["kind"], cells: readonly string[], headers: readonly string[], source: EvidenceSource): EvidenceEntry | undefined {
  if (cells.length !== headers.length) return;
  const get = (label: string) => cells[headers.indexOf(label)];
  const facts: EvidenceFact[] = [];
  if (kind === "invoice" && headers.includes("invoice") && headers.includes("amount")) {
    textFact(facts, "invoiceNumber", get("invoice"), source);
    dateFact(facts, "invoiceDate", get("dated"), source);
    textFact(facts, "goods", get("goods"), source);
    textFact(facts, "exporter", get("exporter"), source);
    amountFact(facts, "amount", get("amount"), source);
    return { kind: "invoiceLine", facts };
  }
  if (kind !== "companyRegister") return;
  const isOfficer = headers.includes("officer") && headers.includes("role");
  const isControl = headers.includes("control") && (headers.includes("person") || headers.includes("person with significant control"));
  if (!isOfficer && !isControl) return;
  textFact(facts, "person", get("officer") ?? get("person with significant control") ?? get("person"), source);
  textFact(facts, "role", get("role"), source);
  // Birth details may be a year or month/year, not an exact date.
  textFact(facts, "birthDetail", get("born"), source);
  textFact(facts, "control", get("control"), source);
  dateFact(facts, "appointedDate", get("appointed"), source);
  dateFact(facts, "resignedDate", get("resigned"), source);
  dateFact(facts, "notifiedDate", get("notified"), source);
  dateFact(facts, "ceasedDate", get("ceased"), source);
  return { kind: isOfficer ? "companyOfficer" : "significantControl", facts };
}

function invoicePayTo(facts: EvidenceFact[], value: string, source: EvidenceSource): void {
  const account = /^(.*?),\s*(account\s+.+|IBAN\s+.+)$/i.exec(value);
  if (account) {
    textFact(facts, "payee", account[1], source);
    textFact(facts, "paymentDestination", account[2], source);
  } else if (/^(IBAN|account)\b/i.test(value)) {
    textFact(facts, "paymentDestination", value, source);
  } else {
    textFact(facts, "payee", value, source);
  }
}

export function extractEvidence(docId: string, type: string, markdown: string): EvidenceExtraction {
  const kind = invoiceTypes.has(type) ? "invoice" : type === "bank_statement" ? "bankStatement"
    : registerTypes.has(type) ? "companyRegister" : "unparsed";
  const facts: EvidenceFact[] = [];
  const entries: EvidenceEntry[] = [];
  if (kind === "unparsed") return { kind, facts, entries };

  const movementAmount = new RegExp(`^(?:transfer of\\s+|received\\s+)?(£\\s*${gbpNumber})(?=\\s|$)`, "i");
  let headers: string[] | undefined;
  const lines = markdown.split(/\r?\n/);
  for (const [i, excerpt] of lines.entries()) {
    const line = excerpt.trim();
    const source = { docId, line: i + 1, excerpt };
    if (line.startsWith("|") && line.endsWith("|")) {
      const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
      const separator = lines[i + 1]?.trim();
      if (separator && /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(separator)) {
        headers = cells.map((cell) => cell.toLowerCase());
      } else if (headers && !/^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line)) {
        const entry = tableEntry(kind, cells, headers, source);
        if (entry?.facts.length) entries.push(entry);
      }
      continue;
    }
    headers = undefined;
    const heading = /^#\s+(.+)$/.exec(line);
    if (heading) textFact(facts, "title", heading[1], source);

    const field = /^\*\*([^*]+):\*\*\s*(.+)$/.exec(line);
    if (field) {
      const label = field[1].toLowerCase();
      const value = field[2];
      if (label === "dated") dateFact(facts, "documentDate", value, source);
      if (kind === "invoice") {
        const textKey = lookup(invoiceFields, label);
        const amountKey = lookup(invoiceAmounts, label);
        if (textKey) textFact(facts, textKey, value, source);
        if (amountKey) amountFact(facts, amountKey, value, source);
        if (label === "pay to") invoicePayTo(facts, value, source);
      } else if (kind === "bankStatement") {
        const key = lookup(statementFields, label);
        if (key) textFact(facts, key, value, source);
      } else {
        const key = lookup(companyFields, label);
        if (key) textFact(facts, key, value, source);
        if (label === "incorporated") dateFact(facts, "incorporationDate", value, source);
        if (label === "status" && /^dissolved on /i.test(value)) {
          dateFact(facts, "dissolutionDate", value.slice("dissolved on ".length), source);
        }
      }
    } else if (kind === "bankStatement") {
      const movement = /^([^:]+):\s+(.+)$/.exec(line);
      if (!movement) continue;
      const date = parseDate(movement[1]);
      const amount = movementAmount.exec(movement[2]);
      if (!date || !amount) continue;
      const movementFacts: EvidenceFact[] = [];
      textFact(movementFacts, "movementDate", date, source);
      amountFact(movementFacts, "amount", amount[1], source);
      textFact(movementFacts, "movementDetails", movement[2], source);
      entries.push({ kind: "statementMovement", facts: movementFacts });
    }
  }
  return { kind, facts, entries };
}
