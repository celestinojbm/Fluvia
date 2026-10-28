'use client';

import { ArrowRight } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Status = 'idle' | 'sending' | 'saved' | 'invalid' | 'error';

export function ContactForm() {
  const id = useId();
  const honey = useId();
  const [status, setStatus] = useState<Status>('idle');
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setStatus('sending');
    setNotice(null);
    try {
      const response = await fetch('/api/contacto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: String(data.get('email') ?? ''),
          website: String(data.get('website') ?? ''),
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const record =
        payload && typeof payload === 'object'
          ? (payload as { status?: unknown; message?: unknown })
          : null;
      const message = typeof record?.message === 'string' ? record.message : null;
      const kind =
        record?.status === 'saved' ? 'saved' : record?.status === 'invalid' ? 'invalid' : 'error';
      if (kind === 'saved') form.reset();
      setStatus(kind);
      setNotice(
        message ??
          (kind === 'saved'
            ? 'Listo. Guardamos tu correo.'
            : kind === 'invalid'
              ? 'Revisa el correo e inténtalo de nuevo.'
              : 'No pudimos guardar tu correo. Inténtalo de nuevo.')
      );
    } catch {
      setStatus('error');
      setNotice('No pudimos guardar tu correo. Inténtalo de nuevo.');
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <div className="grid gap-2">
        <Label htmlFor={id}>Tu correo</Label>
        <Input
          id={id}
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          placeholder="tu@comercio.com"
          aria-describedby={`${id}-help`}
          disabled={status === 'sending'}
        />
      </div>
      <div className="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor={honey}>Sitio web</label>
        <input
          id={honey}
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          defaultValue=""
        />
      </div>
      <p id={`${id}-help`} className="text-xl leading-relaxed text-[var(--fl-ink-2)]">
        Escríbenos si quieres hablar de tu comercio. Esta página no cobra.
      </p>
      <div>
        <Button type="submit" disabled={status === 'sending'}>
          {status === 'sending' ? 'Enviando' : 'Enviar'}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
      {notice ? (
        <p role="status" className="text-xl font-semibold text-[var(--fl-black)]">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
