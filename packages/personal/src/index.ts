import type { Pool } from '@fluvia/db';
import { LedgerService, ProgramPostingService } from '@fluvia/ledger';
import { SqlProviderOperationStore } from '@fluvia/payments-core';
import {
  SimulatedCardIssuer,
  SimulatedFundingProvider,
  type CardIssuerAdapter,
  type FundingProviderAdapter,
} from './adapters.js';
import { AuthorizationService } from './authorizations.js';
import { CardService } from './cards.js';
import { CaseService } from './cases.js';
import { ConsumerAuthService } from './consumer-auth.js';
import { CollateralService, CreditService } from './credit.js';
import { ProgramReconciliationService, ProviderEventService } from './events.js';
import { ProgramService } from './program.js';
import { WalletService } from './wallet.js';

export * from './errors.js';
export * from './adapters.js';
export * from './policy.js';
export * from './context.js';
export * from './program.js';
export * from './consumer-auth.js';
export * from './wallet.js';
export * from './credit.js';
export * from './cards.js';
export * from './authorizations.js';
export * from './cases.js';
export * from './events.js';
export * from './network.js';

export interface PersonalServices {
  programs: ProgramService;
  consumerAuth: ConsumerAuthService;
  wallet: WalletService;
  collateral: CollateralService;
  credit: CreditService;
  cards: CardService;
  authorizations: AuthorizationService;
  cases: CaseService;
  events: ProviderEventService;
  reconciliation: ProgramReconciliationService;
  posting: ProgramPostingService;
  issuer: CardIssuerAdapter;
  funding: FundingProviderAdapter;
}

/**
 * Cableado del programa con adaptadores SIMULADOS por defecto. Un despliegue
 * con proveedores reales pasa sus adaptadores (`issuer`, `funding`).
 */
export function createPersonalServices(
  pools: { app: Pool; auth: Pool },
  adapters: { issuer?: CardIssuerAdapter; funding?: FundingProviderAdapter } = {}
): PersonalServices {
  const posting = new ProgramPostingService(new LedgerService(pools.app));
  const store = new SqlProviderOperationStore(pools.app);
  const issuer = adapters.issuer ?? new SimulatedCardIssuer();
  const funding = adapters.funding ?? new SimulatedFundingProvider(store);
  const wallet = new WalletService(pools.app, posting, funding);
  const credit = new CreditService(pools.app, posting);
  const cards = new CardService(pools.app, issuer);
  const authorizations = new AuthorizationService(pools.app, posting, credit);
  return {
    programs: new ProgramService(pools.app),
    consumerAuth: new ConsumerAuthService(pools.auth),
    wallet,
    collateral: new CollateralService(pools.app, posting),
    credit,
    cards,
    authorizations,
    cases: new CaseService(pools.app),
    events: new ProviderEventService(pools.app, { wallet, authorizations, cards }),
    reconciliation: new ProgramReconciliationService(pools.app),
    posting,
    issuer,
    funding,
  };
}
