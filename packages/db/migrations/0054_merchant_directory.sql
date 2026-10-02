-- ============================================================================
-- FLUVIA 0054_merchant_directory.sql  (jornada presentación — «Dónde comprar»)
--
-- Perfil PÚBLICO de un comercio en el directorio. Reglas:
--  * Visibilidad EXPLÍCITA: un perfil nace en 'draft' y solo pasa a
--    'published' por una acción del comercio (merchants:write), auditada. Nada
--    publica automáticamente a todos los comercios.
--  * Solo campos que el comercio redacta para el público (nombre comercial,
--    categoría, ciudad, zona, resumen, canales, foto del conjunto cerrado). No
--    se exponen datos de la organización (razón social, miembros, importes,
--    estado de cuenta ni identificadores internos).
--  * `is_demo`: los registros sintéticos del seed se marcan y la UI lo dice.
--  * No declara qué servicios financieros ofrece el comercio: esa
--    disponibilidad no se inventa.
--
-- Tabla por tenant (RLS forzado). La lectura pública cruza tenants y va por
-- funciones SECURITY DEFINER de solo lectura que devuelven SOLO perfiles
-- publicados de comercios activos (patrón de payment_link_resolve, 0025).
-- Clasificación de datos: pública cuando 'published'; interna mientras 'draft'
-- u 'hidden'.
-- ============================================================================

CREATE TABLE merchant_directory_profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES organizations(id),
  merchant_id   UUID NOT NULL,
  slug          TEXT NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  display_name  TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  category      TEXT NOT NULL CHECK (category IN (
                  'alimentacion', 'restaurantes', 'moda', 'hogar',
                  'tecnologia', 'salud', 'papeleria', 'servicios')),
  city          TEXT NOT NULL CHECK (char_length(city) BETWEEN 1 AND 60),
  area          TEXT CHECK (area IS NULL OR char_length(area) BETWEEN 1 AND 60),
  summary       TEXT CHECK (summary IS NULL OR char_length(summary) <= 280),
  channels      TEXT[] NOT NULL DEFAULT '{in_store}'
                  CHECK (cardinality(channels) BETWEEN 1 AND 2
                     AND channels <@ ARRAY['in_store', 'online']::text[]),
  photo_ref     TEXT CHECK (photo_ref IS NULL OR photo_ref ~ '^presentacion/[a-z0-9-]{1,40}\.jpg$'),
  visibility    TEXT NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft', 'published', 'hidden')),
  is_demo       BOOLEAN NOT NULL DEFAULT false,
  published_at  TIMESTAMPTZ,
  version       INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merchant_directory_slug_uniq UNIQUE (slug),
  CONSTRAINT merchant_directory_merchant_uniq UNIQUE (tenant_id, merchant_id),
  CONSTRAINT merchant_directory_merchant_fk
    FOREIGN KEY (merchant_id, tenant_id) REFERENCES merchants (id, tenant_id),
  CONSTRAINT merchant_directory_published_chk
    CHECK ((visibility = 'published') = (published_at IS NOT NULL))
);

CREATE INDEX merchant_directory_public_idx
  ON merchant_directory_profiles (category, city) WHERE visibility = 'published';

-- Sin DELETE/TRUNCATE: la baja es visibility = 'hidden'.
CREATE TRIGGER merchant_directory_no_delete
  BEFORE DELETE ON merchant_directory_profiles
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER merchant_directory_no_truncate
  BEFORE TRUNCATE ON merchant_directory_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

ALTER TABLE merchant_directory_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_directory_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merchant_directory_profiles
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON merchant_directory_profiles TO fluvia_app;

-- ----------------------------------------------------------------------------
-- Lectura pública (cross-tenant), SOLO perfiles publicados de comercios
-- activos de organizaciones vigentes. Devuelve exclusivamente columnas
-- públicas: jamás tenant_id ni merchant_id.
-- ----------------------------------------------------------------------------
CREATE FUNCTION directory_search(
  p_pattern  TEXT,   -- patrón ILIKE ya escapado por la app, o NULL
  p_category TEXT,
  p_city     TEXT,
  p_limit    INT,
  p_offset   INT
)
RETURNS TABLE (
  slug TEXT, display_name TEXT, category TEXT, city TEXT, area TEXT,
  summary TEXT, channels TEXT[], photo_ref TEXT, is_demo BOOLEAN,
  published_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.slug, d.display_name, d.category, d.city, d.area, d.summary,
         d.channels, d.photo_ref, d.is_demo, d.published_at
    FROM merchant_directory_profiles d
    JOIN merchants m ON m.id = d.merchant_id AND m.tenant_id = d.tenant_id
                    AND m.status = 'active' AND m.deleted_at IS NULL
    JOIN organizations o ON o.id = d.tenant_id AND o.deleted_at IS NULL
   WHERE d.visibility = 'published'
     AND (p_category IS NULL OR d.category = p_category)
     AND (p_city IS NULL OR lower(d.city) = lower(p_city))
     AND (p_pattern IS NULL
          OR d.display_name ILIKE p_pattern ESCAPE '\'
          OR d.summary ILIKE p_pattern ESCAPE '\'
          OR d.area ILIKE p_pattern ESCAPE '\')
   ORDER BY d.display_name, d.slug
   LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;

CREATE FUNCTION directory_profile(p_slug TEXT)
RETURNS TABLE (
  slug TEXT, display_name TEXT, category TEXT, city TEXT, area TEXT,
  summary TEXT, channels TEXT[], photo_ref TEXT, is_demo BOOLEAN,
  published_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.slug, d.display_name, d.category, d.city, d.area, d.summary,
         d.channels, d.photo_ref, d.is_demo, d.published_at
    FROM merchant_directory_profiles d
    JOIN merchants m ON m.id = d.merchant_id AND m.tenant_id = d.tenant_id
                    AND m.status = 'active' AND m.deleted_at IS NULL
    JOIN organizations o ON o.id = d.tenant_id AND o.deleted_at IS NULL
   WHERE d.visibility = 'published' AND d.slug = p_slug;
$$;

-- Ciudades con al menos un perfil publicado (para el filtro).
CREATE FUNCTION directory_cities()
RETURNS TABLE (city TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT d.city
    FROM merchant_directory_profiles d
    JOIN merchants m ON m.id = d.merchant_id AND m.tenant_id = d.tenant_id
                    AND m.status = 'active' AND m.deleted_at IS NULL
    JOIN organizations o ON o.id = d.tenant_id AND o.deleted_at IS NULL
   WHERE d.visibility = 'published'
   ORDER BY d.city;
$$;

REVOKE ALL ON FUNCTION directory_search(TEXT, TEXT, TEXT, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION directory_profile(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION directory_cities() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION directory_search(TEXT, TEXT, TEXT, INT, INT) TO fluvia_app;
GRANT EXECUTE ON FUNCTION directory_profile(TEXT) TO fluvia_app;
GRANT EXECUTE ON FUNCTION directory_cities() TO fluvia_app;
