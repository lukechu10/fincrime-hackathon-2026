import type { BankTransaction } from "./bank-cases.js";
import type { EvidenceDocument } from "./evidence.js";
import type { EvidenceEntry, EvidenceFact } from "./evidence-extraction.js";

export interface ListAssessment {
  status: "confirmed" | "different" | "unresolved";
  evidence: string[];
  detail: string;
  transactionId?: string;
}

type ListTransaction = Pick<BankTransaction, "transaction_id" | "counterparty_name" | "booked_at">;

type ListEntry = {
  entry_id: string;
  name: string;
  date_of_birth?: unknown;
  identifiers?: unknown;
  address?: unknown;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\bpublic\s+limited\s+company\b/g, "plc").replace(/\blimited\b/g, "ltd")
    .replace(/[^a-z0-9]/g, "");
}

function monthYear(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.trim();
  let match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(text);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) return `${match[1]}-${match[2]}`;
  match = /^(?:\d{1,2}\s+)?([A-Za-z]+)\s+(\d{4})$/.exec(text);
  if (!match) return;
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const index = months.indexOf(match[1].toLowerCase());
  return index < 0 ? undefined : `${match[2]}-${String(index + 1).padStart(2, "0")}`;
}

function textFacts(facts: readonly EvidenceFact[], field: EvidenceFact["field"]): string[] {
  return facts.filter((fact) => fact.field === field && typeof fact.value === "string")
    .map((fact) => fact.value as string);
}

function factIn(entry: EvidenceEntry, field: EvidenceFact["field"]): string[] {
  return textFacts(entry.facts, field);
}

function roleDates(entry: EvidenceEntry) {
  const officer = entry.kind === "companyOfficer";
  return { starts: factIn(entry, officer ? "appointedDate" : "notifiedDate"),
    ends: factIn(entry, officer ? "resignedDate" : "ceasedDate") };
}

function hasActiveRole(entry: EvidenceEntry, doc: EvidenceDocument, paymentDate: string): boolean {
  const { starts, ends } = roleDates(entry);
  if (starts.length > 1 || ends.length > 1) return false;
  // Start is inclusive; the ceased/resigned date is exclusive. Missing bounds establish
  // no activity beyond the snapshot on the unknown side of the interval.
  const start = starts[0] ?? doc.metadata.dated;
  return start <= paymentDate && (ends[0] ? paymentDate < ends[0] : paymentDate <= doc.metadata.dated);
}

function companyName(doc: EvidenceDocument): string | undefined {
  const extracted = textFacts(doc.extraction.facts, "company").find((value) => value.trim());
  if (extracted) return extracted;
  const title = doc.metadata.title.trim();
  const fromTitle = /^(?:company register extract for|register of people with significant control for)\s+(.+?)\s*$/i.exec(title);
  return fromTitle?.[1].replace(/:\s*(?:officers|directors)\s*$/i, "").trim();
}

function relevantRegister(doc: EvidenceDocument, counterparties: ReadonlySet<string>): boolean {
  if (doc.extraction.kind !== "companyRegister") return false;
  const name = companyName(doc);
  return !!name && counterparties.has(normalizedName(name));
}

function identifierValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return;
  const normalized = String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized || undefined;
}

function companyIdentifierKeys(entry: ListEntry): string[] {
  const identifiers = record(entry.identifiers);
  if (!identifiers) return [];
  return Object.keys(identifiers).filter((key) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
    return ["companynumber", "companyregistrationnumber", "registrationnumber"].includes(normalizedKey);
  });
}

function hasCompanyIdentifierMatch(entry: ListEntry, doc: EvidenceDocument): boolean {
  const identifiers = record(entry.identifiers);
  if (!identifiers) return false;
  const companyNumber = textFacts(doc.extraction.facts, "companyNumber");
  if (!companyNumber.length) return false;
  for (const [key, value] of Object.entries(identifiers)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
    if (!["companynumber", "companyregistrationnumber", "registrationnumber"].includes(normalizedKey)) continue;
    const listed = identifierValue(value);
    if (listed && companyNumber.some((number) => identifierValue(number) === listed)) return true;
  }
  return false;
}

