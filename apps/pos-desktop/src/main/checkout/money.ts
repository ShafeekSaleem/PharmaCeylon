/** LKR as integer minor units; the server speaks two-decimal strings. */
export function toMinor(amount: string): number {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) throw new Error(`Not a money amount: ${amount}`);
  const minor = Number(match[2]) * 100 + Number((match[3] ?? "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error("Amount out of range");
  return match[1] ? -minor : minor;
}

export function fromMinor(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error("Amount out of range");
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
