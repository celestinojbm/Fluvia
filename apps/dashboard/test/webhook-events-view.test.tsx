import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { WebhookEventDetailView, WebhookEventsList } from '../app/lib/webhook-events-view';
import type { WebhookEvent, WebhookEventDetail } from '../app/lib/api';

/**
 * F6.5B — vistas de eventos de webhook (jsdom + axe, CI-gated). SOLO LECTURA +
 * reenvío existente (webhooks:manage). Los serializers del API jamás llevan
 * secretos; estos tests además fallan si un campo secreto inyectado se filtrara
 * al DOM (garantía estructural de no-fuga).
 */

const DEAD: WebhookEvent = {
  id: 'whe_abcdef123456',
  endpoint_id: 'whep_112233445566',
  topic: 'payment_intent.succeeded',
  status: 'dead',
  attempts: 7,
  next_attempt_at: null,
  last_error: 'connect ETIMEDOUT',
  delivered_at: null,
  resent_from_event_id: null,
  created_at: '2026-07-11T10:00:00Z',
};

const DETAIL: WebhookEventDetail = {
  ...DEAD,
  payload: { id: 'evt_1', type: 'payment_intent.succeeded', data: { amount: 90_000 } },
  attempts_history: [
    {
      attempt_number: 1,
      status_code: 500,
      error: 'remote 500',
      latency_ms: 240,
      resolved_ip: '203.0.113.7',
      created_at: '2026-07-11T10:00:05Z',
    },
  ],
};

describe('WebhookEventsList', () => {
  it('lists events linking to detail, and shows the empty state', () => {
    const { rerender } = render(
      <WebhookEventsList events={[DEAD]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const link = screen.getByRole('link', { name: /whe_abcd/ });
    expect(link.getAttribute('href')).toBe('/o/o1/webhook-events/whe_abcdef123456');
    expect(screen.getByText('payment_intent.succeeded')).toBeInTheDocument();
    expect(screen.getByText('dead')).toBeInTheDocument();

    rerender(<WebhookEventsList events={[]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('Sin eventos de webhook.')).toBeInTheDocument();
  });

  it('shows a resend control for dead events only when the role can resend', () => {
    const { rerender } = render(
      <WebhookEventsList events={[DEAD]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.queryByRole('button', { name: 'Reenviar' })).toBeNull();
    rerender(
      <WebhookEventsList events={[DEAD]} orgId="o1" locale="es" signOutHref="/logout" canResend />
    );
    expect(screen.getByRole('button', { name: 'Reenviar' })).toBeInTheDocument();
  });
});

describe('WebhookEventDetailView', () => {
  it('renders the fields, the payload and the attempts history', () => {
    render(
      <WebhookEventDetailView event={DETAIL} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.getByText('whe_abcdef123456')).toBeInTheDocument();
    expect(screen.getByText('whep_112233445566')).toBeInTheDocument();
    expect(screen.getByText('connect ETIMEDOUT')).toBeInTheDocument();
    // Payload renderizado como JSON dentro de un <pre>.
    const payload = screen.getByText(/"type": "payment_intent.succeeded"/);
    expect(payload.tagName).toBe('PRE');
    expect(payload.textContent).toContain('"amount": 90000');
    // Historial de intentos.
    const attempts = screen.getByRole('heading', { name: /Intentos de entrega/ });
    expect(attempts).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('remote 500')).toBeInTheDocument();
  });

  it('offers resend for a dead event only with canResend', () => {
    const { rerender } = render(
      <WebhookEventDetailView event={DETAIL} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.queryByRole('button', { name: 'Reenviar' })).toBeNull();
    rerender(
      <WebhookEventDetailView
        event={DETAIL}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
        canResend
      />
    );
    expect(screen.getByRole('button', { name: 'Reenviar' })).toBeInTheDocument();
  });

  it('SECURITY: a secret-like top-level field injected into the event never reaches the DOM', () => {
    const poisoned = {
      ...DETAIL,
      // Campos que JAMÁS deben renderizarse (el modelo no los tiene; se inyectan
      // para probar que la vista solo mapea campos conocidos seguros).
      secret: 'whsec_SUPERSECRETVALUE',
      signing_secret: 'whsig_LEAKME',
      secret_hash: 'deadbeefhash',
    } as unknown as WebhookEventDetail;
    const { container } = render(
      <WebhookEventDetailView event={poisoned} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const html = container.innerHTML;
    expect(html).not.toContain('whsec_SUPERSECRETVALUE');
    expect(html).not.toContain('whsig_LEAKME');
    expect(html).not.toContain('deadbeefhash');
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <WebhookEventDetailView event={DETAIL} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('webhook events — tenant scoping in links', () => {
  it('every detail link is scoped under the org path', () => {
    render(<WebhookEventsList events={[DEAD]} orgId="o1" locale="es" signOutHref="/logout" />);
    const links = within(screen.getByRole('table'))
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    for (const href of links) expect(href).toMatch(/^\/o\/o1\/webhook-events\//);
  });
});
