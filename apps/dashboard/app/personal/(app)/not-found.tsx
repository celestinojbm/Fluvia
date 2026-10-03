/**
 * Recurso inexistente o ajeno (pedido de otra persona, tienda retirada): la
 * API responde 404 en ambos casos y aquí no se distingue, para no revelar
 * que existe.
 */
export default function PersonalNotFound() {
  return (
    <main className="px-empty" role="alert" style={{ marginTop: 24 }}>
      <h1 style={{ fontSize: '1.375rem' }}>No encontramos esto</h1>
      <p>Puede que el enlace esté incompleto, que ya no exista o que no sea de tu cuenta.</p>
      <a className="px-btn" href="/personal">
        Volver al inicio
      </a>
    </main>
  );
}
