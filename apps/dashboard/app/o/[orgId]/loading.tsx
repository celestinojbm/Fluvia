/**
 * Estado de carga de las pantallas del comercio: esqueleto con la forma de
 * la página (no un spinner a pantalla completa) y anuncio para lectores.
 */
export default function Loading() {
  return (
    <main className="fx-page" aria-busy="true" aria-labelledby="loading-title">
      <h1 id="loading-title" className="sr-only">
        Cargando…
      </h1>
      <p role="status" className="sr-only">
        Cargando datos del comercio…
      </p>
      <span className="fx-skel" style={{ width: 120, height: 12, marginBottom: 10 }} />
      <span className="fx-skel" style={{ width: 260, height: 30, marginBottom: 28 }} />
      <div className="fx-hero">
        <span className="fx-skel" style={{ height: 220, borderRadius: 14 }} />
        <span className="fx-skel" style={{ height: 220, borderRadius: 14 }} />
      </div>
      <span className="fx-skel" style={{ height: 96, borderRadius: 14, marginBottom: 16 }} />
      <div className="fx-cols">
        <span className="fx-skel" style={{ height: 200, borderRadius: 14 }} />
        <span className="fx-skel" style={{ height: 200, borderRadius: 14 }} />
      </div>
    </main>
  );
}
