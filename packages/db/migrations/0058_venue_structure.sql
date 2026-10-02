-- ============================================================================
-- FLUVIA 0058_venue_structure.sql  (jornada restaurantes y cobro presencial)
--
-- Estructura del local sobre la MISMA organización y catálogo:
--   venue_branches  sucursales
--   venue_areas     salones / zonas de una sucursal
--   venue_tables    mesas con capacidad y token público OPACO para el QR
--                   (abre el menú; NO concede acceso a pedidos de nadie)
--   prep_stations   estaciones de preparación (cocina, barra…) por sucursal,
--                   con un código; los productos se enrutan por código
--   product_prep_routes, modifier_groups/options, product_modifier_groups
--   product_branch_availability  disponibilidad por sucursal
--   venue_staff     rol de local (manager/cashier/waiter/kitchen) y alcance
--                   (una sucursal o todas). Se exige en el SERVIDOR.
--
-- Catálogo: ingredientes y alérgenos los escribe el comercio; el cliente y el
-- asistente solo muestran lo que hay (sin inventar).
--
-- Aislamiento: RLS forzado por tenant + FKs compuestas (id, tenant_id).
-- ============================================================================

ALTER TABLE catalog_products
  ADD COLUMN ingredients   TEXT CHECK (ingredients IS NULL OR char_length(ingredients) <= 500),
  ADD COLUMN allergen_info TEXT CHECK (allergen_info IS NULL OR char_length(allergen_info) <= 300);

CREATE TABLE venue_branches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX venue_branches_name_uq ON venue_branches (tenant_id, lower(btrim(name)))
  WHERE archived_at IS NULL;

CREATE TABLE venue_areas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  branch_id   UUID NOT NULL,
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, branch_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES venue_branches (id, tenant_id)
);

CREATE TABLE venue_tables (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  branch_id   UUID NOT NULL,
  area_id     UUID NOT NULL,
  label       TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 20),
  capacity    INT NOT NULL CHECK (capacity BETWEEN 1 AND 50),
  -- Token público del QR: aleatorio, opaco, rotable. Solo abre el menú.
  qr_token    TEXT NOT NULL UNIQUE CHECK (qr_token ~ '^[A-Za-z0-9_-]{22,64}$'),
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, branch_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES venue_branches (id, tenant_id),
  FOREIGN KEY (area_id, branch_id) REFERENCES venue_areas (id, branch_id)
);
CREATE UNIQUE INDEX venue_tables_label_uq ON venue_tables (branch_id, lower(btrim(label)))
  WHERE archived_at IS NULL;

CREATE TABLE prep_stations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  branch_id   UUID NOT NULL,
  code        TEXT NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,23}$'),
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  archived_at TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  UNIQUE (id, branch_id),
  UNIQUE (branch_id, code),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES venue_branches (id, tenant_id)
);

-- Ruta de preparación: un producto va a la estación con ese código en la
-- sucursal del pedido (mismo catálogo para todas las sucursales).
CREATE TABLE product_prep_routes (
  tenant_id    UUID NOT NULL REFERENCES organizations(id),
  product_id   UUID NOT NULL,
  station_code TEXT NOT NULL CHECK (station_code ~ '^[a-z][a-z0-9_]{1,23}$'),
  PRIMARY KEY (product_id),
  FOREIGN KEY (product_id, tenant_id) REFERENCES catalog_products (id, tenant_id)
);

CREATE TABLE product_branch_availability (
  tenant_id  UUID NOT NULL REFERENCES organizations(id),
  product_id UUID NOT NULL,
  branch_id  UUID NOT NULL,
  available  BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, branch_id),
  FOREIGN KEY (product_id, tenant_id) REFERENCES catalog_products (id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES venue_branches (id, tenant_id)
);

CREATE TABLE modifier_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  min_select  INT NOT NULL DEFAULT 0 CHECK (min_select BETWEEN 0 AND 10),
  max_select  INT NOT NULL DEFAULT 1 CHECK (max_select BETWEEN 1 AND 10),
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CHECK (min_select <= max_select)
);

CREATE TABLE modifier_options (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  group_id    UUID NOT NULL,
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  -- Recargo en unidades menores (0 = sin coste); misma moneda que el producto.
  price_delta BIGINT NOT NULL DEFAULT 0 CHECK (price_delta >= 0 AND price_delta <= 9007199254740991),
  available   BOOLEAN NOT NULL DEFAULT true,
  position    INT NOT NULL DEFAULT 1 CHECK (position BETWEEN 1 AND 50),
  archived_at TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  UNIQUE (id, group_id),
  FOREIGN KEY (group_id, tenant_id) REFERENCES modifier_groups (id, tenant_id)
);

CREATE TABLE product_modifier_groups (
  tenant_id  UUID NOT NULL REFERENCES organizations(id),
  product_id UUID NOT NULL,
  group_id   UUID NOT NULL,
  position   INT NOT NULL DEFAULT 1 CHECK (position BETWEEN 1 AND 20),
  -- Sin DELETE para los roles de ejecución: la asociación se desactiva.
  active     BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (product_id, group_id),
  FOREIGN KEY (product_id, tenant_id) REFERENCES catalog_products (id, tenant_id),
  FOREIGN KEY (group_id, tenant_id) REFERENCES modifier_groups (id, tenant_id)
);

CREATE TABLE venue_staff (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL CHECK (role IN ('manager', 'cashier', 'waiter', 'kitchen')),
  -- NULL = todas las sucursales.
  branch_id   UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  FOREIGN KEY (branch_id, tenant_id) REFERENCES venue_branches (id, tenant_id)
);
CREATE UNIQUE INDEX venue_staff_active_uq
  ON venue_staff (tenant_id, user_id, role, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX venue_staff_user_idx ON venue_staff (tenant_id, user_id) WHERE revoked_at IS NULL;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['venue_branches', 'venue_areas', 'venue_tables', 'prep_stations',
                           'product_prep_routes', 'product_branch_availability',
                           'modifier_groups', 'modifier_options', 'product_modifier_groups',
                           'venue_staff'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO fluvia_app', t);
  END LOOP;
  -- Ningún rol de ejecución borra (meta-test): rutas y asociaciones se
  -- actualizan o desactivan; el resto es baja lógica (archived_at / revoked_at).
  FOREACH t IN ARRAY ARRAY['venue_branches', 'venue_areas', 'venue_tables', 'prep_stations',
                           'product_prep_routes', 'product_branch_availability',
                           'modifier_groups', 'modifier_options', 'product_modifier_groups',
                           'venue_staff'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t);
  END LOOP;
END $$;

-- Menú público por QR: SECURITY DEFINER, solo lo publicable de la mesa (sin
-- ids de usuarios, pedidos ni datos internos). Devuelve la sucursal/mesa y el
-- comercio; el menú se arma en la API con product_menu().
CREATE OR REPLACE FUNCTION venue_table_by_token(p_token TEXT)
RETURNS TABLE (tenant_id UUID, branch_id UUID, table_id UUID, table_label TEXT,
               branch_name TEXT, merchant_name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.tenant_id, t.branch_id, t.id, t.label, b.name,
         (SELECT m.name FROM merchants m WHERE m.tenant_id = t.tenant_id AND m.deleted_at IS NULL
           ORDER BY m.created_at LIMIT 1)
  FROM venue_tables t JOIN venue_branches b ON b.id = t.branch_id
  WHERE t.qr_token = p_token AND t.archived_at IS NULL AND b.archived_at IS NULL;
$$;
REVOKE ALL ON FUNCTION venue_table_by_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION venue_table_by_token(TEXT) TO fluvia_app;
