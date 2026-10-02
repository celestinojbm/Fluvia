-- ============================================================================
-- FLUVIA 0059_dining_orders.sql  (jornada restaurantes y cobro presencial)
--
-- Pedido de sala (mesa, para llevar, recogida) y comandas de cocina.
--
-- Tres ejes SEPARADOS:
--   dining_orders.status         ciclo del pedido (abierto, cuenta pedida,
--                                cerrado…); «listo» no es «pagado».
--   dining_order_lines.prep_status preparación de CADA línea.
--   pago                         se deriva de la cuenta y sus asignaciones
--                                (0060) — nunca se guarda aquí por asunción.
--
-- Líneas: copia histórica de nombre, precio base y modificadores (snapshot
-- JSON) — el pedido no cambia si cambia el catálogo. Un trigger impide
-- reescribir esos campos; una línea ya ENVIADA a cocina solo puede anularse
-- (con motivo y autor), lo que genera una comanda de anulación: lo que cocina
-- recibió jamás se sobrescribe en silencio.
--
-- Comandas (kitchen_tickets): cada envío crea comandas NUEVAS por estación
-- con número y revisión del pedido; las líneas añadidas después van en una
-- revisión posterior. Estados: queued → accepted → preparing → ready →
-- delivered; «recuperar» (ready/delivered → preparing) exige motivo.
--
-- dining_events: registro append-only con secuencia global (seq) — la
-- pantalla de cocina se sincroniza «desde seq» tras una desconexión, sin
-- perder ni duplicar comandas. También es la auditoría de mover mesa, anular
-- y aceptar/rechazar pedidos de clientes.
-- ============================================================================

CREATE TABLE dining_order_counters (
  tenant_id   UUID PRIMARY KEY REFERENCES organizations(id),
  last_number BIGINT NOT NULL CHECK (last_number >= 0)
);

CREATE TABLE dining_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES organizations(id),
  branch_id     UUID NOT NULL,
  number        BIGINT NOT NULL CHECK (number >= 1),
  mode          TEXT NOT NULL CHECK (mode IN ('dine_in', 'takeaway', 'pickup')),
  table_id      UUID,
  source        TEXT NOT NULL CHECK (source IN ('staff', 'customer')),
  status        TEXT NOT NULL CHECK (status IN (
                  'pending_acceptance', 'open', 'bill_requested', 'closed',
                  'cancelled', 'rejected')),
  currency      CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  guest_count   INT CHECK (guest_count IS NULL OR guest_count BETWEEN 1 AND 50),
  customer_name TEXT CHECK (customer_name IS NULL OR char_length(customer_name) <= 60),
  note          TEXT CHECK (note IS NULL OR char_length(note) <= 280),
  -- Seguimiento del cliente (QR): hash del token privado que solo tiene quien
  -- hizo el pedido. El QR de la mesa NO da acceso a esto.
  tracking_token_hash TEXT UNIQUE,
  attention_requested_at TIMESTAMPTZ,
  version       INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  opened_by     UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES venue_branches (id, tenant_id),
  FOREIGN KEY (table_id, branch_id) REFERENCES venue_tables (id, branch_id),
  CHECK ((mode = 'dine_in') = (table_id IS NOT NULL))
);
CREATE INDEX dining_orders_branch_idx ON dining_orders (tenant_id, branch_id, status, created_at DESC);
-- Una mesa tiene a lo sumo UNA cuenta abierta del personal a la vez.
CREATE UNIQUE INDEX dining_orders_one_open_per_table
  ON dining_orders (table_id)
  WHERE source = 'staff' AND status IN ('open', 'bill_requested');

CREATE TABLE dining_order_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id),
  order_id        UUID NOT NULL,
  seq             INT NOT NULL CHECK (seq BETWEEN 1 AND 500),
  product_id      UUID,
  name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  unit_price      BIGINT NOT NULL CHECK (unit_price > 0),
  modifiers       JSONB NOT NULL DEFAULT '[]'::jsonb,
  modifiers_total BIGINT NOT NULL DEFAULT 0 CHECK (modifiers_total >= 0),
  quantity        INT NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  line_total      BIGINT NOT NULL CHECK (line_total > 0 AND line_total <= 9007199254740991),
  currency        CHAR(3) NOT NULL,
  note            TEXT CHECK (note IS NULL OR char_length(note) <= 140),
  station_code    TEXT NOT NULL,
  -- NULL = aún no enviada a cocina.
  ticket_id       UUID,
  prep_status     TEXT NOT NULL DEFAULT 'draft' CHECK (prep_status IN (
                    'draft', 'queued', 'accepted', 'preparing', 'ready', 'delivered')),
  voided_at       TIMESTAMPTZ,
  void_reason     TEXT CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 3 AND 140),
  voided_by       UUID,
  void_ticket_id  UUID,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, seq),
  CONSTRAINT dining_order_lines_math_chk
    CHECK (line_total = (unit_price + modifiers_total) * quantity),
  CONSTRAINT dining_order_lines_void_chk
    CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  FOREIGN KEY (order_id, tenant_id) REFERENCES dining_orders (id, tenant_id),
  FOREIGN KEY (product_id, tenant_id) REFERENCES catalog_products (id, tenant_id)
);
CREATE INDEX dining_order_lines_order_idx ON dining_order_lines (order_id, seq);

