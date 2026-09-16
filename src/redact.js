// Secret redaction shared by the console, the log file and HTTP errors.

const secrets = new Set();

/** Register a value that must never appear in output. */
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) secrets.add(value);
}

export function redact(text) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(`****${secret.slice(-4)}`);
  }
  out = out.replaceAll(/(Bearer\s+)[\w.~+/=-]{8,}/giu, "$1****");
  out = out.replaceAll(/\b([A-Za-z0-9]{16,})\.([A-Za-z0-9]{12,})\b/gu, (_, id) => `${id.slice(0, 4)}****`);
  return out;
}
