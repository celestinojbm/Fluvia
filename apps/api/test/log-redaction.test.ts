import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { LOG_REDACT, buildApp } from '../src/app.js';

/**
 * F6 (threat model §5 — Secretos/cadena): la redacción del logger existía por
 * config pero NINGÚN test la protegía de una regresión (borrar un path del
 * redact pasaba CI en verde). Dos capas, dos tests:
 *  1) `LOG_REDACT` (el MISMO objeto que cablea buildApp, no una copia) censura
 *     cada path sensible cuando un serializer incluye los headers — que es
 *     exactamente el escenario futuro del que esta capa defiende, porque el
 *     serializer `req` por defecto de Fastify hoy los descarta;
 *  2) una request real al app REAL con credenciales en TODAS las cabeceras
 *     sensibles no filtra ninguno de los valores a ninguna línea de log.
 */

const SECRETS: Record<string, string> = {
  authorization: `Bearer sk-live-leak-${randomUUID()}`,
  cookie: `fluvia_session=${randomUUID()}`,
  'x-api-key': `fluvia_sk_${randomUUID()}`,
  'x-checkout-client-secret': `cs_${randomUUID()}`,
};

describe('LOG_REDACT censura cada path sensible (capa pino, objeto compartido)', () => {
  it('headers reaching a serializer come out as [REDACTED], never the value', async () => {
    const lines: string[] = [];
    // Serializer passthrough: simula el cambio futuro «loguear headers» y
    // prueba que la redacción (aplicada DESPUÉS de serializar) los censura.
    // El cast: aquí se loguean objetos PLANOS con forma de request, no
    // FastifyRequest reales — el tipo estrecho de Fastify no aplica.
    const passthrough = ((value: unknown) => value) as never;
    const bare = Fastify({
      logger: {
        level: 'info',
        redact: LOG_REDACT,
        stream: {
          write: (msg: string) => {
            lines.push(msg);
          },
        },
        serializers: { req: passthrough, res: passthrough },
      },
    });
    const setCookie = `fluvia_session=${randomUUID()}; HttpOnly; Secure`;
    bare.log.info(
      { req: { headers: { ...SECRETS } }, res: { headers: { 'set-cookie': setCookie } } },
      'redaction-probe'
    );
    await bare.close();

    const probe = lines.find((l) => l.includes('redaction-probe'));
    expect(probe).toBeTruthy();
    const parsed = JSON.parse(probe!) as {
      req: { headers: Record<string, string> };
      res: { headers: Record<string, string> };
    };
    for (const header of Object.keys(SECRETS)) {
      expect(parsed.req.headers[header]).toBe('[REDACTED]');
    }
    expect(parsed.res.headers['set-cookie']).toBe('[REDACTED]');
    for (const secret of [...Object.values(SECRETS), setCookie]) {
      expect(probe).not.toContain(secret);
    }
  });
});

describe('el app real no filtra credenciales de cabecera a los logs', () => {
  const lines: string[] = [];
  let app: FastifyInstance;
  let appPool: Pool;

  beforeAll(async () => {
    // LOG_LEVEL info a propósito: los logs de request DEBEN emitirse para que
    // la aserción de no-fuga observe el camino real (con 'error' sería vacua).
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    appPool = createPool({ connectionString: config.db.app, max: 2 });
    app = buildApp({
      config,
      appPool,
      loggerStream: {
        write: (msg: string) => {
          lines.push(msg);
        },
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await appPool.end();
  });

  it('buildApp WIRES the redaction (mutation teeth: removing `redact:` fails here)', () => {
    // Probe por los paths top-level `headers.*` de LOG_REDACT: no pasan por
    // ningún serializer de Fastify, así que atraviesan la redacción del
    // logger REAL del app. Los tests anteriores prueban el objeto; este
    // prueba que buildApp lo cablea — sin él, quitar `redact: LOG_REDACT`
    // de app.ts dejaba la suite en verde (hallazgo de revisión adversarial).
    lines.length = 0;
    app.log.info({ headers: { ...SECRETS, 'set-cookie': 'fluvia_session=x' } }, 'wiring-probe');
    const probe = lines.find((l) => l.includes('wiring-probe'));
    expect(probe).toBeTruthy();
    const parsed = JSON.parse(probe!) as { headers: Record<string, string> };
    for (const header of [...Object.keys(SECRETS), 'set-cookie']) {
      expect(parsed.headers[header]).toBe('[REDACTED]');
    }
    for (const secret of Object.values(SECRETS)) {
      expect(probe).not.toContain(secret);
    }
  });

  it('a real request carrying credentials in EVERY sensitive header leaks nothing', async () => {
    lines.length = 0;
    const res = await app.inject({ method: 'GET', url: '/health', headers: SECRETS });
    expect(res.statusCode).toBe(200);

    const output = lines.join('');
    // Sanidad anti-vacuidad: el request SÍ se logueó (si nadie loguea, la
    // aserción de abajo no probaría nada).
    expect(output).toContain('request completed');
    for (const secret of Object.values(SECRETS)) {
      // Solo el VALOR importa: no debe aparecer en NINGUNA línea, venga del
      // serializer que venga (hoy o mañana).
      expect(output).not.toContain(secret);
    }
  });
});
