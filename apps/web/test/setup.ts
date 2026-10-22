import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

class FakeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver;

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: () => Promise.resolve() },
});

window.sessionStorage.setItem('fluvia-code-typed', '1');
