/** Diagnostics go to stderr so they never mix with the JSONL output. */
export function warn(message: string): void {
  process.stderr.write(`run: warning: ${message}\n`);
}

/** File text without a leading UTF-8 byte-order mark, which JSON.parse would reject. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
