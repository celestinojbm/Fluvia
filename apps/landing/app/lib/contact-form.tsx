'use client';

import { ArrowRight } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Status = 'idle' | 'sending' | 'pending' | 'invalid' | 'error';

export function ContactForm() {
  const id = useId();
  const [status, setStatus] = useState<Status>('idle');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '');
    setStatus('sending');
    try {
      const response = await fetch('/api/contacto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (response.status === 501) {
        setStatus('pending');
        return;
      }
      setStatus(response.status === 400 ? 'invalid' : 'error');
    } catch {
      setStatus('error');
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
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
      <p id={`${id}-help`} className="text-sm text-[var(--fl-ink-2)]">
        Escríbenos si quieres hablar de tu comercio. Esta página no cobra.
      </p>
      <div>
        <Button type="submit" disabled={status === 'sending'}>
          {status === 'sending' ? 'Enviando' : 'Enviar'}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
      <StatusNote status={status} />
    </form>
  );
}

function StatusNote({ status }: { status: Status }) {
  if (status === 'idle' || status === 'sending') return null;
  const text =
    status === 'pending'
      ? 'PENDIENTE: todavía no hay un buzón conectado. Tu correo no se guardó ni se envió.'
      : status === 'invalid'
        ? 'Revisa el correo e inténtalo de nuevo.'
        : 'No pudimos hablar con el formulario. Inténtalo otra vez.';
  return (
    <p role="status" className="text-sm font-semibold text-[var(--fl-black)]">
      {text}
    </p>
  );
}
