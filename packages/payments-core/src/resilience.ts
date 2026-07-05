import {
  ProviderTimeoutError,
  type PaymentProvider,
  type ProviderOutcome,
  type SubmitPaymentInput,
} from './provider.js';

/**
 * Resiliencia del adapter de proveedor (F3-04): decorador que envuelve
 * CUALQUIER PaymentProvider con timeout real + circuit breaker.
 *
 * Semantica de fallos — la distincion importa para el dinero:
 *  - Timeout / throw del proveedor: la peticion PUDO haber salido -> el
 *    desenlace es DESCONOCIDO -> el caller marca `indeterminate` (V4 §23).
 *  - Circuito ABIERTO: la peticion JAMAS se envio -> el desenlace es
 *    CONOCIDO (no hubo pago) -> CircuitOpenError; el caller puede fallar el
 *    attempt limpiamente como provider_unavailable, sin ambiguedad.
 *  - Un rechazo del proveedor (declined) es el proveedor FUNCIONANDO: no
 *    cuenta como fallo del circuito.
 *
 * Nivel C: breaker en memoria por proceso (como el rate limiter de F1-04b);
 * estado compartido entre replicas llega con el store compartido (PEND-006).
 */

export class CircuitOpenError extends Error {
  constructor(provider: string, retryInMs: number) {
    super(
      `Circuit for provider ${provider} is OPEN (retry in ~${Math.ceil(retryInMs / 1000)}s): request NOT sent`
    );
    this.name = 'CircuitOpenError';
  }
}

export interface ResilientProviderOptions {
  /** Tope duro de espera por submitPayment (default 10 s). */
  timeoutMs?: number;
  /** Fallos consecutivos (timeout/throw) que abren el circuito (default 5). */
  failureThreshold?: number;
  /** Tiempo con el circuito abierto antes de una sonda half-open (default 30 s). */
  cooldownMs?: number;
  /** Inyectable para tests deterministas. */
  now?: () => number;
}

type CircuitState = 'closed' | 'open' | 'half_open';

export class ResilientProvider implements PaymentProvider {
  readonly name: string;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly inner: PaymentProvider,
    options: ResilientProviderOptions = {}
  ) {
    this.name = inner.name;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (this.timeoutMs < 1 || this.failureThreshold < 1 || this.cooldownMs < 1) {
      throw new RangeError('ResilientProvider options must be >= 1');
    }
  }

  /** Visible para metricas/tests; no forma parte del contrato PaymentProvider. */
  get circuitState(): CircuitState {
    return this.state;
  }

  async submitPayment(input: SubmitPaymentInput): Promise<ProviderOutcome> {
    if (this.state === 'open') {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new CircuitOpenError(this.name, this.cooldownMs - elapsed);
      }
      // Cooldown cumplido: UNA sonda half-open decide.
      this.state = 'half_open';
    }

    try {
      const outcome = await this.withTimeout(this.inner.submitPayment(input));
      // Cualquier respuesta del proveedor (incluidos declines) = proveedor vivo.
      this.consecutiveFailures = 0;
      this.state = 'closed';
      return outcome;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (this.state === 'half_open' || this.consecutiveFailures >= this.failureThreshold) {
        this.state = 'open';
        this.openedAt = this.now();
      }
      throw err;
    }
  }

  private async withTimeout(p: Promise<ProviderOutcome>): Promise<ProviderOutcome> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProviderTimeoutError(this.name)), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // Si perdio la carrera, el rechazo tardio del proveedor no debe tumbar
      // el proceso como unhandled rejection.
      p.catch(() => undefined);
    }
  }
}
