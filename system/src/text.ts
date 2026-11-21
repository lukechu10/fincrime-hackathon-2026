/** Shared, deliberately literal helpers for reading generated Markdown evidence. */
import type { BankTransaction } from "./bank-cases.js";

export const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"] as const;

/** Lower-case, accent-free, apostrophe-normalized and whitespace-collapsed text. */
export function norm(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

/** Comparison key for party names: ignores case, punctuation and Limited/Ltd spelling. */
export function nameKey(value: string): string {
  return norm(value).replace(/\bpublic limited company\b/g, "plc").replace(/\blimited\b/g, "ltd")
    .replace(/&/g, " and ").replace(/[^a-z0-9]/g, "");
}

export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && !!nameKey(a) && nameKey(a) === nameKey(b);
}

export function surname(name: string): string {
  const parts = norm(name).split(" ");
  return parts[parts.length - 1] ?? "";
}

const MONEY = /£\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)/g;

/** Every £ amount in the text, in pence, in order of appearance. */
export function poundsIn(text: string): number[] {
  return [...text.matchAll(MONEY)].flatMap((match) => {
    const [whole, fraction = ""] = match[1].replaceAll(",", "").split(".");
    const pence = Number(whole + fraction.padEnd(2, "0"));
    return Number.isSafeInteger(pence) ? [pence] : [];
  });
}

/** The single distinct £ amount in the text, or undefined when there are none or several. */
export function onlyPounds(text: string): number | undefined {
  const amounts = [...new Set(poundsIn(text))];
  return amounts.length === 1 ? amounts[0] : undefined;
}

export function pounds(text: string | undefined): number | undefined {
  return text === undefined ? undefined : poundsIn(text)[0];
}

/** Transaction amount in pence, or undefined for values that are not whole pence. */
export function pence(amount: number): number | undefined {
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  const value = parts && Number(parts[1] + (parts[2] ?? "").padEnd(2, "0"));
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function samePence(tx: BankTransaction, amount: number | undefined): boolean {
  return amount !== undefined && amount > 0 && pence(tx.amount_gbp) === amount;
}

/** "12 August 2026" (or an ISO date) to YYYY-MM-DD, validated. */
export function isoDay(text: string | undefined): string | undefined {
  if (!text) return;
  const value = text.trim();
  let iso = value;
  const named = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/.exec(value);
  if (named) {
    const month = MONTHS.indexOf(named[2].toLowerCase() as typeof MONTHS[number]) + 1;
    if (!month) return;
    iso = `${named[3]}-${String(month).padStart(2, "0")}-${named[1].padStart(2, "0")}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : undefined;
}

/** "July 2026" to "2026-07". */
export function isoMonth(text: string | undefined): string | undefined {
  const match = text && /^([A-Za-z]+)\s+(\d{4})$/.exec(text.trim());
  if (!match) return;
  const month = MONTHS.indexOf(match[1].toLowerCase() as typeof MONTHS[number]) + 1;
  return month ? `${match[2]}-${String(month).padStart(2, "0")}` : undefined;
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export const txDay = (tx: BankTransaction) => tx.booked_at.slice(0, 10);

/** Values of `**Label:** value` lines, including bulleted variants; the label match is case-insensitive. */
export function fields(markdown: string, label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...markdown.matchAll(new RegExp(`^[ \\t]*(?:[*-][ \\t]+)?\\*\\*${escaped}:\\*\\*[ \\t]*(.+?)[ \\t]*$`, "gim"))]
    .map((match) => match[1].trim());
}

export function field(markdown: string, label: string): string | undefined {
  const values = [...new Set(fields(markdown, label))];
  return values.length === 1 ? values[0] : undefined;
}

export function title(markdown: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1].trim() ?? "";
}

/** Rows of the first Markdown table whose (lower-cased) headers include all of `required`. */
export function tableRows(markdown: string, required: readonly string[]): Record<string, string>[] {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim());
  const cells = (line: string) => line.slice(1, -1).split("|").map((cell) => cell.trim());
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].startsWith("|") || !/^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(lines[i + 1])) continue;
    const headers = cells(lines[i]).map((header) => header.toLowerCase());
    if (!required.every((header) => headers.includes(header))) continue;
    const rows: Record<string, string>[] = [];
    for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j++) {
      const row = cells(lines[j]);
      if (row.length !== headers.length) continue;
      rows.push(Object.fromEntries(headers.map((header, k) => [header, row[k]])));
    }
    return rows;
  }
  return [];
}

/**
 * Comparison key for an account reference. Full UK sort code and account numbers compare on digits,
 * IBANs on their characters, and masked references only to the same masked form.
 */
export function accountKey(value: string | null | undefined): string | undefined {
  if (!value) return;
  const text = value.trim().replace(/^(?:account|acct)\s+(?:number\s+)?/i, "");
  const ending = /^(?:(?:iban|account)\s+)?ending\s+([A-Z0-9]{3,6})$/i.exec(text);
  if (ending) return `ending:${ending[1].toUpperCase()}`;
  const compact = text.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{14}$/.test(compact) || /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return compact;
}

export function sameAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = accountKey(a);
  return !!left && left === accountKey(b);
}

const COMPANY = /\b(?:ltd|limited|llp|plc|inc|co|corp|corporation|company|gmbh|bv|nv|srl|sarl|sal|fze|llc|sa|spa|ag|sp\.? z o\.?o\.?|bank|banco|exchange|council|trust|group|holdings|services|partners|ventures|finance|insurance|assurance|society|university|hospital|clinic|school|homes|lettings|travel|motors)\b/i;
/** True when a counterparty name looks like an organization rather than a private individual. */
export function looksLikeOrganization(name: string | null | undefined): boolean {
  return !!name && COMPANY.test(name);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const HIGHER_RISK_COUNTRIES = new Set(["afghanistan", "belarus", "democratic republic of the congo", "haiti",
  "iran", "iraq", "lebanon", "libya", "mali", "myanmar", "north korea", "russia", "somalia", "south sudan", "syria",
  "venezuela", "yemen"]);
