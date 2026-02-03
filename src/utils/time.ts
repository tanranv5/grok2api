export function nowMs(): number {
  return Date.now();
}

export function formatUtcSeconds(seconds: number): string {
  const d = new Date(seconds * 1000);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function formatUtcMs(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

