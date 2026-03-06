const CHAR_REPLACEMENTS: Record<string, string> = {
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": "\"",
  "\u201d": "\"",
  "\u00a0": " ",
  "\u2007": " ",
  "\u202f": " ",
  "\u200b": "",
  "\u200c": "",
  "\u200d": "",
  "\ufeff": "",
};

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const NON_ASCII_TOKEN_RE = /[^\x21-\x7e]/g;

function translateChars(input: string): string {
  let output = "";
  for (const char of input) output += CHAR_REPLACEMENTS[char] ?? char;
  return output;
}

export function sanitizeHeaderValue(
  value: unknown,
  options: { removeAllSpaces?: boolean } = {},
): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const translated = translateChars(raw);
  const trimmed = options.removeAllSpaces
    ? translated.replace(/\s+/g, "")
    : translated.trim();
  return trimmed.replace(CONTROL_CHARS_RE, "");
}

export function sanitizeTokenValue(value: unknown): string {
  let normalized = sanitizeHeaderValue(value, { removeAllSpaces: true });
  if (normalized.startsWith("sso=")) normalized = normalized.slice(4);
  normalized = normalized.replace(NON_ASCII_TOKEN_RE, "");
  return normalized;
}

export function sanitizeUniqueTokens(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const token = sanitizeTokenValue(value);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}