/** Conservatively assess the one internal-list entry selected by the TM22 measurement. */
export function assessListMatch(
  alert: { measured?: unknown },
  entries: readonly ListEntry[],
  documents: readonly EvidenceDocument[],
  transactions: readonly ListTransaction[],
): ListAssessment {
  const measured = record(alert.measured);
  const selectedId = measured?.list_entry;
  if (typeof selectedId !== "string" || !selectedId.trim()) {
    return { status: "unresolved", evidence: [], detail: "The alert does not identify a usable measured.list_entry, so no list entry can be assessed." };
  }
  const listed = entries.find((entry) => entry.entry_id === selectedId);
  if (!listed) {
    return { status: "unresolved", evidence: [], detail: `The alert selects list entry ${selectedId}, but that entry is not present in the supplied list.` };
  }

  const results = transactions.map((tx) => ({
    ...assessTransaction(listed, measured?.matched_on, documents, tx), transactionId: tx.transaction_id,
  }));
  const confirmed = results.find((result) => result.status === "confirmed");
  if (confirmed) return confirmed;
  if (results.length && results.every((result) => result.status === "different")) {
    return { ...results[0], evidence: [...new Set(results.flatMap((result) => result.evidence))] };
  }
  return results.find((result) => result.status === "unresolved") ?? {
    status: "unresolved", evidence: [listed.entry_id], detail: `The selected list entry is ${listed.name}, but no flagged transaction is available to assess.`,
  };
}

