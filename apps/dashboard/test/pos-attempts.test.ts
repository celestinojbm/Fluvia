import { afterEach, describe, expect, it, vi } from 'vitest';
import { attemptsFor, linkForSession, recordAttempt } from '../app/lib/pos-attempts';

/** Registro local venta→checkouts: solo ids, acotado y tolerante a fallos. */

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const OTHER = '2c0fe3f1-2ef9-43e6-a463-1d0e8f38b6f2';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('pos-attempts', () => {
  it('registra por venta, en orden, sin duplicar y aislado por organización', () => {
    recordAttempt(ORG, id(1), id(10));
    recordAttempt(ORG, id(1), id(11));
    recordAttempt(ORG, id(1), id(10));
    expect(attemptsFor(ORG, id(1))).toEqual([id(11), id(10)]);
    expect(linkForSession(ORG, id(11))).toBe(id(1));
    expect(linkForSession(OTHER, id(11))).toBeNull();
    expect(attemptsFor(OTHER, id(1))).toEqual([]);
  });

  it('acota ventas e intentos', () => {
    for (let i = 0; i < 25; i++) recordAttempt(ORG, id(100 + i), id(200 + i));
    expect(attemptsFor(ORG, id(100))).toEqual([]);
    expect(attemptsFor(ORG, id(124))).toEqual([id(224)]);
    for (let i = 0; i < 15; i++) recordAttempt(ORG, id(1), id(300 + i));
    expect(attemptsFor(ORG, id(1))).toHaveLength(10);
  });

  it('contenido corrupto o no-UUID se ignora; almacenamiento bloqueado no rompe', () => {
    window.sessionStorage.setItem(`fluvia.pos.sales.v1:${ORG}`, '{not json');
    expect(attemptsFor(ORG, id(1))).toEqual([]);
    window.sessionStorage.setItem(
      `fluvia.pos.sales.v1:${ORG}`,
      JSON.stringify([{ link: 'x', sessions: ['y'] }])
    );
    expect(linkForSession(ORG, 'y')).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => recordAttempt(ORG, id(1), id(2))).not.toThrow();
    expect(attemptsFor(ORG, id(1))).toEqual([]);
  });
});
