/**
 * #92 — comercio congelado (`merchants.status = 'frozen'`).
 *
 * Lo hace cumplir el MOTOR (migración 0069): un INSERT en `payment_intents`,
 * `payment_attempts` o `payouts`, o la emisión `requested -> in_transit` de un
 * payout, de un comercio que no está activo falla con
 * {@link MERCHANT_FROZEN_SQLSTATE}. Congelar/descongelar es plano de
 * plataforma (`MerchantRiskAdmin` en @fluvia/identity).
 */
export const MERCHANT_FROZEN_SQLSTATE = 'FV453';

/** ¿El error viene del guard de comercio congelado? (pg propaga `code` = SQLSTATE). */
export function isMerchantFrozenDbError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === MERCHANT_FROZEN_SQLSTATE
  );
}
