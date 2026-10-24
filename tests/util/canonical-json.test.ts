import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/core/util/canonical-json.ts';

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [3, { d: true, c: null }] })).toBe('{"a":[3,{"c":null,"d":true}],"b":1}');
  });

  it('is independent of insertion order', () => {
    expect(canonicalJson({ x: { q: 1, p: 2 }, w: 'v' })).toBe(canonicalJson({ w: 'v', x: { p: 2, q: 1 } }));
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined object values and writes null for undefined array slots', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it('escapes strings and keys like JSON.stringify', () => {
    expect(canonicalJson({ 'k"ey': 'a"b\né' })).toBe(`{${JSON.stringify('k"ey')}:${JSON.stringify('a"b\né')}}`);
  });

  it('normalises -0 to 0', () => {
    expect(canonicalJson({ z: -0 })).toBe('{"z":0}');
  });

  it('rejects values that have no stable JSON form', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson([Infinity])).toThrow(/non-finite/);
    expect(() => canonicalJson({ m: new Map() })).toThrow(/unsupported/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/unsupported/);
    expect(() => canonicalJson({ b: 1n })).toThrow(/unsupported/);
    expect(() => canonicalJson(undefined)).toThrow();
  });

  it('accepts null-prototype objects', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 2;
    o.a = 1;
    expect(canonicalJson(o)).toBe('{"a":1,"b":2}');
  });
});
