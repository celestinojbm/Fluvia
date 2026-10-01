import { programId } from '../lib/server';
import { EntrarClient } from './entrar-client';
import '../../platform.css';
import '../personal.css';

export const dynamic = 'force-dynamic';

export default async function EntrarPage({
  searchParams,
}: {
  searchParams: Promise<{ expirada?: string; modo?: string }>;
}) {
  const sp = await searchParams;
  if (!programId()) {
    return (
      <main className="px-gate">
        <h1>Fluvia Personal no está configurado</h1>
        <p>Falta la organización programa (FLUVIA_PROGRAM_TENANT_ID) en este entorno.</p>
      </main>
    );
  }
  return (
    <main className="px-gate">
      <EntrarClient
        expired={sp.expirada === '1'}
        initialMode={sp.modo === 'crear' ? 'register' : 'login'}
      />
    </main>
  );
}
