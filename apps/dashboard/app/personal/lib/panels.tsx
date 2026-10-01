/** Estados comunes de las pantallas de Fluvia Personal. */
export function ErrorPanel() {
  return (
    <main className="px-empty" role="alert" style={{ marginTop: 24 }}>
      <p>
        <strong>No pudimos cargar esta información.</strong>
      </p>
      <p>Tu dinero no se movió. Recarga en unos segundos.</p>
      <a className="px-btn" href="">
        Recargar
      </a>
    </main>
  );
}

export function LoadingPanel({ label }: { label: string }) {
  return (
    <main aria-busy="true" aria-label={label}>
      <div className="px-skeleton" style={{ height: 32, width: '40%', marginBottom: 16 }} />
      <div className="px-skeleton" style={{ height: 180, marginBottom: 16 }} />
      <div className="px-skeleton" style={{ height: 120 }} />
      <p className="sr-only">Cargando…</p>
    </main>
  );
}
