// Stable JSON for hashing: object keys sorted by UTF-16 code unit order, no whitespace, plain data only.
// Vendorable: imports nothing.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function encode(v: unknown, path: string): string | undefined {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(v); // -0 serialises as 0
    case 'undefined':
      return undefined; // omitted in objects, null in arrays (JSON.stringify semantics)
    case 'object': {
      if (Array.isArray(v)) {
        return `[${v.map((x, i) => encode(x, `${path}[${i}]`) ?? 'null').join(',')}]`;
      }
      if (!isPlainObject(v)) throw new Error(`canonicalJson: unsupported object at ${path}`);
      const rec = v as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(rec).sort()) {
        const enc = encode(rec[key], `${path}.${key}`);
        if (enc !== undefined) parts.push(`${JSON.stringify(key)}:${enc}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

/** Canonical JSON string. Throws on non-finite numbers, bigint, functions, symbols, Map/Set/Date/class instances. */
export function canonicalJson(value: unknown): string {
  const out = encode(value, '$');
  if (out === undefined) throw new Error('canonicalJson: top-level value is undefined');
  return out;
}
