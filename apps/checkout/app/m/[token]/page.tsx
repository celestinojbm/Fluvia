import { MenuClient, type PublicMenuItem } from './menu-client';
import '../../mesa.css';

const API = process.env.FLUVIA_API_URL ?? 'http://127.0.0.1:3000';
export const dynamic = 'force-dynamic';

/**
 * Menú de la mesa (QR). El token solo abre el menú y permite crear un pedido
 * PROPIO; no da acceso a pedidos de otros comensales.
 */
export default async function MesaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let data: {
    merchant_name: string | null;
    table_label: string;
    ordering: { enabled: boolean; needs_acceptance: boolean };
    menu: PublicMenuItem[];
  } | null = null;
  if (/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
    try {
      const res = await fetch(`${API}/v1/public/tables/${token}`, { cache: 'no-store' });
      if (res.ok) data = await res.json();
    } catch {
      data = null;
    }
  }
  if (!data) {
    return (
      <main className="mesa" aria-labelledby="nf-title">
        <h1 id="nf-title">Este código no está activo</h1>
        <p>Pide al personal un código actualizado o tu pedido directamente.</p>
      </main>
    );
  }
  return (
    <MenuClient
      token={token}
      merchant={data.merchant_name ?? ''}
      table={data.table_label}
      menu={data.menu}
      ordering={data.ordering}
    />
  );
}
