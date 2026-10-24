import { describe, expect, it } from 'vitest';
import { hashCanonical, hashParts, sha256Hex, shortKey, truncHex } from '../../src/core/util/hash.ts';
import { sha256HexBytes, sha256HexString, utf8Encode } from '../../src/core/util/sha256.ts';

describe('sha256 (FIPS 180-4 vectors)', () => {
  it('hashes the empty string', () => {
    expect(sha256HexString('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(sha256HexString('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the 448-bit two-block message', () => {
    expect(sha256HexString('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes the quick brown fox', () => {
    expect(sha256HexString('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('hashes one million "a" bytes', () => {
    expect(sha256HexBytes(new Uint8Array(1_000_000).fill(0x61))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('handles every padding boundary length deterministically', () => {
    const seen = new Set<string>();
    for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const h = sha256HexBytes(new Uint8Array(n).fill(0x62));
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256HexBytes(new Uint8Array(n).fill(0x62))).toBe(h);
      seen.add(h);
    }
    expect(seen.size).toBe(9);
  });
});

describe('utf8Encode', () => {
  it('encodes 1-4 byte sequences', () => {
    expect([...utf8Encode('A')]).toEqual([0x41]);
    expect([...utf8Encode('é')]).toEqual([0xc3, 0xa9]);
    expect([...utf8Encode('€')]).toEqual([0xe2, 0x82, 0xac]);
    expect([...utf8Encode('\u{1F600}')]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('replaces lone surrogates with U+FFFD', () => {
    expect([...utf8Encode('\ud800')]).toEqual([0xef, 0xbf, 0xbd]);
    expect([...utf8Encode('\udc00x')]).toEqual([0xef, 0xbf, 0xbd, 0x78]);
  });

  it('string hashing = hashing its UTF-8 bytes', () => {
    const s = 'Café \u{1F3AC}';
    expect(sha256HexString(s)).toBe(sha256HexBytes(utf8Encode(s)));
  });
});

describe('hash helpers', () => {
  it('sha256Hex accepts strings and bytes', () => {
    expect(sha256Hex('abc')).toBe(sha256HexString('abc'));
    expect(sha256Hex(utf8Encode('abc'))).toBe(sha256HexString('abc'));
  });

  it('hashParts joins with |', () => {
    expect(hashParts(['run', 1, 'arm'])).toBe(sha256HexString('run|1|arm'));
  });

  it('shortKey / truncHex truncate to 16 hex by default', () => {
    expect(shortKey(['salt', 7])).toBe(sha256HexString('salt|7').slice(0, 16));
    expect(truncHex('abcdef', 3)).toBe('abc');
    expect(() => truncHex('abc', 0)).toThrow();
    expect(() => truncHex('abc', 4)).toThrow();
  });

  it('hashCanonical is key-order independent', () => {
    expect(hashCanonical({ a: 1, b: [1, 2] })).toBe(hashCanonical({ b: [1, 2], a: 1 }));
  });
});
