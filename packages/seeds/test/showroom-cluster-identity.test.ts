import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from '@fluvia/db';
import {
  ShowroomUnverifiedTargetError,
  observeShowroomLiveIdentity,
  verifyShowroomTarget,
  type VerifiedShowroomTarget,
} from '../src/live-identity.js';
import {
  ShowroomDatabaseMismatchError,
  seedShowroom,
  type ShowroomPhase,
  type ShowroomPools,
} from '../src/showroom.js';

/**
 * RA-F65C3-EXT-001 — la defensa live debe demostrar que los cinco roles
 * pertenecen al MISMO cluster PostgreSQL real, no solo a bases con el mismo
 * nombre. Evidencia REAL (sin mocks): clusters PostgreSQL 16 EFIMEROS en
 * contenedores locales (imagen `postgres:16`, la misma que ya usa el job de
 * CI como service), cada uno con una base del MISMO nombre autorizado.
 *
 *  - cinco clusters distintos, mismo dbname => rechazo por identidad live;
 *  - cinco pools del mismo cluster => handle verificado;
 *  - un pool cambiado a otro cluster => rechazo;
 *  - misma base y mismo puerto TEXTUAL de URL, endpoint live diferente => rechazo;
 *  - handle autentico cuya identidad cambia antes del seed (otro cluster en el
 *    mismo host:puerto) => rechazo TOCTOU;
 *  - handle falso/plano/copiado => rechazo runtime sin tocar la base.
 *
 * Los contenedores usan nombres/puertos unicos, tmpfs, cero Internet (la
 * imagen ya esta presente), timeout duro y cleanup estricto en afterAll. Las
 * passwords de los clusters efimeros jamas se imprimen.
 */

const sh = promisify(execFile);

const IMAGE = 'postgres:16';
const DB = 'fluvia_showroom_test_multicluster';
const PG_PASSWORD = 'showroom-cluster-ephemeral';
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;

interface Cluster {
  name: string;
  host: string;
  port: number;
}

const clusters: Cluster[] = [];
const openPools: Pool[] = [];

