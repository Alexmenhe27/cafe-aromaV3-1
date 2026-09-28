-- =====================================================================
--  CAFÉ AROMA — MIGRACIÓN DE DATOS V2 → V3 (opcional)
-- ---------------------------------------------------------------------
--  Requisitos: haber ejecutado 00_respaldo_v2.sql y 01_cafe_aroma_v3.sql.
--  Copia al nuevo esquema: perfiles/roles, productos (precios, imágenes y
--  disponibilidad que editaste), clientes, pedidos y su detalle, favoritos,
--  puntos, cupones, avisos, reseñas, mensajes y el stock de insumos.
--  No borra nada: el respaldo_v2 se conserva intacto.
--
--  Notas:
--  * Estados V2 → V3: pendiente → nuevo, preparando → en_preparacion
--    (listo, entregado y cancelado se conservan).
--  * La V2 descontaba inventario al crear el pedido, así que los pedidos
--    migrados se marcan como "inventario ya descontado" (no se vuelve a
--    descontar al confirmarlos).
--  * Las recetas de la V2 eran de demostración (en kg/L); se usan las nuevas
--    recetas V3 en g/ml/piezas. Revísalas en el panel > Menú y recetas.
--  * El stock de insumos se convierte a la unidad nueva (kg → g, L → ml).
-- =====================================================================
do $$
begin
  if to_regclass('respaldo_v2.pedidos') is null then
    raise exception 'No existe el esquema respaldo_v2. Ejecuta primero 00_respaldo_v2.sql y 01_cafe_aroma_v3.sql.';
  end if;
  if to_regclass('public.movimientos_inventario') is null then
    raise exception 'Falta la estructura V3. Ejecuta primero 01_cafe_aroma_v3.sql.';
  end if;
  if exists (select 1 from public.pedidos) then
    raise exception 'La tabla public.pedidos ya tiene datos: la migración parece haberse ejecutado antes.';
  end if;
end $$;

-- 1) Perfiles y roles
insert into public.perfiles (user_id, nombre, telefono, direccion, rol, creado_en, actualizado_en)
select user_id, nombre, telefono, direccion, rol, creado_en, actualizado_en from respaldo_v2.perfiles
on conflict (user_id) do update set nombre = excluded.nombre, telefono = excluded.telefono,
  direccion = excluded.direccion, rol = excluded.rol;

-- 2) Categorías y productos (conserva IDs, precios, imágenes y activo/inactivo)
insert into public.categorias (slug, nombre, orden)
select distinct lower(regexp_replace(categoria, '[^a-zA-Z0-9_-]', '', 'g')), initcap(categoria), 50
from respaldo_v2.productos
on conflict (slug) do nothing;

insert into public.productos (id, categoria_id, nombre, descripcion, precio, imagen, activo, orden, creado_en)
select p.id, c.id, p.nombre, p.descripcion, p.precio, p.imagen, p.activo, p.id, p.creado_en
from respaldo_v2.productos p
join public.categorias c on c.slug = lower(regexp_replace(p.categoria, '[^a-zA-Z0-9_-]', '', 'g'))
on conflict (id) do update set categoria_id = excluded.categoria_id, nombre = excluded.nombre,
  descripcion = excluded.descripcion, precio = excluded.precio, imagen = excluded.imagen, activo = excluded.activo;

-- 3) Clientes
insert into public.clientes (id, user_id, nombre, telefono, email, creado_en)
select id, user_id, nombre, telefono, email, creado_en from respaldo_v2.clientes
on conflict (id) do nothing;

-- 4) Pedidos (se marcan con inventario ya descontado, como ocurría en la V2)
insert into public.pedidos (id, cliente_id, user_id, estado, metodo_pago, subtotal, descuento, envio, total, notas,
                            inventario_descontado, inventario_descontado_en, estado_actualizado_en, creado_en)
select id, cliente_id, user_id,
       case estado when 'pendiente' then 'nuevo' when 'preparando' then 'en_preparacion' else estado end,
       metodo_pago, subtotal, 0, envio, subtotal + envio, notas,
       true, creado_en,
       case when estado in ('entregado','cancelado') then creado_en else now() end,
       creado_en
from respaldo_v2.pedidos
on conflict (id) do nothing;

update public.historial_estados_pedido set nota = 'Migrado desde la V2'
where estado_anterior is null and pedido_id in (select id from respaldo_v2.pedidos);

insert into public.detalle_pedidos (id, pedido_id, producto_id, producto_nombre, precio_unitario, cantidad)
select id, pedido_id, producto_id, producto_nombre, precio_unitario, cantidad from respaldo_v2.detalle_pedidos
on conflict (id) do nothing;

-- 5) Funciones de cliente V2
insert into public.favoritos (user_id, producto_id, creado_en)
select user_id, producto_id, creado_en from respaldo_v2.favoritos on conflict do nothing;

insert into public.puntos_cliente (user_id, puntos, actualizado_en)
select user_id, puntos, actualizado_en from respaldo_v2.puntos_cliente
on conflict (user_id) do update set puntos = excluded.puntos;

