-- ============================================================================
-- FLUVIA 0066_fx_reference_rates.sql
--
-- Tasas de REFERENCIA para mostrar equivalencias (nunca para cobrar, liquidar
-- ni convertir fondos). Datos públicos y GLOBALES de la plataforma, sin
-- tenant: una sola lectura compartida por todas las organizaciones y
-- réplicas (la caché compartida del requisito).
--
--  - fx_rate_readings: APPEND-ONLY. Cada lectura conserva su fuente, su fecha
--    aplicable (Fecha Valor del BCV) o la hora de la fuente (CoinGecko) y la
--    hora en que NUESTRO servidor la consultó. Nunca se actualiza para
--    «refrescar» su timestamp: una lectura nueva es otra fila.
--  - fx_source_status: último intento / éxito / error por fuente, para avisar
--    de caídas sin tocar las lecturas válidas.
-- ============================================================================

CREATE TABLE fx_rate_readings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source            TEXT NOT NULL CHECK (source IN ('bcv', 'coingecko', 'fixture')),
  base              TEXT NOT NULL CHECK (base IN ('USD', 'EUR', 'USDT')),
  quote             TEXT NOT NULL CHECK (quote IN ('VES', 'USD')),
  -- Decimal exacto en texto normalizado; > 0 (nunca cero ni negativo).
  rate              NUMERIC(30, 12) NOT NULL CHECK (rate > 0),
  method            TEXT NOT NULL CHECK (method IN ('official_reference', 'market_aggregate', 'test_fixture')),
  -- BCV: «Fecha Valor» (día en que rige, America/Caracas). NULL en mercado.
  value_date        DATE,
  -- BCV: fecha de operación (si la publica). CoinGecko: NULL.
  operation_date    DATE,
  -- CoinGecko: last_updated_at de la fuente. BCV: NULL (publica fechas, no horas).
  source_updated_at TIMESTAMPTZ,
  -- Hora en que NUESTRO servidor obtuvo el dato.
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- De dónde salió (portada, histórico XLS, API) para auditoría.
  origin            TEXT NOT NULL CHECK (char_length(origin) BETWEEN 3 AND 300),
  CHECK (source <> 'bcv' OR (value_date IS NOT NULL AND quote = 'VES' AND base IN ('USD', 'EUR'))),
  CHECK (source <> 'coingecko' OR (source_updated_at IS NOT NULL AND base = 'USDT' AND quote = 'USD'))
);
-- Una Fecha Valor del BCV se guarda una sola vez por par (re-consultas = no-op).
CREATE UNIQUE INDEX fx_rate_readings_bcv_uq
  ON fx_rate_readings (source, base, quote, value_date) WHERE value_date IS NOT NULL;
-- Una actualización de mercado se guarda una sola vez (misma hora de fuente).
CREATE UNIQUE INDEX fx_rate_readings_market_uq
  ON fx_rate_readings (source, base, quote, source_updated_at) WHERE source_updated_at IS NOT NULL;
CREATE INDEX fx_rate_readings_lookup
  ON fx_rate_readings (base, quote, value_date DESC, fetched_at DESC);

CREATE TRIGGER fx_rate_readings_no_update
  BEFORE UPDATE OR DELETE ON fx_rate_readings
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

CREATE TABLE fx_source_status (
  source               TEXT PRIMARY KEY CHECK (source IN ('bcv', 'coingecko')),
  last_attempt_at      TIMESTAMPTZ,
  last_success_at      TIMESTAMPTZ,
  last_error           TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  consecutive_failures INT NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)
);
INSERT INTO fx_source_status (source) VALUES ('bcv'), ('coingecko');

-- Datos públicos globales: RLS activada y forzada con una política explícita
-- (lectura y alta libres para el rol de la app; sin borrado para nadie).
ALTER TABLE fx_rate_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rate_readings FORCE ROW LEVEL SECURITY;
CREATE POLICY fx_public_reference ON fx_rate_readings USING (true) WITH CHECK (true);
ALTER TABLE fx_source_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_source_status FORCE ROW LEVEL SECURITY;
CREATE POLICY fx_public_status ON fx_source_status USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON fx_rate_readings TO fluvia_app;
GRANT SELECT, UPDATE ON fx_source_status TO fluvia_app;
