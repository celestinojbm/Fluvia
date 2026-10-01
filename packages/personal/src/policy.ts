import { z } from 'zod';

/**
 * Política de crédito VERSIONADA y configurable. Los parámetros se validan aquí
 * y se guardan como snapshot en `credit_policies.params`; toda decisión guarda
 * la versión aplicada. Nada de esto es una condición comercial: la política de
 * referencia es sintética y está marcada como pendiente de validación.
 */

const minor = z
  .string()
  .regex(/^[0-9]{1,16}$/, 'unidades menores como entero decimal')
  .transform((s) => BigInt(s));

const tierSchema = z.object({
  tier: z.enum(['A', 'B', 'C', 'D']),
  /** null ⇒ el nivel se rechaza. Basis points: 10000 = ×1. */
  multiplierBps: z.number().int().min(1).max(100_000).nullable(),
});

const currencyRulesSchema = z.object({
  minCollateral: minor,
  maxLimit: minor,
  manualReviewAbove: minor,
});

export const PolicyParamsSchema = z
  .object({
    /** Tope absoluto del multiplicador (la referencia usa ×4 como máximo ilustrativo). */
    maxMultiplierBps: z.number().int().min(1).max(100_000),
    tiers: z.array(tierSchema).length(4),
    currencies: z.record(z.string().regex(/^[A-Z]{3}$/), currencyRulesSchema),
    installmentCounts: z.array(z.number().int().min(1).max(24)).min(1).max(8),
    intervalDays: z.number().int().min(1).max(92),
    downPaymentBps: z.number().int().min(0).max(10_000),
    interestBps: z.number().int().min(0).max(50_000),
    lateFeeBps: z.number().int().min(0).max(5_000),
    graceDays: z.number().int().min(0).max(60),
    collateralApplication: z.enum(['manual_operator', 'disabled']),
    authorizationTtlHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 31),
    /** Al menos un nivel debe rechazar (D) para que la política sea prudente. */
  })
  .superRefine((p, ctx) => {
    const tiers = new Set(p.tiers.map((t) => t.tier));
    if (tiers.size !== 4) ctx.addIssue({ code: 'custom', message: 'tiers A–D exactly once' });
    for (const t of p.tiers) {
      if (t.multiplierBps !== null && t.multiplierBps > p.maxMultiplierBps) {
        ctx.addIssue({ code: 'custom', message: `tier ${t.tier} exceeds maxMultiplierBps` });
      }
    }
    for (const [ccy, r] of Object.entries(p.currencies)) {
      if (r.manualReviewAbove > r.maxLimit) {
        ctx.addIssue({ code: 'custom', message: `${ccy}: manualReviewAbove > maxLimit` });
      }
    }
  });

export type PolicyParams = z.infer<typeof PolicyParamsSchema>;
export type PolicyParamsInput = z.input<typeof PolicyParamsSchema>;

/**
 * Política de REFERENCIA `ref-sandbox` v1 — SINTÉTICA, para probar el ciclo
 * completo. Tasas, mora y comisiones en 0: el motor las admite, pero sus
 * valores están pendientes de validación comercial.
 */
export const REFERENCE_POLICY_CODE = 'ref-sandbox';
export const REFERENCE_POLICY_PARAMS: PolicyParamsInput = {
  maxMultiplierBps: 40_000,
  tiers: [
    { tier: 'A', multiplierBps: 40_000 },
    { tier: 'B', multiplierBps: 30_000 },
    { tier: 'C', multiplierBps: 20_000 },
    { tier: 'D', multiplierBps: null },
  ],
  currencies: {
    // VES: mínimos y máximos ilustrativos en céntimos de bolívar.
    VES: { minCollateral: '500000', maxLimit: '20000000', manualReviewAbove: '8000000' },
    USD: { minCollateral: '2000', maxLimit: '200000', manualReviewAbove: '100000' },
    COP: { minCollateral: '5000000', maxLimit: '2000000000', manualReviewAbove: '800000000' },
  },
  installmentCounts: [1, 3, 6],
  intervalDays: 30,
  downPaymentBps: 2_500,
  interestBps: 0,
  lateFeeBps: 0,
  graceDays: 5,
  collateralApplication: 'manual_operator',
  authorizationTtlHours: 168,
};

export function parsePolicyParams(raw: unknown): PolicyParams {
  return PolicyParamsSchema.parse(raw);
}

