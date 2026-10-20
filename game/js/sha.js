// sha256 helpers (ArrayBuffer -> hex) built on SubtleCrypto.
const enc = new TextEncoder();

export async function sha256Hex(input) {
  const buf = typeof input === 'string' ? enc.encode(input) : input;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randSaltHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function digestObj(obj) {
  return sha256Hex(JSON.stringify(obj));
}
