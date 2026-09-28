-- =====================================================================
--  CAFÉ AROMA — PASO PREVIO SOLO PARA QUIEN YA TIENE LA BASE V2
-- ---------------------------------------------------------------------
--  ¿Cuándo usarlo?  Solo si en tu proyecto de Supabase ya ejecutaste el
--  supabase_setup.sql de la V2 y quieres conservar esos datos.
--  Si tu proyecto es nuevo o está vacío, NO necesitas este archivo.
--
--  ¿Qué hace?  Mueve las tablas y vistas de la V2 al esquema "respaldo_v2".
--  NO borra ningún dato. Después ejecuta:
--     1) 01_cafe_aroma_v3.sql   (crea la estructura nueva)
--     2) 02_migrar_datos_v2.sql (copia tus datos a la estructura nueva)
--  Ejecuta los tres seguidos (sin dejar pasar tiempo entre ellos).
-- =====================================================================
create schema if not exists respaldo_v2;

do $$
declare t text;
begin
  -- Vistas de la V2 (no contienen datos, pero se conservan por referencia)
  foreach t in array array['vista_pedidos_admin','vista_ventas_producto','vista_ventas_metodo',
                           'vista_ventas_hora','vista_inventario_alertas'] loop
    if to_regclass('public.' || t) is not null and to_regclass('respaldo_v2.' || t) is null then
      execute format('alter view public.%I set schema respaldo_v2', t);
    end if;
  end loop;

  -- Tablas de la V2
  foreach t in array array['perfiles','productos','clientes','pedidos','detalle_pedidos','favoritos',
                           'puntos_cliente','movimientos_puntos','cupones','notificaciones','resenas',
                           'insumos','recetas','mensajes_contacto'] loop
    if to_regclass('public.' || t) is not null then
      if to_regclass('respaldo_v2.' || t) is not null then
        raise exception 'Ya existe respaldo_v2.%. Parece que el respaldo ya se hizo antes; revisa antes de continuar.', t;
      end if;
      execute format('alter table public.%I set schema respaldo_v2', t);
    end if;
  end loop;
end $$;

-- Los triggers de la V2 ya no deben ejecutarse sobre el respaldo
drop trigger if exists trg_descuento_inventario on respaldo_v2.detalle_pedidos;
drop trigger if exists trg_notificar_pedido on respaldo_v2.pedidos;

select 'Respaldo listo ✅  Tus datos V2 están en el esquema respaldo_v2. Ahora ejecuta 01_cafe_aroma_v3.sql y después 02_migrar_datos_v2.sql.' as resultado;
