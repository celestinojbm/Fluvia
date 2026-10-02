'use client';

import { useRef, useState } from 'react';
import { clientCall, errorMessage } from './client-call';

export interface OwnProfile {
  id: string;
  merchant_id: string;
  slug: string;
  display_name: string;
  category: string;
  city: string;
  area: string | null;
  summary: string | null;
  channels: Array<'in_store' | 'online'>;
  photo_ref: string | null;
  visibility: 'draft' | 'published' | 'hidden';
  is_demo: boolean;
  published_at: string | null;
  version: number;
}

const VIS: Record<OwnProfile['visibility'], { label: string; tone: string }> = {
  draft: { label: 'Borrador · no visible', tone: 'neutral' },
  published: { label: 'Publicado · visible para cualquiera', tone: 'ok' },
  hidden: { label: 'Retirado · no visible', tone: 'warn' },
};

/**
 * Editor del perfil público de UN comercio. Guardar no publica: publicar es
 * una acción aparte que exige marcar la casilla de confirmación. La API vuelve
 * a autorizar (merchants:write) y audita; aquí `canEdit` es solo una pista.
 */
export function DirectoryEditor({
  orgId,
  merchantId,
  merchantName,
  profile,
  canEdit,
  categories,
  photos,
}: {
  orgId: string;
  merchantId: string;
  merchantName: string;
  profile: OwnProfile | null;
  canEdit: boolean;
  categories: ReadonlyArray<{ slug: string; label: string }>;
  photos: ReadonlyArray<{ ref: string; label: string }>;
}) {
  const [p, setP] = useState(profile);
  const [form, setForm] = useState({
    slug: profile?.slug ?? '',
    display_name: profile?.display_name ?? merchantName,
    category: profile?.category ?? categories[0]!.slug,
    city: profile?.city ?? '',
    area: profile?.area ?? '',
    summary: profile?.summary ?? '',
    in_store: profile ? profile.channels.includes('in_store') : true,
    online: profile ? profile.channels.includes('online') : false,
    photo_ref: profile?.photo_ref ?? '',
  });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const lock = useRef(false);
  const msgRef = useRef<HTMLDivElement>(null);
  const base = `/api/orgs/${encodeURIComponent(orgId)}/directory/profiles/${merchantId}`;
  const id = (k: string) => `dir-${merchantId}-${k}`;

  const show = (m: typeof msg) => {
    setMsg(m);
    requestAnimationFrame(() => msgRef.current?.focus());
  };

  async function run(fn: () => Promise<void>) {
    if (lock.current || !canEdit) return;
    lock.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const channels = [form.in_store ? 'in_store' : null, form.online ? 'online' : null].filter(
        Boolean
      );
      if (channels.length === 0) {
        show({ tone: 'bad', text: 'Elige al menos un canal: en tienda o en línea.' });
        return;
      }
      const r = await clientCall<OwnProfile>(base, {
        method: 'PUT',
        body: {
          slug: form.slug.trim().toLowerCase(),
          display_name: form.display_name.trim(),
          category: form.category,
          city: form.city.trim(),
          area: form.area.trim() || null,
          summary: form.summary.trim() || null,
          channels,
          photo_ref: form.photo_ref || null,
          expected_version: p?.version ?? 0,
        },
      });
      if (r.kind === 'ok') {
        setP(r.body);
        show({
          tone: 'ok',
          text:
            r.body.visibility === 'published'
              ? 'Guardado. Los cambios ya se ven en el directorio.'
              : 'Guardado como borrador. Aún no es visible.',
        });
      } else {
        show({
          tone: 'bad',
          text:
            r.kind === 'http' && r.status === 400
              ? 'Revisa los campos: dirección de 3–48 letras, números o guiones; nombre y ciudad obligatorios.'
              : errorMessage(r),
        });
      }
    });

  const publish = () =>
    run(async () => {
      if (!p) return;
      if (!confirm) {
        show({
          tone: 'bad',
          text: 'Marca la casilla para confirmar que estos datos serán públicos.',
        });
        return;
      }
      const r = await clientCall<OwnProfile>(`${base}/publish`, {
        method: 'POST',
        body: { confirm_public: true, expected_version: p.version },
      });
      if (r.kind === 'ok') {
        setP(r.body);
        setConfirm(false);
        show({ tone: 'ok', text: 'Publicado. Ya aparece en «Dónde comprar».' });
      } else show({ tone: 'bad', text: errorMessage(r) });
    });

  const hide = () =>
    run(async () => {
      if (!p) return;
      const r = await clientCall<OwnProfile>(`${base}/hide`, {
        method: 'POST',
        body: { expected_version: p.version },
      });
      if (r.kind === 'ok') {
        setP(r.body);
        show({ tone: 'ok', text: 'Retirado. Ya no aparece en el directorio.' });
      } else show({ tone: 'bad', text: errorMessage(r) });
    });

  const vis = p ? VIS[p.visibility] : { label: 'Sin perfil · no visible', tone: 'neutral' };

  return (
    <section className="fx-panel" aria-labelledby={id('title')}>
      <header>
        <h2 id={id('title')}>{merchantName}</h2>
        <span className="fx-status" data-tone={vis.tone}>
          {vis.label}
        </span>
      </header>
      {!canEdit ? (
        <p className="fx-hint">Tu rol puede ver el perfil, pero no editarlo ni publicarlo.</p>
      ) : null}
      <form
        className="action-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!canEdit || busy}>
          <legend className="sr-only">Datos públicos</legend>
          <label htmlFor={id('name')}>Nombre comercial</label>
          <input
            id={id('name')}
            value={form.display_name}
            maxLength={80}
            required
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
          />
          <label htmlFor={id('slug')}>Dirección pública</label>
          <input
            id={id('slug')}
            value={form.slug}
            maxLength={48}
            required
            pattern="[a-z0-9][a-z0-9-]{1,46}[a-z0-9]"
            aria-describedby={id('slug-h')}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
          />
          <p id={id('slug-h')} className="fx-hint">
            /donde-comprar/{form.slug || 'tu-comercio'} · minúsculas, números y guiones
          </p>
          <label htmlFor={id('cat')}>Categoría</label>
          <select
            id={id('cat')}
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.label}
              </option>
            ))}
          </select>
          <label htmlFor={id('city')}>Ciudad</label>
          <input
            id={id('city')}
            value={form.city}
            maxLength={60}
            required
            onChange={(e) => setForm({ ...form, city: e.target.value })}
          />
          <label htmlFor={id('area')}>Zona (opcional)</label>
          <input
            id={id('area')}
            value={form.area}
            maxLength={60}
            onChange={(e) => setForm({ ...form, area: e.target.value })}
          />
          <label htmlFor={id('sum')}>Descripción breve (opcional)</label>
          <textarea
            id={id('sum')}
            value={form.summary}
            maxLength={280}
            rows={3}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
          />
          <fieldset>
            <legend>Dónde vendes</legend>
            <label className="scope-option">
              <input
                type="checkbox"
                checked={form.in_store}
                onChange={(e) => setForm({ ...form, in_store: e.target.checked })}
              />
              En tienda
            </label>
            <label className="scope-option">
              <input
                type="checkbox"
                checked={form.online}
                onChange={(e) => setForm({ ...form, online: e.target.checked })}
              />
              En línea
            </label>
          </fieldset>
          <label htmlFor={id('photo')}>Foto</label>
          <select
            id={id('photo')}
            value={form.photo_ref}
            onChange={(e) => setForm({ ...form, photo_ref: e.target.value })}
          >
            <option value="">Sin foto (inicial del nombre)</option>
            {photos.map((ph) => (
              <option key={ph.ref} value={ph.ref}>
                {ph.label}
              </option>
            ))}
          </select>
          <p className="fx-hint">
            No incluyas datos privados: todo lo de este formulario será público si publicas.
          </p>
          <div className="fx-actions">
            <button type="submit" className="fx-btn fx-btn-primary">
              {busy ? 'Guardando…' : p ? 'Guardar cambios' : 'Crear borrador'}
            </button>
          </div>
        </fieldset>
      </form>

      {p && canEdit ? (
        <div className="fx-actions" style={{ margin: 16, flexWrap: 'wrap' }}>
          {p.visibility !== 'published' ? (
            <>
              <label className="scope-option">
                <input
                  type="checkbox"
                  checked={confirm}
                  onChange={(e) => setConfirm(e.target.checked)}
                />
                Entiendo que estos datos serán visibles para cualquiera
              </label>
              <button
                type="button"
                className="fx-btn"
                onClick={() => void publish()}
                disabled={busy}
              >
                Publicar en el directorio
              </button>
            </>
          ) : (
            <>
              <a className="fx-btn" href={`/donde-comprar/${p.slug}`}>
                Ver mi ficha pública
              </a>
              <button
                type="button"
                className="fx-btn fx-btn-danger"
                onClick={() => void hide()}
                disabled={busy}
              >
                Retirar del directorio
              </button>
            </>
          )}
        </div>
      ) : null}

      <div ref={msgRef} tabIndex={-1} aria-live="polite">
        {msg ? (
          <p
            className="fx-callout"
            data-tone={msg.tone}
            role={msg.tone === 'bad' ? 'alert' : 'status'}
          >
            {msg.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
