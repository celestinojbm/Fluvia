-- ============================================================================
-- FLUVIA 0064_shops_consumer_rls.sql
--
-- Defensa en profundidad para las tablas del CLIENTE de 0063: además del
-- tenant del programa, la fila debe ser del cliente de la transacción
-- (`app.consumer_id`, fijado por withProgramTx en el plano del cliente), igual
-- que el resto de Fluvia Personal (0052). La operación (sin consumer_id) ve
-- todas las del programa.
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['consumer_shop_favorites', 'consumer_cart_items',
                           'consumer_shop_orders'] LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_consumer_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid
                AND fluvia_consumer_visible(consumer_id))
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid
                     AND fluvia_consumer_visible(consumer_id))', t);
  END LOOP;
END $$;