function assessTransaction(listed: ListEntry, matchedOn: unknown, documents: readonly EvidenceDocument[], tx: ListTransaction): ListAssessment {
  const baseEvidence = [listed.entry_id];
  const paymentDate = tx.booked_at.slice(0, 10);
  const counterpartySet = new Set(tx.counterparty_name ? [normalizedName(tx.counterparty_name)] : []);
  const registers = documents.filter((doc) => relevantRegister(doc, counterpartySet));

  // Company identifiers are useful only when the list entry actually supplies one.
  if (companyIdentifierKeys(listed).length > 0) {
    const matchingDocs = registers.filter((doc) => hasCompanyIdentifierMatch(listed, doc));
    if (matchingDocs.length === 1) {
      const doc = matchingDocs[0];
      return {
        status: "confirmed",
        evidence: [...baseEvidence, doc.metadata.doc_id],
        detail: `The alert-selected entry ${listed.name} is corroborated by the same unique company number in the parsed register for the named counterparty; this is more than a name or premises match.`,
      };
    }
    if (matchingDocs.length > 1) {
      return { status: "unresolved", evidence: baseEvidence, detail: `More than one parsed register document appears to match the unique company identifier for ${listed.name}, so the business identity is not resolved.` };
    }
    // Do not turn a missing company-number corroboration into a different-party conclusion.
    const inspectedDocs = registers.map((doc) => doc.metadata.doc_id);
    return {
      status: "unresolved", evidence: [...baseEvidence, ...inspectedDocs],
      detail: `The selected entry ${listed.name} supplies a company identifier, but the parsed register evidence does not verify that identifier for a named counterparty; a name or premises resemblance alone is not conclusive.`,
    };
  }

  const listedName = normalizedName(listed.name);
  const listedBirth = monthYear(listed.date_of_birth);
  const relevantRows: { doc: EvidenceDocument; entry: EvidenceEntry; person: string; born: string[]; active: boolean }[] = [];
  for (const doc of registers) {
    for (const row of doc.extraction.entries) {
      if (row.kind !== "companyOfficer" && row.kind !== "significantControl") continue;
      const person = factIn(row, "person").find((value) => normalizedName(value) === listedName);
      if (!person) continue;
      const born = factIn(row, "birthDetail");
      relevantRows.push({ doc, entry: row, person, born, active: hasActiveRole(row, doc, paymentDate) });
    }
  }

  const identityRows = relevantRows.filter((row) => row.active && row.born.length > 0);
  const corroborating = identityRows.filter((row) => {
    const registerBirth = row.born.map(monthYear).filter((value): value is string => !!value);
    return listedBirth !== undefined && registerBirth.includes(listedBirth);
  });
  const conflicting = identityRows.filter((row) => {
    const registerBirth = row.born.map(monthYear).filter((value): value is string => !!value);
    return listedBirth !== undefined && registerBirth.length > 0 && registerBirth.every((value) => value !== listedBirth);
  });

  // Conflicting live register identities and matching evidence should not be forced into either verdict.
  if (corroborating.length > 0 && conflicting.length > 0) {
    return {
      status: "unresolved", evidence: baseEvidence,
      detail: `Parsed registers for the counterparty give conflicting month-and-year-of-birth evidence for ${listed.name}; the identity cannot safely be resolved.`,
    };
  }
  if (corroborating.length > 0) {
    const { doc, entry } = corroborating.find((row) => row.entry.kind === "significantControl") ?? corroborating[0];
    const { ends } = roleDates(entry);
    const role = entry.kind === "significantControl" ? "significant control" : "an active officer role";
    const until = ends[0] ? ` (ending on ${ends[0]})` : "";
    return {
      status: "confirmed", evidence: [...baseEvidence, doc.metadata.doc_id],
      detail: `Register ${doc.metadata.doc_id} matches ${listed.name}'s birth month and year to list entry ${listed.entry_id} and shows ${role} on the transaction date ${paymentDate}${until}`,
    };
  }
  if (conflicting.length > 0) {
    const docs = [...new Set(conflicting.map((row) => row.doc.metadata.doc_id))];
    return {
      status: "different", evidence: [...baseEvidence, ...docs],
      detail: `The parsed register for the named counterparty records an active role or significant control for ${listed.name}, but its month and year of birth conflicts with the selected list entry; the shared name is therefore not enough to identify the listed person.`,
    };
  }

  // An adjacent unit is not the same premises. Require independent, positive evidence
  // of a different controlling owner as well as the distinct unit, not merely a name mismatch.
  const listedUnit = typeof listed.address === "string" ? /^unit\s+([a-z0-9-]+)\s*,?\s+(.+)/i.exec(listed.address.trim()) : null;
  if (typeof matchedOn === "string" && /^registered address\b/i.test(matchedOn) && listedUnit && !relevantRows.length) {
    for (const doc of registers) {
      const office = textFacts(doc.extraction.facts, "registeredOffice");
      if (office.length !== 1) continue;
      const unit = /^unit\s+([a-z0-9-]+)\s*,?\s+(.+)/i.exec(office[0]);
      if (!unit || unit[1].toLowerCase() === listedUnit[1].toLowerCase()
        || normalizedName(unit[2]) !== normalizedName(listedUnit[2])) continue;
      const controllingOwner = doc.extraction.entries.find((row) => row.kind === "significantControl" && hasActiveRole(row, doc, paymentDate)
        && factIn(row, "person").some((name) => normalizedName(name) !== listedName)
        && factIn(row, "control").some((description) => /\b75% or more of (?:the )?shares\b/i.test(description)));
      if (!controllingOwner) continue;
      const controller = factIn(controllingOwner, "person")[0];
      return { status: "different", evidence: [...baseEvidence, doc.metadata.doc_id],
        detail: `Register ${doc.metadata.doc_id} locates ${companyName(doc)} at Unit ${unit[1]}, not the listed Unit ${listedUnit[1]}, and records ${controller} as holding at least 75% of its shares` };
    }
  }

  if (relevantRows.length > 0 && !listedBirth) {
    const docs = [...new Set(relevantRows.map((row) => row.doc.metadata.doc_id))];
    return {
      status: "unresolved", evidence: [...baseEvidence, ...docs],
      detail: `A parsed register for the named counterparty contains ${listed.name}, but the selected list entry has no usable date of birth for comparison; name and role alone do not establish identity.`,
    };
  }
  if (relevantRows.length > 0) {
    const docs = [...new Set(relevantRows.map((row) => row.doc.metadata.doc_id))];
    return {
      status: "unresolved", evidence: [...baseEvidence, ...docs],
      detail: `A parsed register for the named counterparty contains ${listed.name}, but it does not establish a matching birth month and year in a role or control record active on ${paymentDate}; the list match remains undecided.`,
    };
  }

  return {
    status: "unresolved", evidence: baseEvidence,
    detail: `The selected list entry is ${listed.name}. The supplied parsed register evidence does not independently link that identity to a named counterparty, and a name or premises match alone is not conclusive.`,
  };
}
