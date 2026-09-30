import { existsSync, rmSync } from 'node:fs';
import { loadConfig } from '@fluvia/config';
import { MockPaymentProvider, ProviderTimeoutError } from '@fluvia/payments-core';

/**
 * Lanzador de VERIFICACIÓN LOCAL (no es un entrypoint de producto): arranca la
 * API real (`src/server.ts`: PG, Redis, MockProvider, mismas rutas) con UNA
 * sola diferencia — si existe el fichero `FLUVIA_E2E_REFUND_TIMEOUT_FLAG`, la
 * SIGUIENTE devolución enviada al MockProvider lanza `ProviderTimeoutError`
 * (el fichero se borra: es de un solo uso).
 *
 * Por qué: `MockPaymentProvider.refundPayment` aprueba siempre, así que por la
 * vía de producto no se puede llegar a un refund `indeterminate`. Con este
 * timeout el `RefundService` real recorre su rama de desenlace desconocido
 * (reserva retenida, estado `indeterminate`) y el POS y el justificante leen
 * ese estado por las lecturas reales. Es el mismo mecanismo que usan los tests
 * con adapters inyectados, pero sobre el servidor HTTP completo.
 *
 * Guard: solo `local`/`test` y solo con la bandera definida.
 */
const config = loadConfig();
if (config.env !== 'local' && config.env !== 'test') {
  throw new Error(`refund-timeout-server is local/test only (env=${config.env})`);
}
const flag = process.env.FLUVIA_E2E_REFUND_TIMEOUT_FLAG;
if (!flag) throw new Error('FLUVIA_E2E_REFUND_TIMEOUT_FLAG is required');

const approve = MockPaymentProvider.prototype.refundPayment;
MockPaymentProvider.prototype.refundPayment = function (input) {
  if (existsSync(flag)) {
    rmSync(flag, { force: true });
    return Promise.reject(new ProviderTimeoutError('mock (e2e refund timeout)'));
  }
  return approve.call(this, input);
};

await import('../src/server.js');
