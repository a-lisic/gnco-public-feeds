export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function optionalBoolean(value: unknown): boolean {
  return value === true;
}

export function validIsoDate(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`Invalid ${label}`);
  }
  return text;
}

export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

export function absoluteChurchCenterUrl(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  if (path.startsWith("https://")) return safeHttpsUrl(path);
  if (!path.startsWith("/")) return null;
  return `https://goodnewsco.churchcenter.com${path}`;
}

export function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function excerpt(value: string | null, maxLength = 220): string | null {
  if (!value) return null;
  const text = stripHtml(value);
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function sha256(value: string): Promise<string> {
  const input = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function sourceExpiry(url: string): string | null {
  try {
    const expires = new URL(url).searchParams.get("expires_at");
    if (!expires) return null;
    const epochSeconds = Number.parseInt(expires, 10);
    if (!Number.isFinite(epochSeconds)) return null;
    return new Date(epochSeconds * 1_000).toISOString();
  } catch {
    return null;
  }
}

export function canonicalArtworkSeed(url: string): string {
  const parsed = new URL(url);
  for (const parameter of ["expires_at", "signature", "response-content-disposition"]) {
    parsed.searchParams.delete(parameter);
  }
  parsed.hash = "";
  return parsed.toString();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function nowIso(now = new Date()): string {
  return now.toISOString();
}

export function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return result === 0;
}

export function logError(scope: string, error: unknown, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "error", scope, message: errorMessage(error), ...extra }));
}
