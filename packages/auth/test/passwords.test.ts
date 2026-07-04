import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/passwords.js';
import { generateToken, hashToken } from '../src/tokens.js';

describe('password hashing (scrypt)', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('incorrect horse', stored)).toBe(false);
  });

  it('uses a unique salt per hash', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
  });

  it('stores a versioned format and never the plaintext', async () => {
    const stored = await hashPassword('sup3r secret pass');
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(stored).not.toContain('sup3r');
  });

  it('returns false (never throws) on corrupt stored values', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$notanumber$8$1$AAAA$BBBB')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$32768$8$1$$')).toBe(false);
  });

  it('detects tampered hashes', async () => {
    const stored = await hashPassword('legit password!');
    const parts = stored.split('$');
    const hash = Buffer.from(parts[5]!, 'base64');
    hash[0] = hash[0]! ^ 0xff;
    parts[5] = hash.toString('base64');
    expect(await verifyPassword('legit password!', parts.join('$'))).toBe(false);
  });
});

describe('opaque tokens', () => {
  it('generates prefixed tokens with sha256 hash', () => {
    const t = generateToken('fluvia_sess');
    expect(t.plaintext).toMatch(/^fluvia_sess_[0-9a-f]{64}$/);
    expect(t.hash).toBe(hashToken(t.plaintext));
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hash).not.toContain(t.plaintext);
  });

  it('generates unique tokens', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateToken('x').plaintext));
    expect(seen.size).toBe(50);
  });
});
