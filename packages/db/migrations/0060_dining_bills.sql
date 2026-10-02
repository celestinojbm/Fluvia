-- ============================================================================
-- FLUVIA 0060_dining_bills.sql  (jornada restaurantes y cobro presencial)
--
-- CUENTA del pedido y ASIGNACIÓN DE PAGOS (cuenta completa o dividida).
--
-- El modelo existente admite UN cobro por venta (link de cobro único, 0046).
-- Dividir no crea ventas sueltas: cada fracción es una ASIGNACIÓN de la
-- cuenta con su propio link de cobro único (mismo comercio, misma moneda),
-- de modo que cada fracción hereda las guardas existentes (un solo intent
-- puede cobrar, incierto retiene, devolución por intent) y TODAS quedan
-- atadas a la cuenta.
--
-- Invariantes en el MOTOR (constraint trigger diferido, al COMMIT):
--   Σ importes de asignaciones vivas ≤ total de la cuenta (sumas exactas en
--   unidades menores; el remanente es total − Σ vivas);
--   una línea está en a lo sumo UNA asignación por artículos viva;
--   el link de cada asignación es de cobro único, del mismo comercio, por el
--   mismo importe y moneda.
-- «Viva» = no anulada. Una asignación solo se anula si su link no tiene un
-- intent que cobró o pueda estar cobrando (lo verifica el servicio con el
-- link bloqueado; el índice único de 0046 es la garantía final).
-- La cuenta pasa a `paid` SOLO tras verificar en el servidor que los intents
-- confirmados suman el total — nunca por un callback del cliente.
-- ============================================================================

CREATE TABLE dining_bills (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  order_id    UUID NOT NULL,
  merchant_id UUID NOT NULL,
  currency    CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total       BIGINT NOT NULL CHECK (total > 0 AND total <= 9007199254740991),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  version     INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (order_id, tenant_id) REFERENCES dining_orders (id, tenant_id),
  FOREIGN KEY (merchant_id, tenant_id) REFERENCES merchants (id, tenant_id)
);
-- Una sola cuenta no anulada por pedido.
CREATE UNIQUE INDEX dining_bills_one_live_per_order ON dining_bills (order_id)
  WHERE status <> 'void';

-- Copia de las líneas facturadas (precio histórico, para la cuenta y el
-- justificante, aunque luego se anulen líneas del pedido).
CREATE TABLE dining_bill_lines (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES organizations(id),
  bill_id    UUID NOT NULL,
  line_id    UUID NOT NULL,
  name       TEXT NOT NULL,
  quantity   INT NOT NULL CHECK (quantity >= 1),
  line_total BIGINT NOT NULL CHECK (line_total > 0),
  modifiers  JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (bill_id, line_id),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (bill_id, tenant_id) REFERENCES dining_bills (id, tenant_id)
);

CREATE TABLE dining_bill_allocations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id),
  bill_id         UUID NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('full', 'amount', 'items')),
  amount          BIGINT NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  currency        CHAR(3) NOT NULL,
  payment_link_id UUID NOT NULL UNIQUE,
  label           TEXT CHECK (label IS NULL OR char_length(label) <= 60),
  voided_at       TIMESTAMPTZ,
  void_reason     TEXT CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 3 AND 140),
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (bill_id, tenant_id) REFERENCES dining_bills (id, tenant_id),
  FOREIGN KEY (payment_link_id, tenant_id) REFERENCES payment_links (id, tenant_id),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX dining_bill_allocations_bill_idx ON dining_bill_allocations (bill_id);

CREATE TABLE dining_bill_allocation_items (
  tenant_id     UUID NOT NULL REFERENCES organizations(id),
  allocation_id UUID NOT NULL,
  bill_line_id  UUID NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (allocation_id, bill_line_id),
  FOREIGN KEY (allocation_id, tenant_id) REFERENCES dining_bill_allocations (id, tenant_id),
  FOREIGN KEY (bill_line_id, tenant_id) REFERENCES dining_bill_lines (id, tenant_id)
);
-- Un artículo en a lo sumo una asignación viva.
CREATE UNIQUE INDEX dining_bill_allocation_items_one_live
  ON dining_bill_allocation_items (bill_line_id) WHERE active;

-- ----------------------------------------------------------------------------
-- Invariantes al COMMIT
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluvia_dining_bill_check()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_bill UUID;
  v_total BIGINT;
  v_currency TEXT;
  v_merchant UUID;
  v_sum BIGINT;
  v_bad INT;
BEGIN
  v_bill := CASE TG_TABLE_NAME WHEN 'dining_bills' THEN NEW.id ELSE NEW.bill_id END;
  SELECT total, currency, merchant_id INTO v_total, v_currency, v_merchant
    FROM dining_bills WHERE id = v_bill;
  SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM dining_bill_allocations WHERE bill_id = v_bill AND voided_at IS NULL;
  IF v_sum > v_total THEN
    RAISE EXCEPTION 'FLUVIA_BILL_OVERALLOCATED: allocations % exceed bill total %', v_sum, v_total
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_bad
    FROM dining_bill_allocations a JOIN payment_links l ON l.id = a.payment_link_id
   WHERE a.bill_id = v_bill
     AND (NOT l.single_charge OR l.amount <> a.amount OR l.currency <> a.currency
          OR a.currency <> v_currency OR l.merchant_id <> v_merchant);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'FLUVIA_BILL_LINK_MISMATCH: allocation link must be single-charge, same merchant, amount and currency'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER dining_bill_allocations_invariant
  AFTER INSERT OR UPDATE ON dining_bill_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fluvia_dining_bill_check();
CREATE CONSTRAINT TRIGGER dining_bills_invariant
  AFTER UPDATE ON dining_bills DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fluvia_dining_bill_check();

-- Importe y vínculo de una asignación son inmutables; solo se anula.
CREATE OR REPLACE FUNCTION fluvia_dining_allocation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.payment_link_id IS DISTINCT FROM OLD.payment_link_id
     OR NEW.bill_id IS DISTINCT FROM OLD.bill_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR (OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at) THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: bill allocation can only be voided once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dining_bill_allocations_guard
  BEFORE UPDATE ON dining_bill_allocations
  FOR EACH ROW EXECUTE FUNCTION fluvia_dining_allocation_guard();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['dining_bills', 'dining_bill_lines', 'dining_bill_allocations',
                           'dining_bill_allocation_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON dining_bills, dining_bill_lines, dining_bill_allocations,
  dining_bill_allocation_items TO fluvia_app;
CREATE TRIGGER dining_bill_lines_no_update
  BEFORE UPDATE ON dining_bill_lines FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