insert into public.movimientos_puntos (id, user_id, pedido_id, puntos, descripcion, creado_en)
select id, user_id, pedido_id, puntos, descripcion, creado_en from respaldo_v2.movimientos_puntos on conflict do nothing;

insert into public.cupones (codigo, descripcion, descuento, activo, expira_en, creado_en)
select upper(codigo), descripcion, descuento, activo, expira_en, creado_en from respaldo_v2.cupones
on conflict (codigo) do update set descripcion = excluded.descripcion, descuento = excluded.descuento,
  activo = excluded.activo, expira_en = excluded.expira_en;

insert into public.notificaciones (id, user_id, titulo, mensaje, leida, creado_en)
select id, user_id, titulo, mensaje, leida, creado_en from respaldo_v2.notificaciones on conflict do nothing;

insert into public.resenas (id, user_id, pedido_id, producto_id, estrellas, comentario, creado_en)
select id, user_id, pedido_id, producto_id, estrellas, comentario, creado_en from respaldo_v2.resenas on conflict do nothing;

insert into public.mensajes_contacto (id, nombre, email, mensaje, creado_en)
select id, left(nombre, 100), left(email, 150), left(mensaje, 2000), creado_en from respaldo_v2.mensajes_contacto
on conflict do nothing;

-- 6) Stock de insumos: se lleva el stock real de la V2 (convertido a la unidad nueva)
do $$
declare
  r record; v_dest public.insumos; v_nombre text; v_unidad text; v_factor numeric; v_stock numeric; v_id bigint;
begin
  for r in select * from respaldo_v2.insumos loop
    v_nombre := case r.nombre
      when 'Chocolate' then 'Chocolate en polvo' when 'Caramelo' then 'Jarabe de caramelo'
      when 'Vainilla' then 'Jarabe de vainilla' when 'Huevos' then 'Huevo'
      when 'Pan' then 'Pan artesanal' when 'Frijoles' then 'Frijoles refritos' else r.nombre end;
    -- unidad V2 -> unidad base V3
    v_unidad := case lower(r.unidad) when 'kg' then 'g' when 'g' then 'g' when 'l' then 'ml' when 'ml' then 'ml'
                                      when 'pieza' then 'pieza' when 'piezas' then 'pieza' else 'unidad' end;
    v_factor := case lower(r.unidad) when 'kg' then 1000 when 'l' then 1000 else 1 end;
    v_stock := round(r.stock * v_factor, 3);

    select * into v_dest from public.insumos where lower(nombre) = lower(v_nombre);
    if found then
      if v_dest.unidad <> v_unidad then
        raise notice 'Insumo "%": la V2 lo medía en % y la V3 en %. Se conserva el stock de la V3; ajústalo con un conteo físico.',
          r.nombre, r.unidad, v_dest.unidad;
        continue;
      end if;
      update public.insumos set stock_minimo = round(r.stock_minimo * v_factor, 3),
             stock_maximo = greatest(coalesce(stock_maximo, 0), round(r.stock_minimo * v_factor, 3) * 2),
             costo_unitario = round(r.costo_unitario / v_factor, 4)
       where id = v_dest.id;
      if v_stock <> v_dest.stock then
        insert into public.movimientos_inventario (insumo_id, tipo, cantidad, motivo, usuario_id)
        values (v_dest.id, 'ajuste', v_stock - v_dest.stock, 'Stock migrado desde la V2', null);
      end if;
    else
      insert into public.insumos (nombre, unidad, stock, stock_minimo, costo_unitario, activo)
      values (v_nombre, v_unidad, 0, round(r.stock_minimo * v_factor, 3), round(r.costo_unitario / v_factor, 4), r.activo)
      returning id into v_id;
      if v_stock > 0 then
        insert into public.movimientos_inventario (insumo_id, tipo, cantidad, motivo, usuario_id)
        values (v_id, 'inicial', v_stock, 'Stock migrado desde la V2', null);
      end if;
    end if;
  end loop;
end $$;

-- 7) Ajusta los contadores de IDs
do $$
declare t text;
begin
  foreach t in array array['productos','clientes','pedidos','detalle_pedidos','movimientos_puntos',
                           'notificaciones','resenas','mensajes_contacto'] loop
    execute format('select setval(pg_get_serial_sequence(%L, ''id''), greatest((select coalesce(max(id), 0) from public.%I), 1))',
                   'public.' || t, t);
  end loop;
end $$;

-- 8) Recalcula alertas con los datos migrados
do $$ declare r record; begin
  for r in select id from public.insumos loop perform public._sincronizar_alertas_insumo(r.id); end loop;
  perform public._sincronizar_alertas_productos();
  perform public._sincronizar_alerta_reabastecimiento();
end $$;

select format('Migración completa ✅  %s pedidos, %s clientes y %s perfiles copiados. El respaldo sigue en el esquema respaldo_v2.',
  (select count(*) from public.pedidos), (select count(*) from public.clientes), (select count(*) from public.perfiles)) as resultado;