CREATE TABLE kitchen_tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES organizations(id),
  branch_id    UUID NOT NULL,
  order_id     UUID NOT NULL,
  -- Número visible de la comanda (por organización) y revisión del pedido.
  number       BIGINT NOT NULL CHECK (number >= 1),
  revision     INT NOT NULL CHECK (revision >= 1),
  kind         TEXT NOT NULL CHECK (kind IN ('new', 'addition', 'void')),
  station_code TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                 'queued', 'accepted', 'preparing', 'ready', 'delivered')),
  version      INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (order_id, revision, station_code),
  FOREIGN KEY (order_id, tenant_id) REFERENCES dining_orders (id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES venue_branches (id, tenant_id)
);
CREATE INDEX kitchen_tickets_branch_idx ON kitchen_tickets (tenant_id, branch_id, status, created_at);

ALTER TABLE dining_order_lines
  ADD CONSTRAINT dining_order_lines_ticket_fk
    FOREIGN KEY (ticket_id, tenant_id) REFERENCES kitchen_tickets (id, tenant_id),
  ADD CONSTRAINT dining_order_lines_void_ticket_fk
    FOREIGN KEY (void_ticket_id, tenant_id) REFERENCES kitchen_tickets (id, tenant_id);

CREATE TABLE kitchen_ticket_counters (
  tenant_id   UUID PRIMARY KEY REFERENCES organizations(id),
  last_number BIGINT NOT NULL CHECK (last_number >= 0)
);

CREATE TABLE dining_events (
  seq        BIGSERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES organizations(id),
  branch_id  UUID NOT NULL,
  order_id   UUID,
  ticket_id  UUID,
  type       TEXT NOT NULL CHECK (char_length(type) BETWEEN 3 AND 40),
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id   UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dining_events_branch_seq_idx ON dining_events (tenant_id, branch_id, seq);
CREATE INDEX dining_events_order_idx ON dining_events (order_id, seq) WHERE order_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Inmutabilidad de las líneas (lo que cocina recibió no se reescribe)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluvia_dining_line_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
     OR NEW.modifiers IS DISTINCT FROM OLD.modifiers
     OR NEW.modifiers_total IS DISTINCT FROM OLD.modifiers_total
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.line_total IS DISTINCT FROM OLD.line_total
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.station_code IS DISTINCT FROM OLD.station_code
     OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: dining order line content cannot change (void and add instead)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ticket_id IS NOT NULL AND NEW.ticket_id IS DISTINCT FROM OLD.ticket_id THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: a sent line cannot be re-sent'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL AND (NEW.voided_at IS DISTINCT FROM OLD.voided_at
       OR NEW.prep_status IS DISTINCT FROM OLD.prep_status) THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: a voided line is final'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dining_order_lines_guard
  BEFORE UPDATE ON dining_order_lines
  FOR EACH ROW EXECUTE FUNCTION fluvia_dining_line_guard();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['dining_order_counters', 'dining_orders', 'dining_order_lines',
                           'kitchen_tickets', 'kitchen_ticket_counters', 'dining_events'] LOOP
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
GRANT SELECT, INSERT, UPDATE ON dining_order_counters, dining_orders, dining_order_lines,
  kitchen_tickets, kitchen_ticket_counters TO fluvia_app;
GRANT SELECT, INSERT ON dining_events TO fluvia_app;
GRANT USAGE ON SEQUENCE dining_events_seq_seq TO fluvia_app;
CREATE TRIGGER dining_events_append_only
  BEFORE UPDATE ON dining_events FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

-- Seguimiento del cliente: resuelve el HASH de su token privado al pedido
-- (y su organización) sin exponer nada más. El QR de la mesa no sirve aquí.
CREATE OR REPLACE FUNCTION dining_order_by_tracking(p_hash TEXT)
RETURNS TABLE (tenant_id UUID, order_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.tenant_id, o.id FROM dining_orders o WHERE o.tracking_token_hash = p_hash;
$$;
REVOKE ALL ON FUNCTION dining_order_by_tracking(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dining_order_by_tracking(TEXT) TO fluvia_app;