/** Forma serializable (bigint → string) para guardar en JSONB. */
export function serializePolicyParams(p: PolicyParams): Record<string, unknown> {
  return JSON.parse(JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export type RiskTier = 'A' | 'B' | 'C' | 'D';

export interface EvaluationInput {
  currency: string;
  requestedLimit: bigint;
  collateral: bigint;
  /** Perfil DECLARADO y sintético (sandbox). Jamás verificado. */
  syntheticProfile: RiskTier;
  /** Historial interno real del programa. */
  history: { overdueInstallments: number; paidInstallments: number };
}

export interface EvaluationReason {
  code: string;
  message: string;
}

export interface Evaluation {
  status: 'approved' | 'rejected' | 'manual_review';
  tier: RiskTier;
  multiplierBps: number | null;
  proposedLimit: bigint;
  reasons: EvaluationReason[];
  inputs: Record<string, string | number>;
}

const TIER_ORDER: RiskTier[] = ['A', 'B', 'C', 'D'];

function downgrade(t: RiskTier): RiskTier {
  return TIER_ORDER[Math.min(TIER_ORDER.indexOf(t) + 1, 3)]!;
}

/** Evaluación PURA (determinista, probada por tabla). */
export function evaluateApplication(policy: PolicyParams, input: EvaluationInput): Evaluation {
  const reasons: EvaluationReason[] = [];
  const rules = policy.currencies[input.currency];
  const inputs = {
    currency: input.currency,
    requested_limit: input.requestedLimit.toString(),
    collateral: input.collateral.toString(),
    synthetic_profile: input.syntheticProfile,
    overdue_installments: input.history.overdueInstallments,
    paid_installments: input.history.paidInstallments,
  };
  reasons.push({
    code: 'synthetic_profile',
    message: `Perfil de riesgo declarado (dato sintético de prueba, no verificado): ${input.syntheticProfile}.`,
  });
  if (!rules) {
    reasons.push({
      code: 'currency_not_in_policy',
      message: `La política no cubre ${input.currency}.`,
    });
    return {
      status: 'rejected',
      tier: 'D',
      multiplierBps: null,
      proposedLimit: 0n,
      reasons,
      inputs,
    };
  }
  let tier = input.syntheticProfile;
  if (input.history.overdueInstallments > 0) {
    tier = downgrade(tier);
    reasons.push({
      code: 'internal_overdue',
      message: `Tiene ${input.history.overdueInstallments} cuota(s) vencida(s) en Fluvia: el nivel baja a ${tier}.`,
    });
  }
  const tierDef = policy.tiers.find((t) => t.tier === tier)!;
  if (tierDef.multiplierBps === null) {
    reasons.push({ code: 'tier_rejected', message: `El nivel ${tier} no admite crédito.` });
    return { status: 'rejected', tier, multiplierBps: null, proposedLimit: 0n, reasons, inputs };
  }
  if (input.collateral < rules.minCollateral) {
    reasons.push({
      code: 'collateral_below_minimum',
      message: 'La garantía bloqueada no alcanza el mínimo de la política.',
    });
    return {
      status: 'rejected',
      tier,
      multiplierBps: tierDef.multiplierBps,
      proposedLimit: 0n,
      reasons,
      inputs,
    };
  }
  const byCollateral = (input.collateral * BigInt(tierDef.multiplierBps)) / 10_000n;
  let proposed = input.requestedLimit;
  if (byCollateral < proposed) {
    proposed = byCollateral;
    reasons.push({
      code: 'capped_by_collateral',
      message: `Limitado por la garantía: ${tierDef.multiplierBps / 10_000}× la garantía bloqueada.`,
    });
  }
  if (rules.maxLimit < proposed) {
    proposed = rules.maxLimit;
    reasons.push({ code: 'capped_by_policy', message: 'Limitado por el máximo de la política.' });
  }
  if (proposed <= 0n) {
    reasons.push({ code: 'zero_limit', message: 'El límite resultante es cero.' });
    return {
      status: 'rejected',
      tier,
      multiplierBps: tierDef.multiplierBps,
      proposedLimit: 0n,
      reasons,
      inputs,
    };
  }
  if (proposed > rules.manualReviewAbove) {
    reasons.push({
      code: 'manual_review_threshold',
      message:
        'El importe supera el umbral de revisión manual: lo decide una persona de Operaciones.',
    });
    return {
      status: 'manual_review',
      tier,
      multiplierBps: tierDef.multiplierBps,
      proposedLimit: proposed,
      reasons,
      inputs,
    };
  }
  reasons.push({ code: 'approved', message: 'Cumple la política vigente.' });
  return {
    status: 'approved',
    tier,
    multiplierBps: tierDef.multiplierBps,
    proposedLimit: proposed,
    reasons,
    inputs,
  };
}

/**
 * Garantía requerida para cubrir una exposición con un multiplicador:
 * ceil(exposición × 10000 / multiplicador).
 */
export function requiredCollateral(exposure: bigint, multiplierBps: number): bigint {
  if (exposure <= 0n) return 0n;
  const m = BigInt(multiplierBps);
  return (exposure * 10_000n + m - 1n) / m;
}

/** Inicial de una compra en cuotas: ceil(importe × bps / 10000). */
export function downPaymentFor(amount: bigint, downPaymentBps: number): bigint {
  if (downPaymentBps <= 0) return 0n;
  return (amount * BigInt(downPaymentBps) + 9_999n) / 10_000n;
}