async function startCluster(suffix: string, publish: string): Promise<Cluster> {
  const name = `fluvia-c3-cluster-${RUN_ID}-${suffix}`;
  await sh('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--tmpfs',
    '/var/lib/postgresql/data',
    '-e',
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e',
    `POSTGRES_DB=${DB}`,
    '-p',
    publish,
    IMAGE,
  ]);
  const { stdout } = await sh('docker', ['port', name, '5432/tcp']);
  const line = stdout.split('\n')[0]!.trim();
  const sep = line.lastIndexOf(':');
  const cluster: Cluster = { name, host: line.slice(0, sep), port: Number(line.slice(sep + 1)) };
  // Registrado ANTES del readiness: el cleanup de afterAll lo elimina incluso
  // si el arranque falla a mitad.
  clusters.push(cluster);
  // Readiness: pg_isready DENTRO del contenedor y luego una conexion real
  // desde el host (el proxy de puertos puede tardar un instante mas).
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await sh('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', DB]);
      const probe = createPool({ connectionString: urlFor(cluster), max: 1 });
      try {
        await probe.query('SELECT 1');
        break;
      } finally {
        await probe.end();
      }
    } catch {
      if (Date.now() > deadline) throw new Error(`cluster ${suffix} did not become ready`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return cluster;
}

function urlFor(cluster: Cluster, host = cluster.host): string {
  return `postgres://postgres:${PG_PASSWORD}@${host}:${cluster.port}/${DB}`;
}

function poolTo(cluster: Cluster, host?: string): Pool {
  const pool = createPool({ connectionString: urlFor(cluster, host), max: 2 });
  // Un cluster efimero puede morir a proposito (caso TOCTOU): los errores de
  // clientes idle no deben tumbar el proceso de tests.
  (pool as unknown as { on: (ev: string, fn: () => void) => void }).on('error', () => undefined);
  openPools.push(pool);
  return pool;
}

function poolsAcross(cs: [Cluster, Cluster, Cluster, Cluster, Cluster]): ShowroomPools {
  return {
    admin: poolTo(cs[0]),
    app: poolTo(cs[1]),
    auth: poolTo(cs[2]),
    relay: poolTo(cs[3]),
    webhook: poolTo(cs[4]),
  };
}

async function tableCount(cluster: Cluster): Promise<number> {
  const pool = createPool({ connectionString: urlFor(cluster), max: 1 });
  try {
    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace`
    );
    return Number(res.rows[0]!.n);
  } finally {
    await pool.end();
  }
}

let c1: Cluster, c2: Cluster, c3: Cluster, c4: Cluster, c5: Cluster;

beforeAll(async () => {
  // Cinco clusters efimeros, puertos unicos asignados por Docker en loopback.
  [c1, c2, c3, c4, c5] = await Promise.all([
    startCluster('a', '127.0.0.1:0:5432'),
    startCluster('b', '127.0.0.1:0:5432'),
    startCluster('c', '127.0.0.1:0:5432'),
    startCluster('d', '127.0.0.1:0:5432'),
    startCluster('e', '127.0.0.1:0:5432'),
  ]);
}, 300_000);

afterAll(async () => {
  await Promise.allSettled(openPools.map((p) => p.end()));
  await Promise.allSettled(
    clusters.map((c) => sh('docker', ['rm', '-f', '-v', c.name]).catch(() => undefined))
  );
}, 120_000);

describe('identidad live unica entre clusters PostgreSQL 16 reales', () => {
  it('cinco clusters DISTINTOS con el MISMO dbname autorizado => rechazo, cero mutacion', async () => {
    const pools = poolsAcross([c1, c2, c3, c4, c5]);

    // Sanity: los cinco reportan current_database() = el MISMO nombre — la
    // comparacion de nombres NO puede distinguirlos; la identidad live si.
    for (const role of ['admin', 'app', 'auth', 'relay', 'webhook'] as const) {
      const res = await pools[role].query<{ db: string }>('SELECT current_database() AS db');
      expect(res.rows[0]!.db).toBe(DB);
    }

    const before = await Promise.all([c1, c2, c3, c4, c5].map(tableCount));
    let error: unknown;
    try {
      await verifyShowroomTarget('test', pools);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ShowroomDatabaseMismatchError);
    // El mensaje delata la divergencia live, no credenciales.
    expect(String(error)).toMatch(
      /DIFFERENT live server endpoints|DIFFERENT postmaster|DIFFERENT cluster/
    );
    expect(String(error)).not.toContain(PG_PASSWORD);
    expect(String(error)).not.toMatch(/showroom-owner-sandbox|fluvia_sk_/);

    // seedShowroom NO puede ni intentarse sin handle: un objeto de pools plano
    // (el unico camino posible aqui) se rechaza en runtime SIN tocar la base,
    // sin fases, sin receptor HTTP, sin espera de expiracion, sin secretos.
    const phases: ShowroomPhase[] = [];
    await expect(
      seedShowroom('test', { pools, identity: undefined, plan: null } as never, {
        onPhase: (p) => phases.push(p),
      })
    ).rejects.toBeInstanceOf(ShowroomUnverifiedTargetError);
    expect(phases).toEqual([]);

    // CERO mutaciones en los cinco clusters: ni tabla, ni usuario, ni org, ni
    // merchant, ni auditoria, ni ledger (las bases siguen sin objeto alguno).
    const after = await Promise.all([c1, c2, c3, c4, c5].map(tableCount));
    expect(after).toEqual(before);
    expect(after.every((n) => n === 0)).toBe(true);
  }, 120_000);

  it('cinco pools del MISMO cluster real => handle verificado con identidad completa', async () => {
    const pools = poolsAcross([c1, c1, c1, c1, c1]);
    const target = await verifyShowroomTarget('test', pools);
    expect(target.identity.database).toBe(DB);
    expect(target.identity.serverAddress).toBeTruthy();
    expect(target.identity.serverPort).toBeGreaterThan(0);
    expect(target.identity.postmasterStartedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
    // postgres:16 permite pg_control_system() a superuser: identidad estable.
    expect(target.identity.clusterIdentifier).toMatch(/^\d+$/);
  }, 60_000);

  it('UN pool cambiado a otro cluster => rechazo', async () => {
    const pools = poolsAcross([c1, c1, c1, c1, c3]);
    await expect(verifyShowroomTarget('test', pools)).rejects.toBeInstanceOf(
      ShowroomDatabaseMismatchError
    );
  }, 60_000);

  it('misma base y mismo puerto TEXTUAL de URL, endpoint live DIFERENTE => rechazo', async () => {
    // Dos clusters nuevos publicados en el MISMO puerto textual sobre IPs
    // loopback distintas: las URLs comparten puerto y dbname, pero el endpoint
    // live (direccion del servidor / postmaster / system_identifier) difiere.
    const probe = await import('node:net');
    const free = await new Promise<number>((resolve, reject) => {
      const srv = probe.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.2', () => {
        const port = (srv.address() as { port: number }).port;
        srv.close(() => resolve(port));
      });
    });
    const cf = await startCluster('f', `127.0.0.2:${free}:5432`);
    const cg = await startCluster('g', `127.0.0.3:${free}:5432`);
    expect(cf.port).toBe(free);
    expect(cg.port).toBe(free); // mismo puerto TEXTUAL en ambas URLs

    const pools: ShowroomPools = {
      admin: poolTo(cf, '127.0.0.2'),
      app: poolTo(cg, '127.0.0.3'),
      auth: poolTo(cg, '127.0.0.3'),
      relay: poolTo(cg, '127.0.0.3'),
      webhook: poolTo(cg, '127.0.0.3'),
    };
    await expect(verifyShowroomTarget('test', pools)).rejects.toBeInstanceOf(
      ShowroomDatabaseMismatchError
    );
  }, 180_000);

  it('handle AUTENTICO cuya identidad live cambia antes del seed => rechazo TOCTOU', async () => {
    // Attestation real contra c5…
    const pools = poolsAcross([c5, c5, c5, c5, c5]);
    const target: VerifiedShowroomTarget = await verifyShowroomTarget('test', pools);
    const attested = target.identity;

    // …y el cluster es REEMPLAZADO por otro en el MISMO host:puerto (mismo
    // dbname): la attestation antigua no puede bastar.
    await sh('docker', ['rm', '-f', '-v', c5.name]);
    const replacement = await startCluster('e2', `127.0.0.1:${c5.port}:5432`);
    expect(replacement.port).toBe(c5.port);

    // Drena las conexiones muertas de LOS CINCO pools hasta alcanzar el
    // cluster nuevo (la re-attestation no reintenta: es fail-closed).
    const deadline = Date.now() + 60_000;
    for (const role of ['admin', 'app', 'auth', 'relay', 'webhook'] as const) {
      for (;;) {
        try {
          await pools[role].query('SELECT 1');
          break;
        } catch {
          if (Date.now() > deadline) throw new Error('replacement cluster unreachable');
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
    const fresh = await observeShowroomLiveIdentity(pools);
    expect(fresh.postmasterStartedAt).not.toBe(attested.postmasterStartedAt);

    const phases: ShowroomPhase[] = [];
    let error: unknown;
    try {
      await seedShowroom('test', target, { onPhase: (p) => phases.push(p) });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ShowroomDatabaseMismatchError);
    expect(String(error)).toContain('live identity changed since attestation');
    // El rechazo ocurre en preflight: sin identidad creada, sin receptor HTTP,
    // sin espera de expiracion, sin credenciales.
    expect(phases).toEqual(['preflight']);
    expect(await tableCount(replacement)).toBe(0);
  }, 240_000);

  it('handle falso, plano o COPIA estructural de uno autentico => rechazo runtime', async () => {
    const pools = poolsAcross([c1, c1, c1, c1, c1]);
    const genuine = await verifyShowroomTarget('test', pools);

    const attempts: unknown[] = [
      { pools, identity: genuine.identity, plan: null }, // plano equivalente
      { ...genuine }, // copia estructural (pierde la marca runtime)
      Object.create(genuine as object), // hereda propiedades, no la membresia
      null,
      42,
    ];
    for (const forged of attempts) {
      await expect(seedShowroom('test', forged as never)).rejects.toBeInstanceOf(
        ShowroomUnverifiedTargetError
      );
    }
  }, 60_000);
});
