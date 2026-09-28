-- =====================================================================
--  CAFÉ AROMA V3 — BASE DE DATOS COMPLETA PARA SUPABASE
-- ---------------------------------------------------------------------
--  Cómo usarlo:
--    1. Supabase > SQL Editor > New query
--    2. Pega TODO este archivo y presiona "Run".
--    3. Crea tu usuario administrador (ver README, Paso 7).
--
--  Si tu proyecto ya tiene la base de datos V2, ejecuta ANTES
--  el archivo 00_respaldo_v2.sql (mueve tus tablas a un respaldo sin
--  borrar nada). Este script lo detecta y te avisa.
--
--  Contenido:
--    1. Utilidades y configuración
--    2. Catálogos (unidades, categorías, métodos de pago, estados)
--    3. Perfiles, roles y seguridad
--    4. Menú, proveedores, insumos y recetas (producto → insumo → cantidad)
--    5. Clientes, pedidos, detalle e historial de estados
--    6. Movimientos de inventario (entradas, salidas, devoluciones...)
--    7. Alertas, agente, cortes diarios
--    8. Funciones V2 conservadas (favoritos, puntos, cupones, avisos...)
--    9. Vistas de inventario, disponibilidad, pedidos y ventas
--   10. Lógica automática: pedidos, descuento, devolución, alertas
--   11. Reportes y agente
--   12. Datos iniciales (menú, insumos, recetas)
--   13. Seguridad: RLS, permisos, realtime y tareas programadas
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. VERIFICACIÓN PREVIA: ¿es una base V2 sin respaldar?
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.pedidos') is not null and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pedidos' and column_name = 'codigo_seguimiento'
  ) then
    raise exception 'Se detectó la base de datos V2 de Café Aroma. Ejecuta primero supabase/00_respaldo_v2.sql (mueve tus tablas actuales al esquema respaldo_v2 sin borrar nada) y después vuelve a ejecutar este archivo.';
  end if;
end $$;

create extension if not exists pgcrypto;

-- Funciones antiguas de la V2 que se reemplazan (solo código, no datos)
drop function if exists public.crear_pedido(text,text,text,text,numeric,numeric,numeric,text,jsonb);
drop function if exists public.descontar_inventario_por_detalle() cascade;
drop function if exists public.notificar_cambio_pedido() cascade;

-- =====================================================================
-- 1. UTILIDADES Y CONFIGURACIÓN
-- =====================================================================
create or replace function public.tg_set_actualizado_en()
returns trigger language plpgsql as $$
begin
  new.actualizado_en := now();
  return new;
end $$;

create table if not exists public.configuracion (
  clave          text primary key,
  valor          text not null,
  descripcion    text,
  publica        boolean not null default false,   -- true = el sitio del cliente puede leerla
  actualizado_en timestamptz not null default now()
);

create or replace function public.config_texto(p_clave text, p_default text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select valor from public.configuracion where clave = p_clave), p_default);
$$;

create or replace function public.config_numero(p_clave text, p_default numeric)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  select valor into v from public.configuracion where clave = p_clave;
  return coalesce(nullif(trim(v), '')::numeric, p_default);
exception when others then
  return p_default;
end $$;

-- Zona horaria del negocio (para "ventas de hoy", reportes, etc.)
create or replace function public.tz()
returns text language sql stable as $$
  select public.config_texto('zona_horaria', 'America/Mexico_City');
$$;

create or replace function public.hoy()
returns date language sql stable as $$
  select (now() at time zone public.tz())::date;
$$;

-- Muestra cantidades de forma legible: 3000 ml -> "3 L", 850 g -> "850 g"
create or replace function public.formato_cantidad(p numeric, p_unidad text)
returns text language sql immutable as $$
  select case
    when p is null then '—'
    when p_unidad = 'g'  and abs(p) >= 1000 then trim_scale(round(p / 1000, 2))::text || ' kg'
    when p_unidad = 'ml' and abs(p) >= 1000 then trim_scale(round(p / 1000, 2))::text || ' L'
    when p_unidad = 'l' then trim_scale(round(p, 2))::text || ' L'
    when p_unidad = 'pieza'  then trim_scale(round(p, 2))::text || case when round(p, 2) = 1 then ' pieza'  else ' piezas' end
    when p_unidad = 'unidad' then trim_scale(round(p, 2))::text || case when round(p, 2) = 1 then ' unidad' else ' unidades' end
    else trim_scale(round(p, 2))::text || ' ' || coalesce(p_unidad, '')
  end;
$$;

-- Une una lista como texto: {a,b,c} -> "a, b y c"
create or replace function public.lista_texto(p text[])
returns text language sql immutable as $$
  select case
    when p is null or cardinality(p) = 0 then ''
    when cardinality(p) = 1 then p[1]
    else array_to_string(p[1:cardinality(p) - 1], ', ') || ' y ' || p[cardinality(p)]
  end;
$$;

-- =====================================================================
-- 2. CATÁLOGOS
-- =====================================================================
create table if not exists public.unidades_medida (
  codigo       text primary key,              -- g, kg, ml, l, pieza, unidad
  nombre       text not null,
  tipo         text not null check (tipo in ('masa','volumen','conteo')),
  factor_base  numeric(14,6) not null check (factor_base > 0)  -- g=1, kg=1000, ml=1, l=1000
);

create table if not exists public.categorias (
  id        bigint generated by default as identity primary key,
  slug      text not null unique check (slug ~ '^[a-z0-9_-]+$'),
  nombre    text not null,
  icono     text,
  orden     int not null default 0,
  activo    boolean not null default true,
  creado_en timestamptz not null default now()
);

create table if not exists public.metodos_pago (
  codigo text primary key,          -- efectivo, tarjeta, transferencia
  nombre text not null,
  icono  text,
  activo boolean not null default true,
  orden  int not null default 0
);

create table if not exists public.estados_pedido (
  codigo   text primary key,        -- nuevo, confirmado, en_preparacion, listo, entregado, cancelado
  nombre   text not null,
  orden    int not null unique,
  es_venta boolean not null default false,   -- true = cuenta como venta y ya tiene inventario descontado
  es_final boolean not null default false,   -- true = ya no puede cambiar
  color    text
);

-- =====================================================================
-- 3. PERFILES, ROLES Y SEGURIDAD
-- =====================================================================
create table if not exists public.perfiles (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  nombre         text not null default 'Cliente',
  telefono       text,
  direccion      text,
  rol            text not null default 'cliente' check (rol in ('cliente','admin')),
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where user_id = auth.uid() and rol = 'admin');
$$;

-- ¿La petición viene de la API (navegador) y no del SQL Editor / pg_cron?
create or replace function public._es_peticion_api()
returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
         in ('anon', 'authenticated');
$$;

-- Lanza error si quien llama desde la API no es administrador.
create or replace function public.requiere_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.es_admin() then return; end if;
  if public._es_peticion_api() then
    raise exception 'Acceso denegado: se requiere rol de administrador.' using errcode = '42501';
  end if;
end $$;

-- Un cliente NO puede convertirse en administrador editando su perfil.
create or replace function public.tg_proteger_rol()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public._es_peticion_api() and not public.es_admin() then
    if tg_op = 'INSERT' then
      new.rol := 'cliente';
    elsif new.rol is distinct from old.rol then
      new.rol := old.rol;
    end if;
  end if;
  new.actualizado_en := now();
  return new;
end $$;

drop trigger if exists trg_proteger_rol on public.perfiles;
create trigger trg_proteger_rol before insert or update on public.perfiles
for each row execute function public.tg_proteger_rol();

-- =====================================================================
-- 4. MENÚ, PROVEEDORES, INSUMOS Y RECETAS
-- =====================================================================
create table if not exists public.productos (
  id             bigint generated by default as identity primary key,
  categoria_id   bigint not null references public.categorias(id) on delete restrict,
  nombre         text not null check (length(trim(nombre)) between 2 and 80),
  descripcion    text not null default '',
  precio         numeric(10,2) not null check (precio >= 0),
  imagen         text,
  activo         boolean not null default true,   -- false = oculto del menú (decisión manual)
  orden          int not null default 0,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create unique index if not exists productos_nombre_unq on public.productos (lower(nombre));
create index if not exists productos_categoria_idx on public.productos (categoria_id);

create table if not exists public.proveedores (
  id        bigint generated by default as identity primary key,
  nombre    text not null,
  contacto  text,
  telefono  text,
  email     text,
  notas     text,
  activo    boolean not null default true,
  creado_en timestamptz not null default now()
);
create unique index if not exists proveedores_nombre_unq on public.proveedores (lower(nombre));

create table if not exists public.insumos (
  id             bigint generated by default as identity primary key,
  nombre         text not null check (length(trim(nombre)) between 2 and 80),
  unidad         text not null references public.unidades_medida(codigo),
  stock          numeric(14,3) not null default 0 check (stock >= 0),
  stock_minimo   numeric(14,3) not null default 0 check (stock_minimo >= 0),
  stock_maximo   numeric(14,3) check (stock_maximo is null or stock_maximo >= stock_minimo),
  costo_unitario numeric(12,4) not null default 0 check (costo_unitario >= 0),  -- costo por 1 unidad (ej. por gramo)
  proveedor_id   bigint references public.proveedores(id) on delete set null,
  activo         boolean not null default true,
  -- Estado calculado automáticamente por PostgreSQL:
  estado text generated always as (
    case
      when stock <= 0 then 'agotado'
      when stock <= stock_minimo then 'bajo'
      when stock_maximo is not null and stock > stock_maximo then 'exceso'
      else 'normal'
    end
  ) stored,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create unique index if not exists insumos_nombre_unq on public.insumos (lower(nombre));

-- RECETAS: qué insumos usa cada producto y cuánto (en la unidad del insumo)
create table if not exists public.recetas (
  producto_id bigint not null references public.productos(id) on delete cascade,
  insumo_id   bigint not null references public.insumos(id) on delete restrict,
  cantidad    numeric(12,3) not null check (cantidad > 0),
  primary key (producto_id, insumo_id)
);
create index if not exists recetas_insumo_idx on public.recetas (insumo_id);

drop trigger if exists trg_productos_actualizado on public.productos;
create trigger trg_productos_actualizado before update on public.productos
for each row execute function public.tg_set_actualizado_en();

drop trigger if exists trg_insumos_actualizado on public.insumos;
create trigger trg_insumos_actualizado before update on public.insumos
for each row execute function public.tg_set_actualizado_en();

-- =====================================================================
-- 5. CLIENTES, PEDIDOS, DETALLE E HISTORIAL
-- =====================================================================
create table if not exists public.clientes (
  id        bigint generated by default as identity primary key,
  user_id   uuid references auth.users(id) on delete set null,
  nombre    text not null,
  telefono  text not null,
  email     text,
  creado_en timestamptz not null default now()
);
create index if not exists clientes_user_idx on public.clientes (user_id);

-- Código de seguimiento que recibe el cliente: CA-7F3K9Q2M
create or replace function public.generar_codigo_pedido()
returns text language plpgsql volatile as $$
declare
  alfabeto constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  -- gen_random_uuid() es nativa de PostgreSQL (no depende de pgcrypto ni del esquema "extensions")
  bytes bytea := uuid_send(gen_random_uuid());
  resultado text := 'CA-';
begin
  for i in 0..7 loop
    resultado := resultado || substr(alfabeto, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return resultado;
end $$;

create table if not exists public.pedidos (
  id                       bigint generated by default as identity primary key,
  codigo_seguimiento       text not null unique default public.generar_codigo_pedido(),
  cliente_id               bigint not null references public.clientes(id) on delete restrict,
  user_id                  uuid references auth.users(id) on delete set null,
  estado                   text not null default 'nuevo' references public.estados_pedido(codigo),
  metodo_pago              text not null references public.metodos_pago(codigo),
  subtotal                 numeric(10,2) not null check (subtotal >= 0),
  descuento                numeric(10,2) not null default 0 check (descuento >= 0),
  envio                    numeric(10,2) not null default 0 check (envio >= 0),
  total                    numeric(10,2) not null check (total >= 0),
  cupon_codigo             text,
  notas                    text,
  motivo_cancelacion       text,
  -- Control del inventario (evita descuentos duplicados)
  inventario_descontado    boolean not null default false,
  inventario_descontado_en timestamptz,
  inventario_devuelto      boolean not null default false,
  inventario_devuelto_en   timestamptz,
  estado_actualizado_en    timestamptz not null default now(),  -- desde cuándo está en el estado actual
  creado_en                timestamptz not null default now(),
  actualizado_en           timestamptz not null default now(),
  constraint pedidos_total_ok check (total = subtotal - descuento + envio)
);
create index if not exists pedidos_estado_idx on public.pedidos (estado);
create index if not exists pedidos_creado_idx on public.pedidos (creado_en desc);
create index if not exists pedidos_user_idx on public.pedidos (user_id);
create index if not exists pedidos_cliente_idx on public.pedidos (cliente_id);

create table if not exists public.detalle_pedidos (
  id              bigint generated by default as identity primary key,
  pedido_id       bigint not null references public.pedidos(id) on delete cascade,
  producto_id     bigint references public.productos(id) on delete restrict,
  producto_nombre text not null,               -- copia del nombre al momento de la venta
  precio_unitario numeric(10,2) not null check (precio_unitario >= 0),
  cantidad        integer not null check (cantidad between 1 and 50),
  subtotal        numeric(10,2) generated always as (precio_unitario * cantidad) stored
);
create index if not exists detalle_pedido_idx on public.detalle_pedidos (pedido_id);
create index if not exists detalle_producto_idx on public.detalle_pedidos (producto_id);

create table if not exists public.historial_estados_pedido (
  id              bigint generated by default as identity primary key,
  pedido_id       bigint not null references public.pedidos(id) on delete cascade,
  estado_anterior text,
  estado_nuevo    text not null,
  usuario_id      uuid,
  nota            text,
  creado_en       timestamptz not null default now()
);
create index if not exists historial_pedido_idx on public.historial_estados_pedido (pedido_id, creado_en);

-- =====================================================================
-- 6. MOVIMIENTOS DE INVENTARIO (fuente única de verdad del stock)
--    El stock de un insumo SOLO cambia insertando un movimiento.
--      inicial / entrada / devolucion  -> suman (cantidad positiva)
--      salida_venta / merma            -> restan (cantidad negativa)
--      ajuste                          -> suma o resta (conteo físico)
-- =====================================================================
create table if not exists public.movimientos_inventario (
  id             bigint generated by default as identity primary key,
  insumo_id      bigint not null references public.insumos(id) on delete restrict,
  tipo           text not null check (tipo in ('inicial','entrada','salida_venta','devolucion','merma','ajuste')),
  cantidad       numeric(14,3) not null check (cantidad <> 0),
  stock_anterior numeric(14,3),
  stock_nuevo    numeric(14,3),
  costo_unitario numeric(12,4),
  pedido_id      bigint references public.pedidos(id) on delete restrict,
  proveedor_id   bigint references public.proveedores(id) on delete set null,
  motivo         text,
  usuario_id     uuid default auth.uid(),
  creado_en      timestamptz not null default now(),
  constraint mov_signo_ok check (
    (tipo in ('inicial','entrada','devolucion') and cantidad > 0) or
    (tipo in ('salida_venta','merma') and cantidad < 0) or
    (tipo = 'ajuste')
  ),
  constraint mov_pedido_ok check ((tipo in ('salida_venta','devolucion')) = (pedido_id is not null))
);
-- Garantía a nivel base de datos: un pedido NUNCA descuenta (ni devuelve) dos veces el mismo insumo
create unique index if not exists mov_una_salida_por_pedido
  on public.movimientos_inventario (pedido_id, insumo_id) where tipo = 'salida_venta';
create unique index if not exists mov_una_devolucion_por_pedido
  on public.movimientos_inventario (pedido_id, insumo_id) where tipo = 'devolucion';
create index if not exists mov_insumo_fecha_idx on public.movimientos_inventario (insumo_id, creado_en desc);
create index if not exists mov_fecha_idx on public.movimientos_inventario (creado_en desc);
create index if not exists mov_pedido_idx on public.movimientos_inventario (pedido_id);

-- Aplica el movimiento al stock del insumo (con bloqueo de fila para evitar carreras)
create or replace function public.tg_aplicar_movimiento()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ins public.insumos;
begin
  select * into v_ins from public.insumos where id = new.insumo_id for update;
  if not found then
    raise exception 'El insumo % no existe.', new.insumo_id;
  end if;
  new.stock_anterior := v_ins.stock;
  new.stock_nuevo    := v_ins.stock + new.cantidad;
  if new.stock_nuevo < 0 then
    raise exception 'Inventario insuficiente de "%": hay %, se requieren %.',
      v_ins.nombre, public.formato_cantidad(v_ins.stock, v_ins.unidad), public.formato_cantidad(-new.cantidad, v_ins.unidad)
      using errcode = 'P0001', hint = 'INVENTARIO_INSUFICIENTE';
  end if;
  new.creado_en := now();
  update public.insumos
     set stock = new.stock_nuevo,
         costo_unitario = case when new.tipo in ('entrada','inicial') and coalesce(new.costo_unitario, 0) > 0
                               then new.costo_unitario else costo_unitario end
   where id = new.insumo_id;
  return new;
end $$;

drop trigger if exists trg_aplicar_movimiento on public.movimientos_inventario;
create trigger trg_aplicar_movimiento before insert on public.movimientos_inventario
for each row execute function public.tg_aplicar_movimiento();

-- Los movimientos son historial: no se editan ni se borran (se corrigen con un "ajuste")
create or replace function public.tg_movimientos_inmutables()
returns trigger language plpgsql as $$
begin
  raise exception 'Los movimientos de inventario son historial y no se pueden modificar ni borrar. Registra un ajuste.';
end $$;

drop trigger if exists trg_movimientos_inmutables on public.movimientos_inventario;
create trigger trg_movimientos_inmutables before update or delete on public.movimientos_inventario
for each row execute function public.tg_movimientos_inmutables();

-- =====================================================================
-- 7. ALERTAS, AGENTE Y CORTES DIARIOS
-- =====================================================================
create table if not exists public.alertas (
  id             bigint generated by default as identity primary key,
  tipo           text not null check (tipo in ('inventario_bajo','insumo_agotado','producto_no_disponible',
                                               'reabastecimiento','pedido_atrasado','pedido_sin_inventario','venta_rechazada')),
  severidad      text not null default 'media' check (severidad in ('baja','media','alta','critica')),
  titulo         text not null,
  mensaje        text not null,
  insumo_id      bigint references public.insumos(id) on delete cascade,
  producto_id    bigint references public.productos(id) on delete cascade,
  pedido_id      bigint references public.pedidos(id) on delete cascade,
  datos          jsonb,
  resuelta       boolean not null default false,
  resuelta_en    timestamptz,
  resuelta_por   uuid,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
-- Solo puede existir UNA alerta abierta por situación (evita alertas repetidas)
create unique index if not exists alertas_abierta_insumo   on public.alertas (tipo, insumo_id)   where not resuelta and insumo_id is not null;
create unique index if not exists alertas_abierta_producto on public.alertas (tipo, producto_id) where not resuelta and producto_id is not null;
create unique index if not exists alertas_abierta_pedido   on public.alertas (tipo, pedido_id)   where not resuelta and pedido_id is not null;
create unique index if not exists alertas_abierta_general  on public.alertas (tipo)
  where not resuelta and insumo_id is null and producto_id is null and pedido_id is null;
create index if not exists alertas_fecha_idx on public.alertas (creado_en desc);

create table if not exists public.agente_mensajes (
  id         bigint generated by default as identity primary key,
  usuario_id uuid default auth.uid(),
  pregunta   text not null,
  respuesta  text not null,
  intencion  text,
  creado_en  timestamptz not null default now()
);

-- Acciones que el agente PROPONE y el administrador AUTORIZA o RECHAZA
create table if not exists public.agente_acciones (
  id          bigint generated by default as identity primary key,
  tipo        text not null check (tipo in ('registrar_entrada','cambiar_estado_pedido','cancelar_pedido',
                                            'pausar_producto','reactivar_producto','ajustar_stock_minimo')),
  descripcion text not null,
  datos       jsonb not null default '{}'::jsonb,
  origen      text not null default 'chat' check (origen in ('chat','automatico')),
  estado      text not null default 'pendiente' check (estado in ('pendiente','aprobada','rechazada','error')),
  resultado   text,
  creado_por  uuid default auth.uid(),
  creado_en   timestamptz not null default now(),
  resuelto_por uuid,
  resuelto_en timestamptz
);
create index if not exists agente_acciones_estado_idx on public.agente_acciones (estado, creado_en desc);

create table if not exists public.cortes_diarios (
  fecha                date primary key,
  pedidos              int not null default 0,
  ventas               numeric(12,2) not null default 0,
  efectivo             numeric(12,2) not null default 0,
  tarjeta              numeric(12,2) not null default 0,
  transferencia        numeric(12,2) not null default 0,
  ticket_promedio      numeric(12,2) not null default 0,
  cancelados           int not null default 0,
  producto_mas_vendido text,
  detalle              jsonb,
  generado_en          timestamptz not null default now()
);

-- =====================================================================
-- 8. FUNCIONES V2 CONSERVADAS: favoritos, puntos, cupones, avisos, reseñas, contacto
-- =====================================================================
create table if not exists public.favoritos (
  user_id     uuid not null references auth.users(id) on delete cascade,
  producto_id bigint not null references public.productos(id) on delete cascade,
  creado_en   timestamptz not null default now(),
  primary key (user_id, producto_id)
);

create table if not exists public.puntos_cliente (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  puntos         integer not null default 0 check (puntos >= 0),
  actualizado_en timestamptz not null default now()
);

create table if not exists public.movimientos_puntos (
  id          bigint generated by default as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  pedido_id   bigint unique references public.pedidos(id) on delete set null,
  puntos      integer not null,
  descripcion text,
  creado_en   timestamptz not null default now()
);

create table if not exists public.cupones (
  id          bigint generated by default as identity primary key,
  codigo      text unique not null check (codigo = upper(codigo)),
  descripcion text,
  descuento   numeric(5,2) not null check (descuento between 0 and 100),  -- porcentaje
  activo      boolean not null default true,
  expira_en   timestamptz,
  creado_en   timestamptz not null default now()
);

create table if not exists public.notificaciones (
  id        bigint generated by default as identity primary key,
  user_id   uuid not null references auth.users(id) on delete cascade,
  pedido_id bigint references public.pedidos(id) on delete cascade,
  titulo    text not null,
  mensaje   text not null,
  leida     boolean not null default false,
  creado_en timestamptz not null default now()
);
create index if not exists notificaciones_user_idx on public.notificaciones (user_id, creado_en desc);

create table if not exists public.resenas (
  id          bigint generated by default as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  pedido_id   bigint references public.pedidos(id) on delete set null,
  producto_id bigint references public.productos(id) on delete set null,
  estrellas   integer not null check (estrellas between 1 and 5),
  comentario  text,
  creado_en   timestamptz not null default now()
);

create table if not exists public.mensajes_contacto (
  id        bigint generated by default as identity primary key,
  nombre    text not null check (length(nombre) between 1 and 100),
  email     text not null check (length(email) between 3 and 150),
  mensaje   text not null check (length(mensaje) between 1 and 2000),
  leido     boolean not null default false,
  creado_en timestamptz not null default now()
);

-- Perfil y puntos automáticos al registrarse un usuario
create or replace function public.crear_perfil_nuevo()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfiles (user_id, nombre, telefono)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'nombre', ''), 'Cliente'), new.raw_user_meta_data ->> 'telefono')
  on conflict (user_id) do nothing;
  insert into public.puntos_cliente (user_id, puntos) values (new.id, 0)
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created_cafe_aroma on auth.users;
create trigger on_auth_user_created_cafe_aroma
after insert on auth.users for each row execute function public.crear_perfil_nuevo();

-- =====================================================================
-- 9. VISTAS
--    security_invoker = true -> la vista respeta el RLS de quien consulta
--    (un cliente no ve nada de inventario; el administrador ve todo).
-- =====================================================================
drop view if exists public.vista_pedidos_atrasados, public.vista_pedidos_admin, public.vista_reabastecimiento,
  public.vista_inventario, public.vista_disponibilidad_productos, public.vista_stock_comprometido,
  public.vista_ventas_diarias, public.vista_productos_mas_vendidos, public.vista_ventas_metodo,
  public.vista_movimientos_inventario, public.vista_entradas_inventario, public.vista_salidas_inventario,
  public.vista_costo_productos, public.vista_ventas_producto, public.vista_ventas_hora,
  public.vista_inventario_alertas cascade;

-- Insumos "apartados" por pedidos nuevos que aún no se confirman
create view public.vista_stock_comprometido with (security_invoker = true) as
select r.insumo_id, sum(r.cantidad * d.cantidad) as comprometido
from public.pedidos p
join public.detalle_pedidos d on d.pedido_id = p.id
join public.recetas r on r.producto_id = d.producto_id
where p.estado = 'nuevo' and not p.inventario_descontado
group by r.insumo_id;

-- ¿Cuántas porciones de cada producto se pueden preparar con el inventario real?
create view public.vista_disponibilidad_productos with (security_invoker = true) as
with base as (
  select p.id as producto_id, p.nombre, p.activo, r.insumo_id, i.nombre as insumo,
         floor(greatest(i.stock - coalesce(c.comprometido, 0), 0) / r.cantidad) as porciones
  from public.productos p
  left join public.recetas r on r.producto_id = p.id
  left join public.insumos i on i.id = r.insumo_id
  left join public.vista_stock_comprometido c on c.insumo_id = r.insumo_id
)
select producto_id, nombre, activo,
       count(insumo_id)::int as num_insumos,
       min(porciones)::bigint as porciones_posibles,            -- null = producto sin receta
       (array_agg(insumo order by porciones, insumo) filter (where insumo_id is not null))[1] as insumo_limitante,
       coalesce(array_agg(insumo order by insumo) filter (where porciones < 1), '{}') as insumos_faltantes,
       (activo and (count(insumo_id) = 0 or min(porciones) >= 1)) as disponible
from base
group by producto_id, nombre, activo;

create view public.vista_inventario with (security_invoker = true) as
select i.id, i.nombre, i.unidad, u.nombre as unidad_nombre, i.stock, i.stock_minimo, i.stock_maximo,
       i.costo_unitario, i.proveedor_id, pr.nombre as proveedor, i.activo, i.estado,
       coalesce(c.comprometido, 0) as comprometido,
       greatest(i.stock - coalesce(c.comprometido, 0), 0) as disponible_venta,
       case when i.stock <= i.stock_minimo
            then greatest(coalesce(i.stock_maximo, i.stock_minimo * 2) - i.stock, 0) else 0 end as cantidad_sugerida,
       round(i.stock * i.costo_unitario, 2) as valor_inventario,
       (select count(*) from public.recetas r where r.insumo_id = i.id)::int as usado_en_productos,
       public.formato_cantidad(i.stock, i.unidad) as stock_texto,
       public.formato_cantidad(i.stock_minimo, i.unidad) as minimo_texto,
       i.actualizado_en
from public.insumos i
join public.unidades_medida u on u.codigo = i.unidad
left join public.proveedores pr on pr.id = i.proveedor_id
left join public.vista_stock_comprometido c on c.insumo_id = i.id;

create view public.vista_reabastecimiento with (security_invoker = true) as
select id, nombre, unidad, stock, stock_minimo, stock_maximo, estado, proveedor, comprometido,
       greatest(cantidad_sugerida, comprometido - stock, 0) as cantidad_sugerida,
       public.formato_cantidad(greatest(cantidad_sugerida, comprometido - stock, 0), unidad) as sugerido_texto,
       round(greatest(cantidad_sugerida, comprometido - stock, 0) * costo_unitario, 2) as costo_estimado
from public.vista_inventario
where activo and (estado in ('bajo','agotado') or comprometido > stock);

create view public.vista_pedidos_admin with (security_invoker = true) as
select p.id, p.codigo_seguimiento, p.estado, e.nombre as estado_nombre, e.orden as estado_orden,
       p.metodo_pago, m.nombre as metodo_nombre, p.subtotal, p.descuento, p.envio, p.total, p.cupon_codigo,
       p.notas, p.motivo_cancelacion, p.inventario_descontado, p.inventario_devuelto,
       p.estado_actualizado_en, p.creado_en, p.user_id,
       c.nombre as cliente, c.telefono, c.email,
       items.resumen as productos, items.piezas,
       floor(extract(epoch from now() - p.estado_actualizado_en) / 60)::int as minutos_en_estado,
       (  (p.estado = 'en_preparacion' and now() - p.estado_actualizado_en
              > make_interval(mins => public.config_numero('minutos_atraso_preparacion', 20)::int))
       or (p.estado in ('nuevo','confirmado') and now() - p.estado_actualizado_en
              > make_interval(mins => public.config_numero('minutos_atraso_sin_atender', 10)::int))
       ) as atrasado
from public.pedidos p
join public.clientes c on c.id = p.cliente_id
join public.estados_pedido e on e.codigo = p.estado
join public.metodos_pago m on m.codigo = p.metodo_pago
left join lateral (
  select string_agg(d.cantidad || '× ' || d.producto_nombre, ', ' order by d.id) as resumen,
         sum(d.cantidad)::int as piezas
  from public.detalle_pedidos d where d.pedido_id = p.id
) items on true;

create view public.vista_pedidos_atrasados with (security_invoker = true) as
select * from public.vista_pedidos_admin where atrasado;

-- Ventas (solo pedidos confirmados o posteriores; no cuenta nuevos ni cancelados)
create view public.vista_ventas_diarias with (security_invoker = true) as
select (p.creado_en at time zone public.tz())::date as fecha,
       count(*)::int as pedidos,
       sum(p.total) as ventas,
       sum(p.total) filter (where p.metodo_pago = 'efectivo') as efectivo,
       sum(p.total) filter (where p.metodo_pago = 'tarjeta') as tarjeta,
       sum(p.total) filter (where p.metodo_pago = 'transferencia') as transferencia,
       round(avg(p.total), 2) as ticket_promedio
from public.pedidos p
join public.estados_pedido e on e.codigo = p.estado and e.es_venta
group by 1;

create view public.vista_productos_mas_vendidos with (security_invoker = true) as
select d.producto_id, d.producto_nombre, sum(d.cantidad)::int as unidades, sum(d.subtotal) as ventas
from public.detalle_pedidos d
join public.pedidos p on p.id = d.pedido_id
join public.estados_pedido e on e.codigo = p.estado and e.es_venta
group by d.producto_id, d.producto_nombre;

create view public.vista_ventas_metodo with (security_invoker = true) as
select p.metodo_pago, m.nombre, count(*)::int as pedidos, sum(p.total) as ventas
from public.pedidos p
join public.metodos_pago m on m.codigo = p.metodo_pago
join public.estados_pedido e on e.codigo = p.estado and e.es_venta
group by p.metodo_pago, m.nombre;

create view public.vista_movimientos_inventario with (security_invoker = true) as
select mv.id, mv.creado_en, mv.tipo, mv.insumo_id, i.nombre as insumo, i.unidad,
       mv.cantidad, mv.stock_anterior, mv.stock_nuevo,
       public.formato_cantidad(mv.cantidad, i.unidad) as cantidad_texto,
       public.formato_cantidad(mv.stock_nuevo, i.unidad) as stock_nuevo_texto,
       mv.costo_unitario, mv.pedido_id, mv.motivo, mv.usuario_id, pf.nombre as usuario, pr.nombre as proveedor
from public.movimientos_inventario mv
join public.insumos i on i.id = mv.insumo_id
left join public.perfiles pf on pf.user_id = mv.usuario_id
left join public.proveedores pr on pr.id = mv.proveedor_id;

create view public.vista_entradas_inventario with (security_invoker = true) as
select * from public.vista_movimientos_inventario where cantidad > 0;

create view public.vista_salidas_inventario with (security_invoker = true) as
select * from public.vista_movimientos_inventario where cantidad < 0;

-- Costo de cada producto según su receta y los costos actuales de los insumos
create view public.vista_costo_productos with (security_invoker = true) as
select p.id as producto_id, p.nombre, p.precio,
       coalesce(sum(r.cantidad * i.costo_unitario), 0)::numeric(12,2) as costo_receta,
       (p.precio - coalesce(sum(r.cantidad * i.costo_unitario), 0))::numeric(12,2) as margen
from public.productos p
left join public.recetas r on r.producto_id = p.id
left join public.insumos i on i.id = r.insumo_id
group by p.id, p.nombre, p.precio;

-- =====================================================================
-- 10. LÓGICA AUTOMÁTICA
-- =====================================================================

-- ---------- 10.1 Alertas: crear (sin duplicar) y resolver ----------
create or replace function public._crear_alerta(
  p_tipo text, p_severidad text, p_titulo text, p_mensaje text,
  p_insumo_id bigint default null, p_producto_id bigint default null, p_pedido_id bigint default null,
  p_datos jsonb default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  select id into v_id from public.alertas
   where tipo = p_tipo and not resuelta
     and insumo_id is not distinct from p_insumo_id
     and producto_id is not distinct from p_producto_id
     and pedido_id is not distinct from p_pedido_id
   limit 1;
  if v_id is not null then
    update public.alertas
       set titulo = p_titulo, mensaje = p_mensaje, severidad = p_severidad,
           datos = coalesce(p_datos, datos), actualizado_en = now()
     where id = v_id and (mensaje is distinct from p_mensaje or severidad is distinct from p_severidad);
    return v_id;
  end if;
  begin
    insert into public.alertas (tipo, severidad, titulo, mensaje, insumo_id, producto_id, pedido_id, datos)
    values (p_tipo, p_severidad, p_titulo, p_mensaje, p_insumo_id, p_producto_id, p_pedido_id, p_datos)
    returning id into v_id;
  exception when unique_violation then
    v_id := null;  -- otra transacción la creó al mismo tiempo
  end;
  return v_id;
end $$;

create or replace function public._resolver_alertas(
  p_tipos text[], p_insumo_id bigint default null, p_producto_id bigint default null, p_pedido_id bigint default null
) returns void language sql security definer set search_path = public as $$
  update public.alertas
     set resuelta = true, resuelta_en = now(), resuelta_por = auth.uid(), actualizado_en = now()
   where not resuelta and tipo = any (p_tipos)
     and (p_insumo_id is null or insumo_id = p_insumo_id)
     and (p_producto_id is null or producto_id = p_producto_id)
     and (p_pedido_id is null or pedido_id = p_pedido_id);
$$;

-- Alertas de un insumo: INVENTARIO BAJO / INSUMO AGOTADO
create or replace function public._sincronizar_alertas_insumo(p_insumo_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare i public.insumos;
begin
  select * into i from public.insumos where id = p_insumo_id;
  if not found then return; end if;
  if not i.activo then
    perform public._resolver_alertas(array['inventario_bajo','insumo_agotado'], i.id);
  elsif i.estado = 'agotado' then
    perform public._crear_alerta('insumo_agotado', 'critica', '🚨 INSUMO AGOTADO',
      format('%s: %s disponibles.', i.nombre, public.formato_cantidad(i.stock, i.unidad)), i.id);
    perform public._resolver_alertas(array['inventario_bajo'], i.id);
  elsif i.estado = 'bajo' then
    perform public._crear_alerta('inventario_bajo', 'alta', '⚠️ INVENTARIO BAJO',
      format('%s: %s disponibles. Mínimo establecido: %s.', i.nombre,
             public.formato_cantidad(i.stock, i.unidad), public.formato_cantidad(i.stock_minimo, i.unidad)), i.id);
    perform public._resolver_alertas(array['insumo_agotado'], i.id);
  else
    perform public._resolver_alertas(array['inventario_bajo','insumo_agotado'], i.id);
  end if;
end $$;

-- Alertas de productos que ya no se pueden preparar
create or replace function public._sincronizar_alertas_productos()
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select * from public.vista_disponibilidad_productos loop
    if r.activo and not r.disponible then
      perform public._crear_alerta('producto_no_disponible', 'alta', '⛔ PRODUCTO NO DISPONIBLE',
        format('%s no puede venderse: inventario insuficiente de %s.', r.nombre,
               lower(public.lista_texto(r.insumos_faltantes))), null, r.producto_id);
    else
      perform public._resolver_alertas(array['producto_no_disponible','venta_rechazada'], null, r.producto_id);
    end if;
  end loop;
end $$;

-- Alerta general: REABASTECIMIENTO NECESARIO
create or replace function public._sincronizar_alerta_reabastecimiento()
returns void language plpgsql security definer set search_path = public as $$
declare v_nombres text[]; v_datos jsonb;
begin
  select array_agg(lower(nombre) order by (estado = 'agotado') desc, nombre),
         jsonb_agg(jsonb_build_object('insumo_id', id, 'nombre', nombre, 'sugerido', sugerido_texto) order by nombre)
    into v_nombres, v_datos
  from public.vista_reabastecimiento;
  if v_nombres is null then
    perform public._resolver_alertas(array['reabastecimiento']);
  else
    perform public._crear_alerta('reabastecimiento', 'media', '📦 REABASTECIMIENTO NECESARIO',
      'Se recomienda comprar ' || public.lista_texto(v_nombres) || '.', null, null, null, v_datos);
  end if;
end $$;

-- Cuando cambia el stock (o el mínimo) de un insumo, se revisan las alertas
create or replace function public.tg_insumo_revisar_alertas()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._sincronizar_alertas_insumo(new.id);
  perform public._sincronizar_alertas_productos();
  perform public._sincronizar_alerta_reabastecimiento();
  return null;
end $$;

drop trigger if exists trg_insumo_revisar_alertas on public.insumos;
create trigger trg_insumo_revisar_alertas
after update of stock, stock_minimo, stock_maximo, activo on public.insumos
for each row when (old.stock is distinct from new.stock or old.stock_minimo is distinct from new.stock_minimo
                   or old.stock_maximo is distinct from new.stock_maximo or old.activo is distinct from new.activo)
execute function public.tg_insumo_revisar_alertas();

-- Si cambia una receta o se activa/desactiva un producto, se recalcula la disponibilidad
create or replace function public.tg_revisar_disponibilidad()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._sincronizar_alertas_productos();
  return null;
end $$;

drop trigger if exists trg_recetas_disponibilidad on public.recetas;
create trigger trg_recetas_disponibilidad after insert or update or delete on public.recetas
for each statement execute function public.tg_revisar_disponibilidad();

drop trigger if exists trg_productos_disponibilidad on public.productos;
create trigger trg_productos_disponibilidad after update of activo on public.productos
for each statement execute function public.tg_revisar_disponibilidad();

-- ---------- 10.2 Cálculo de insumos requeridos ----------
-- p_items: [{"product_id": 5, "quantity": 2}, ...]
create or replace function public._requerimientos_items(p_items jsonb)
returns table (insumo_id bigint, requerido numeric) language sql stable security definer set search_path = public as $$
  with it as (
    select (e ->> 'product_id')::bigint as producto_id, sum((e ->> 'quantity')::int) as cantidad
    from jsonb_array_elements(p_items) e
    group by 1
  )
  select r.insumo_id, sum(r.cantidad * it.cantidad)
  from it join public.recetas r on r.producto_id = it.producto_id
  group by r.insumo_id;
$$;

-- Insumos que NO alcanzan para un carrito (considera lo apartado por pedidos nuevos)
create or replace function public._faltantes_items(p_items jsonb)
returns table (insumo_id bigint, nombre text, unidad text, requerido numeric, disponible numeric)
language sql stable security definer set search_path = public as $$
  select q.insumo_id, i.nombre, i.unidad, q.requerido, greatest(i.stock - coalesce(c.comprometido, 0), 0)
  from public._requerimientos_items(p_items) q
  join public.insumos i on i.id = q.insumo_id
  left join public.vista_stock_comprometido c on c.insumo_id = q.insumo_id
  where q.requerido > i.stock - coalesce(c.comprometido, 0);
$$;

-- Insumos que NO alcanzan para confirmar un pedido existente
create or replace function public._faltantes_pedido(p_pedido_id bigint)
returns table (insumo_id bigint, nombre text, unidad text, requerido numeric, disponible numeric)
language sql stable security definer set search_path = public as $$
  select q.insumo_id, i.nombre, i.unidad, q.requerido, i.stock
  from (
    select r.insumo_id, sum(r.cantidad * d.cantidad) as requerido
    from public.detalle_pedidos d join public.recetas r on r.producto_id = d.producto_id
    where d.pedido_id = p_pedido_id
    group by r.insumo_id
  ) q
  join public.insumos i on i.id = q.insumo_id
  where q.requerido > i.stock;
$$;

-- ---------- 10.3 Descuento y devolución de inventario ----------
create or replace function public._descontar_inventario_pedido(p_pedido_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_faltan text;
begin
  -- Protección 1: si ya existe la salida de este pedido, no se vuelve a descontar
  if exists (select 1 from public.movimientos_inventario where pedido_id = p_pedido_id and tipo = 'salida_venta') then
    return;
  end if;
  -- Bloquea los insumos involucrados (en orden, para evitar bloqueos cruzados)
  perform 1 from public.insumos
   where id in (select r2.insumo_id from public.detalle_pedidos d join public.recetas r2 on r2.producto_id = d.producto_id
                 where d.pedido_id = p_pedido_id)
   order by id for update;

  select string_agg(format('%s (se requieren %s, hay %s)', f.nombre,
                           public.formato_cantidad(f.requerido, f.unidad), public.formato_cantidad(f.disponible, f.unidad)), '; ')
    into v_faltan
  from public._faltantes_pedido(p_pedido_id) f;
  if v_faltan is not null then
    raise exception 'Inventario insuficiente para el pedido #%: %', p_pedido_id, v_faltan
      using errcode = 'P0001', hint = 'INVENTARIO_INSUFICIENTE';
  end if;

  for r in
    select rc.insumo_id, sum(rc.cantidad * d.cantidad) as requerido
    from public.detalle_pedidos d join public.recetas rc on rc.producto_id = d.producto_id
    where d.pedido_id = p_pedido_id
    group by rc.insumo_id order by rc.insumo_id
  loop
    -- Protección 2: índice único (pedido_id, insumo_id) impide un segundo descuento
    insert into public.movimientos_inventario (insumo_id, tipo, cantidad, pedido_id, motivo)
    values (r.insumo_id, 'salida_venta', -r.requerido, p_pedido_id, 'Venta — pedido #' || p_pedido_id);
  end loop;
end $$;

-- Devuelve EXACTAMENTE lo que se descontó (según los movimientos registrados)
create or replace function public._devolver_inventario_pedido(p_pedido_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    select m.insumo_id, -m.cantidad as cantidad
    from public.movimientos_inventario m
    where m.pedido_id = p_pedido_id and m.tipo = 'salida_venta'
      and not exists (select 1 from public.movimientos_inventario x
                      where x.pedido_id = p_pedido_id and x.insumo_id = m.insumo_id and x.tipo = 'devolucion')
    order by m.insumo_id
  loop
    insert into public.movimientos_inventario (insumo_id, tipo, cantidad, pedido_id, motivo)
    values (r.insumo_id, 'devolucion', r.cantidad, p_pedido_id, 'Devolución por cancelación — pedido #' || p_pedido_id);
  end loop;
end $$;

-- ---------- 10.4 Máquina de estados del pedido ----------
--  nuevo → confirmado → en_preparacion → listo → entregado
--  cualquier estado no final → cancelado
--  Los pedidos solo avanzan. Al llegar a un estado "de venta" se descuenta
--  el inventario UNA sola vez. Si se cancela después, se devuelve.
create or replace function public.tg_pedido_antes_insertar()
returns trigger language plpgsql as $$
begin
  new.codigo_seguimiento := coalesce(new.codigo_seguimiento, public.generar_codigo_pedido());
  new.estado_actualizado_en := coalesce(new.estado_actualizado_en, now());
  return new;
end $$;

drop trigger if exists trg_pedido_antes_insertar on public.pedidos;
create trigger trg_pedido_antes_insertar before insert on public.pedidos
for each row execute function public.tg_pedido_antes_insertar();

create or replace function public.tg_pedido_antes_actualizar()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_old public.estados_pedido; v_new public.estados_pedido;
begin
  -- Campos que nadie puede alterar manualmente
  new.id := old.id;                       new.codigo_seguimiento := old.codigo_seguimiento;
  new.cliente_id := old.cliente_id;       new.user_id := old.user_id;
  new.subtotal := old.subtotal;           new.descuento := old.descuento;
  new.envio := old.envio;                 new.total := old.total;
  new.creado_en := old.creado_en;         new.cupon_codigo := old.cupon_codigo;
  new.inventario_descontado := old.inventario_descontado;
  new.inventario_descontado_en := old.inventario_descontado_en;
  new.inventario_devuelto := old.inventario_devuelto;
  new.inventario_devuelto_en := old.inventario_devuelto_en;
  new.actualizado_en := now();

  if new.estado is not distinct from old.estado then
    new.estado_actualizado_en := old.estado_actualizado_en;
    return new;
  end if;

  select * into v_old from public.estados_pedido where codigo = old.estado;
  select * into v_new from public.estados_pedido where codigo = new.estado;
  if v_new.codigo is null then
    raise exception 'Estado no válido: %', new.estado;
  end if;
  if v_old.es_final then
    raise exception 'El pedido #% ya está "%" y no puede cambiar de estado.', old.id, v_old.nombre;
  end if;
  if new.estado <> 'cancelado' and v_new.orden <= v_old.orden then
    raise exception 'Cambio no permitido: de "%" a "%". Los pedidos solo avanzan o se cancelan.', v_old.nombre, v_new.nombre;
  end if;

  new.estado_actualizado_en := now();

  -- DESCUENTO AUTOMÁTICO (una sola vez)
  if v_new.es_venta and not old.inventario_descontado then
    perform public._descontar_inventario_pedido(new.id);
    new.inventario_descontado := true;
    new.inventario_descontado_en := now();
  end if;

  -- DEVOLUCIÓN AUTOMÁTICA al cancelar un pedido ya descontado (una sola vez)
  if new.estado = 'cancelado' and old.inventario_descontado and not old.inventario_devuelto then
    perform public._devolver_inventario_pedido(new.id);
    new.inventario_devuelto := true;
    new.inventario_devuelto_en := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_pedido_antes_actualizar on public.pedidos;
create trigger trg_pedido_antes_actualizar before update on public.pedidos
for each row execute function public.tg_pedido_antes_actualizar();

create or replace function public.tg_pedido_despues()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_titulo text; v_msg text; v_puntos int; v_insertados int;
begin
  if tg_op = 'INSERT' then
    insert into public.historial_estados_pedido (pedido_id, estado_anterior, estado_nuevo, usuario_id, nota)
    values (new.id, null, new.estado, auth.uid(), 'Pedido registrado');
    return null;
  end if;

  if new.estado is not distinct from old.estado then return null; end if;

  -- 1) Historial del cambio
  insert into public.historial_estados_pedido (pedido_id, estado_anterior, estado_nuevo, usuario_id, nota)
  values (new.id, old.estado, new.estado, auth.uid(),
          coalesce(nullif(current_setting('cafe_aroma.nota_estado', true), ''),
                   case when new.estado = 'cancelado' then new.motivo_cancelacion end));

  -- 2) Aviso al cliente registrado (V2)
  if new.user_id is not null then
    v_titulo := case new.estado
      when 'confirmado' then 'Pedido confirmado'
      when 'en_preparacion' then 'Tu pedido está en preparación'
      when 'listo' then '¡Tu pedido está listo!'
      when 'entregado' then 'Pedido entregado'
      when 'cancelado' then 'Pedido cancelado'
      else 'Actualización de tu pedido' end;
    v_msg := case new.estado
      when 'confirmado' then 'Confirmamos tu pedido #' || new.id || '. Pronto comenzaremos a prepararlo.'
      when 'en_preparacion' then 'Estamos preparando tu pedido #' || new.id || '.'
      when 'listo' then 'Puedes pasar por tu pedido #' || new.id || '.'
      when 'entregado' then 'Gracias por comprar en Café Aroma.'
      when 'cancelado' then 'Tu pedido #' || new.id || ' fue cancelado.'
      else 'Tu pedido #' || new.id || ' cambió de estado.' end;
    insert into public.notificaciones (user_id, pedido_id, titulo, mensaje) values (new.user_id, new.id, v_titulo, v_msg);
  end if;

  -- 3) Puntos de lealtad al entregar (V2): 1 punto por cada $10
  if new.estado = 'entregado' and new.user_id is not null then
    v_puntos := floor(new.total / 10);
    insert into public.movimientos_puntos (user_id, pedido_id, puntos, descripcion)
    values (new.user_id, new.id, v_puntos, 'Puntos por pedido entregado')
    on conflict (pedido_id) do nothing;
    get diagnostics v_insertados = row_count;
    if v_insertados > 0 then
      insert into public.puntos_cliente (user_id, puntos) values (new.user_id, v_puntos)
      on conflict (user_id) do update set puntos = public.puntos_cliente.puntos + excluded.puntos, actualizado_en = now();
    end if;
  end if;

  -- 4) Alertas relacionadas con el pedido
  perform public._resolver_alertas(array['pedido_atrasado'], null, null, new.id);
  if new.estado in ('entregado','cancelado') or new.inventario_descontado then
    perform public._resolver_alertas(array['pedido_sin_inventario'], null, null, new.id);
  end if;
  perform public._sincronizar_alertas_productos();
  return null;
end $$;

drop trigger if exists trg_pedido_despues on public.pedidos;
create trigger trg_pedido_despues after insert or update on public.pedidos
for each row execute function public.tg_pedido_despues();

-- ---------- 10.5 RPC públicas (sitio del cliente) ----------

-- Menú con disponibilidad REAL calculada desde los insumos (no expone cantidades)
create or replace function public.obtener_menu()
returns table (id bigint, categoria_id bigint, categoria_slug text, categoria_nombre text, categoria_icono text,
               nombre text, descripcion text, precio numeric, imagen text, disponible boolean)
language sql stable security definer set search_path = public as $$
  select p.id, c.id, c.slug, c.nombre, c.icono, p.nombre, p.descripcion, p.precio, p.imagen,
         coalesce(v.disponible, false)
  from public.productos p
  join public.categorias c on c.id = p.categoria_id
  left join public.vista_disponibilidad_productos v on v.producto_id = p.id
  where p.activo and c.activo
  order by c.orden, c.id, p.orden, p.id;
$$;

-- Normaliza y valida los productos del carrito
create or replace function public._normalizar_items(p_items jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'El pedido no tiene productos.';
  end if;
  if jsonb_array_length(p_items) > 40 then
    raise exception 'Demasiados productos en un solo pedido.';
  end if;
  select jsonb_agg(jsonb_build_object('product_id', pid, 'quantity', qty) order by pid) into v
  from (
    select (e ->> 'product_id')::bigint as pid, sum((e ->> 'quantity')::int) as qty
    from jsonb_array_elements(p_items) e
    group by 1
  ) x;
  if exists (select 1 from jsonb_array_elements(v) e
             where (e ->> 'product_id') is null or (e ->> 'quantity')::int not between 1 and 50) then
    raise exception 'Cantidad no válida (de 1 a 50 por producto).';
  end if;
  return v;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'Formato de productos no válido.';
end $$;

-- Verifica un carrito ANTES de pagar
create or replace function public.verificar_carrito(p_items jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_items jsonb; v_no jsonb;
begin
  v_items := public._normalizar_items(p_items);
  select coalesce(jsonb_agg(distinct jsonb_build_object('producto_id', p.id, 'nombre', p.nombre)), '[]'::jsonb)
    into v_no
  from jsonb_array_elements(v_items) e
  join public.productos p on p.id = (e ->> 'product_id')::bigint
  left join public.categorias c on c.id = p.categoria_id
  where not p.activo or not c.activo
     or exists (select 1 from public.recetas r join public._faltantes_items(v_items) f on f.insumo_id = r.insumo_id
                where r.producto_id = p.id);
  -- Productos que ya no existen
  select v_no || coalesce(jsonb_agg(jsonb_build_object('producto_id', (e ->> 'product_id')::bigint, 'nombre', 'Producto no encontrado')), '[]'::jsonb)
    into v_no
  from jsonb_array_elements(v_items) e
  where not exists (select 1 from public.productos p where p.id = (e ->> 'product_id')::bigint);
  return jsonb_build_object('ok', jsonb_array_length(v_no) = 0, 'no_disponibles', v_no);
end $$;

-- Crea un pedido de forma segura (precios y totales se calculan en el servidor)
create or replace function public.crear_pedido(
  p_nombre text, p_telefono text, p_email text, p_notas text,
  p_metodo_pago text, p_items jsonb, p_cupon text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_items jsonb; v_cliente_id bigint; v_pedido_id bigint; v_codigo text; v_estado text;
  v_subtotal numeric(10,2) := 0; v_descuento numeric(10,2) := 0; v_envio numeric(10,2); v_total numeric(10,2);
  v_pct numeric; v_cupon text; v_no jsonb; e jsonb; p public.productos;
begin
  -- Validaciones
  if length(trim(coalesce(p_nombre, ''))) < 2 or length(trim(coalesce(p_telefono, ''))) < 7 then
    return jsonb_build_object('ok', false, 'error', 'datos_invalidos', 'mensaje', 'Nombre y teléfono (mínimo 7 dígitos) son obligatorios.');
  end if;
  if not exists (select 1 from public.metodos_pago where codigo = p_metodo_pago and activo) then
    return jsonb_build_object('ok', false, 'error', 'metodo_pago', 'mensaje', 'Método de pago no válido.');
  end if;
  v_items := public._normalizar_items(p_items);

  for e in select * from jsonb_array_elements(v_items) loop
    select pr.* into p from public.productos pr join public.categorias c on c.id = pr.categoria_id
     where pr.id = (e ->> 'product_id')::bigint and pr.activo and c.activo;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'producto_invalido',
                                'mensaje', 'Uno de los productos ya no está en el menú. Actualiza tu carrito.');
    end if;
    v_subtotal := v_subtotal + p.precio * (e ->> 'quantity')::int;
  end loop;

  -- Bloquea los insumos que usará este pedido: dos clientes no pueden "ganarse" el último insumo
  perform 1 from public.insumos
   where id in (select insumo_id from public._requerimientos_items(v_items))
   order by id for update;

  -- ¿Alcanzan los insumos? (considera los pedidos nuevos que ya apartaron inventario)
  select coalesce(jsonb_agg(distinct jsonb_build_object('producto_id', pr.id, 'nombre', pr.nombre)), '[]'::jsonb)
    into v_no
  from jsonb_array_elements(v_items) x
  join public.productos pr on pr.id = (x ->> 'product_id')::bigint
  where exists (select 1 from public.recetas r join public._faltantes_items(v_items) f on f.insumo_id = r.insumo_id
                where r.producto_id = pr.id);

  if jsonb_array_length(v_no) > 0 then
    -- Aviso al administrador
    perform public._crear_alerta('venta_rechazada', 'media', '🛑 VENTA RECHAZADA POR INVENTARIO',
              format('Un cliente intentó comprar %s, pero no hay insumos suficientes.', (x ->> 'nombre')),
              null, (x ->> 'producto_id')::bigint)
      from jsonb_array_elements(v_no) x;
    return jsonb_build_object('ok', false, 'error', 'sin_inventario', 'no_disponibles', v_no,
      'mensaje', 'No hay insumos suficientes para: ' ||
                 (select string_agg(x ->> 'nombre', ', ') from jsonb_array_elements(v_no) x) || '.');
  end if;

  -- Cupón (opcional)
  if nullif(trim(coalesce(p_cupon, '')), '') is not null then
    select codigo, descuento into v_cupon, v_pct from public.cupones
     where codigo = upper(trim(p_cupon)) and activo and (expira_en is null or expira_en > now());
    if v_cupon is null then
      return jsonb_build_object('ok', false, 'error', 'cupon', 'mensaje', 'El cupón no existe o ya expiró.');
    end if;
    v_descuento := round(v_subtotal * v_pct / 100, 2);
  end if;

  v_envio := public.config_numero('costo_envio', 20);
  v_total := v_subtotal - v_descuento + v_envio;

  -- Cliente (se reutiliza si el usuario ya tiene uno)
  if v_user is not null then
    select id into v_cliente_id from public.clientes where user_id = v_user order by id desc limit 1;
  end if;
  if v_cliente_id is null then
    insert into public.clientes (user_id, nombre, telefono, email)
    values (v_user, trim(p_nombre), trim(p_telefono), nullif(trim(coalesce(p_email, '')), ''))
    returning id into v_cliente_id;
  else
    update public.clientes set nombre = trim(p_nombre), telefono = trim(p_telefono),
           email = nullif(trim(coalesce(p_email, '')), '') where id = v_cliente_id;
  end if;

  insert into public.pedidos (cliente_id, user_id, estado, metodo_pago, subtotal, descuento, envio, total, cupon_codigo, notas)
  values (v_cliente_id, v_user, 'nuevo', p_metodo_pago, v_subtotal, v_descuento, v_envio, v_total, v_cupon,
          nullif(left(trim(coalesce(p_notas, '')), 500), ''))
  returning id, codigo_seguimiento into v_pedido_id, v_codigo;

  insert into public.detalle_pedidos (pedido_id, producto_id, producto_nombre, precio_unitario, cantidad)
  select v_pedido_id, pr.id, pr.nombre, pr.precio, (x ->> 'quantity')::int
  from jsonb_array_elements(v_items) x join public.productos pr on pr.id = (x ->> 'product_id')::bigint;

  -- Confirmación automática (opcional, configurable)
  if public.config_texto('confirmacion_automatica', 'false') = 'true' then
    perform set_config('cafe_aroma.nota_estado', 'Confirmación automática', true);
    update public.pedidos set estado = 'confirmado' where id = v_pedido_id;
    perform set_config('cafe_aroma.nota_estado', '', true);
  end if;

  select estado into v_estado from public.pedidos where id = v_pedido_id;
  perform public._sincronizar_alertas_productos();
  return jsonb_build_object('ok', true, 'pedido_id', v_pedido_id, 'codigo', v_codigo, 'estado', v_estado,
                            'subtotal', v_subtotal, 'descuento', v_descuento, 'envio', v_envio, 'total', v_total);
end $$;

-- Consulta pública del estado de un pedido con su código (no muestra datos personales)
create or replace function public.consultar_pedido(p_codigo text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'codigo', p.codigo_seguimiento, 'estado', p.estado, 'estado_nombre', e.nombre,
    'metodo_pago', m.nombre, 'subtotal', p.subtotal, 'descuento', p.descuento, 'envio', p.envio, 'total', p.total,
    'creado_en', p.creado_en, 'estado_actualizado_en', p.estado_actualizado_en,
    'puede_cancelar', p.estado = 'nuevo',
    'items', (select coalesce(jsonb_agg(jsonb_build_object('nombre', d.producto_nombre, 'cantidad', d.cantidad,
                                                           'precio', d.precio_unitario, 'subtotal', d.subtotal) order by d.id), '[]')
              from public.detalle_pedidos d where d.pedido_id = p.id),
    'historial', (select coalesce(jsonb_agg(jsonb_build_object('estado', h.estado_nuevo, 'fecha', h.creado_en) order by h.creado_en), '[]')
                  from public.historial_estados_pedido h where h.pedido_id = p.id)
  )
  from public.pedidos p
  join public.estados_pedido e on e.codigo = p.estado
  join public.metodos_pago m on m.codigo = p.metodo_pago
  where p.codigo_seguimiento = upper(trim(p_codigo));
$$;

-- El cliente puede cancelar su pedido mientras siga como "Nuevo"
create or replace function public.cancelar_mi_pedido(p_codigo text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.pedidos;
begin
  select * into v from public.pedidos where codigo_seguimiento = upper(trim(p_codigo)) for update;
  if not found then
    return jsonb_build_object('ok', false, 'mensaje', 'Pedido no encontrado.');
  end if;
  if v.user_id is not null and v.user_id is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'mensaje', 'Inicia sesión con la cuenta que hizo el pedido para cancelarlo.');
  end if;
  if v.estado <> 'nuevo' then
    return jsonb_build_object('ok', false, 'mensaje', 'El pedido ya fue confirmado; comunícate con la cafetería para cancelarlo.');
  end if;
  perform set_config('cafe_aroma.nota_estado', 'Cancelado por el cliente', true);
  update public.pedidos set estado = 'cancelado', motivo_cancelacion = 'Cancelado por el cliente' where id = v.id;
  return jsonb_build_object('ok', true, 'mensaje', 'Tu pedido fue cancelado.');
end $$;

-- ---------- 10.6 RPC administrativas: pedidos ----------
create or replace function public.cambiar_estado_pedido(p_pedido_id bigint, p_estado text, p_nota text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.pedidos; v_es_venta boolean; v_faltan text; r public.pedidos;
begin
  perform public.requiere_admin();
  select * into v from public.pedidos where id = p_pedido_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'mensaje', 'Pedido no encontrado.');
  end if;
  if v.estado = p_estado then
    return jsonb_build_object('ok', true, 'estado', v.estado, 'mensaje', 'Sin cambios.');
  end if;
  select es_venta into v_es_venta from public.estados_pedido where codigo = p_estado;
  if v_es_venta is null then
    return jsonb_build_object('ok', false, 'mensaje', 'Estado no válido.');
  end if;

  -- Revisión previa: ¿alcanza el inventario para confirmar?
  if v_es_venta and not v.inventario_descontado then
    select string_agg(format('%s (se requieren %s, hay %s)', f.nombre,
                             public.formato_cantidad(f.requerido, f.unidad), public.formato_cantidad(f.disponible, f.unidad)), '; ')
      into v_faltan from public._faltantes_pedido(p_pedido_id) f;
    if v_faltan is not null then
      perform public._crear_alerta('pedido_sin_inventario', 'critica', '🚫 PEDIDO SIN INVENTARIO',
        format('El pedido #%s no se puede confirmar: %s.', p_pedido_id, v_faltan), null, null, p_pedido_id);
      return jsonb_build_object('ok', false, 'error', 'inventario_insuficiente',
                                'mensaje', 'Inventario insuficiente: ' || v_faltan);
    end if;
  end if;

  perform set_config('cafe_aroma.nota_estado', coalesce(p_nota, ''), true);
  begin
    update public.pedidos
       set estado = p_estado,
           motivo_cancelacion = case when p_estado = 'cancelado' then coalesce(nullif(p_nota, ''), 'Cancelado por el administrador')
                                     else motivo_cancelacion end
     where id = p_pedido_id
    returning * into r;
  exception when others then
    return jsonb_build_object('ok', false, 'mensaje', sqlerrm);
  end;
  perform set_config('cafe_aroma.nota_estado', '', true);

  return jsonb_build_object('ok', true, 'estado', r.estado,
    'inventario_descontado', r.inventario_descontado, 'inventario_devuelto', r.inventario_devuelto,
    'mensaje', case
      when r.estado = 'cancelado' and r.inventario_devuelto and not v.inventario_devuelto then 'Pedido cancelado. Los insumos se devolvieron al inventario.'
      when r.inventario_descontado and not v.inventario_descontado then 'Estado actualizado. Insumos descontados automáticamente.'
      else 'Estado actualizado.' end);
end $$;

-- Detecta pedidos atrasados y genera/actualiza su alerta
create or replace function public.revisar_pedidos_atrasados()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  perform public.requiere_admin();
  for r in select * from public.vista_pedidos_atrasados loop
    perform public._crear_alerta('pedido_atrasado', 'alta', '⏱️ PEDIDO ATRASADO',
      format('Pedido #%s lleva %s minutos %s.', r.id, r.minutos_en_estado,
             case r.estado when 'en_preparacion' then 'en preparación'
                           when 'nuevo' then 'sin confirmar'
                           else 'confirmado sin iniciar su preparación' end),
      null, null, r.id);
    n := n + 1;
  end loop;
  -- Pedidos que ya no están atrasados (por ejemplo, si se cambió el límite)
  update public.alertas a set resuelta = true, resuelta_en = now(), actualizado_en = now()
   where a.tipo = 'pedido_atrasado' and not a.resuelta
     and not exists (select 1 from public.vista_pedidos_atrasados v where v.id = a.pedido_id);
  return n;
end $$;

-- ---------- 10.7 RPC administrativas: inventario ----------
create or replace function public._convertir_cantidad(p_cantidad numeric, p_de text, p_a text)
returns numeric language plpgsql stable set search_path = public as $$
declare d public.unidades_medida; a public.unidades_medida;
begin
  if p_de is null or p_de = p_a then return p_cantidad; end if;
  select * into d from public.unidades_medida where codigo = p_de;
  select * into a from public.unidades_medida where codigo = p_a;
  if d.codigo is null or a.codigo is null then
    raise exception 'Unidad desconocida.';
  end if;
  if d.tipo <> a.tipo then
    raise exception 'No se puede convertir % a % (son tipos de medida distintos).', d.nombre, a.nombre;
  end if;
  return p_cantidad * d.factor_base / a.factor_base;
end $$;

-- Registra entrada (compra), merma (desperdicio) o ajuste manual
create or replace function public.registrar_movimiento_inventario(
  p_insumo_id bigint, p_tipo text, p_cantidad numeric, p_unidad text default null,
  p_motivo text default null, p_costo_unitario numeric default null, p_proveedor_id bigint default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.insumos; v_cant numeric; v_costo numeric; v_mov public.movimientos_inventario;
begin
  perform public.requiere_admin();
  if p_tipo not in ('entrada','merma','ajuste') then
    return jsonb_build_object('ok', false, 'mensaje', 'Tipo no permitido. Usa entrada, merma o ajuste.');
  end if;
  select * into i from public.insumos where id = p_insumo_id;
  if not found then return jsonb_build_object('ok', false, 'mensaje', 'Insumo no encontrado.'); end if;
  if p_cantidad is null or p_cantidad = 0 or (p_tipo <> 'ajuste' and p_cantidad < 0) then
    return jsonb_build_object('ok', false, 'mensaje', 'La cantidad debe ser mayor que cero.');
  end if;

  v_cant := public._convertir_cantidad(p_cantidad, coalesce(p_unidad, i.unidad), i.unidad);
  -- El costo se captura por la unidad elegida; se guarda por unidad del insumo
  v_costo := case when p_costo_unitario is null then null
                  else p_costo_unitario / public._convertir_cantidad(1, coalesce(p_unidad, i.unidad), i.unidad) end;
  if p_tipo = 'merma' then v_cant := -v_cant; end if;

  begin
    insert into public.movimientos_inventario (insumo_id, tipo, cantidad, costo_unitario, proveedor_id, motivo)
    values (i.id, p_tipo, round(v_cant, 3), v_costo, p_proveedor_id, nullif(trim(coalesce(p_motivo, '')), ''))
    returning * into v_mov;
  exception when others then
    return jsonb_build_object('ok', false, 'mensaje', sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'movimiento_id', v_mov.id,
    'stock_nuevo', v_mov.stock_nuevo, 'stock_texto', public.formato_cantidad(v_mov.stock_nuevo, i.unidad),
    'mensaje', format('%s: %s → %s', i.nombre, public.formato_cantidad(v_mov.stock_anterior, i.unidad),
                      public.formato_cantidad(v_mov.stock_nuevo, i.unidad)));
end $$;

-- Conteo físico: el administrador indica cuánto hay realmente y se registra el ajuste
create or replace function public.ajustar_inventario_conteo(
  p_insumo_id bigint, p_stock_real numeric, p_unidad text default null, p_motivo text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.insumos; v_real numeric;
begin
  perform public.requiere_admin();
  select * into i from public.insumos where id = p_insumo_id;
  if not found then return jsonb_build_object('ok', false, 'mensaje', 'Insumo no encontrado.'); end if;
  if p_stock_real is null or p_stock_real < 0 then
    return jsonb_build_object('ok', false, 'mensaje', 'El stock real no puede ser negativo.');
  end if;
  v_real := round(public._convertir_cantidad(p_stock_real, coalesce(p_unidad, i.unidad), i.unidad), 3);
  if v_real = i.stock then
    return jsonb_build_object('ok', true, 'mensaje', 'El conteo coincide; no se registró ajuste.');
  end if;
  return public.registrar_movimiento_inventario(i.id, 'ajuste', v_real - i.stock, i.unidad,
                                                coalesce(nullif(p_motivo, ''), 'Conteo físico'));
end $$;

-- Crea un insumo nuevo con su inventario inicial
create or replace function public.crear_insumo(
  p_nombre text, p_unidad text, p_stock_inicial numeric default 0, p_stock_minimo numeric default 0,
  p_stock_maximo numeric default null, p_costo_unitario numeric default 0, p_proveedor_id bigint default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform public.requiere_admin();
  if exists (select 1 from public.insumos where lower(nombre) = lower(trim(p_nombre))) then
    return jsonb_build_object('ok', false, 'mensaje', 'Ya existe un insumo con ese nombre.');
  end if;
  begin
    insert into public.insumos (nombre, unidad, stock, stock_minimo, stock_maximo, costo_unitario, proveedor_id)
    values (trim(p_nombre), p_unidad, 0, coalesce(p_stock_minimo, 0), p_stock_maximo, coalesce(p_costo_unitario, 0), p_proveedor_id)
    returning id into v_id;
    if coalesce(p_stock_inicial, 0) > 0 then
      insert into public.movimientos_inventario (insumo_id, tipo, cantidad, costo_unitario, proveedor_id, motivo)
      values (v_id, 'inicial', p_stock_inicial, nullif(p_costo_unitario, 0), p_proveedor_id, 'Inventario inicial');
    else
      perform public._sincronizar_alertas_insumo(v_id);
    end if;
  exception when others then
    return jsonb_build_object('ok', false, 'mensaje', sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'insumo_id', v_id, 'mensaje', 'Insumo creado.');
end $$;

-- Guarda la receta completa de un producto: [{"insumo_id":1,"cantidad":20,"unidad":"g"}, ...]
create or replace function public.guardar_receta(p_producto_id bigint, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e jsonb; i public.insumos; v_cant numeric; n int := 0;
begin
  perform public.requiere_admin();
  if not exists (select 1 from public.productos where id = p_producto_id) then
    return jsonb_build_object('ok', false, 'mensaje', 'Producto no encontrado.');
  end if;
  begin
    delete from public.recetas where producto_id = p_producto_id;
    for e in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
      select * into i from public.insumos where id = (e ->> 'insumo_id')::bigint;
      if not found then raise exception 'Insumo % no encontrado.', e ->> 'insumo_id'; end if;
      v_cant := public._convertir_cantidad((e ->> 'cantidad')::numeric, coalesce(e ->> 'unidad', i.unidad), i.unidad);
      if v_cant is null or v_cant <= 0 then raise exception 'La cantidad de % debe ser mayor que cero.', i.nombre; end if;
      insert into public.recetas (producto_id, insumo_id, cantidad) values (p_producto_id, i.id, round(v_cant, 3))
      on conflict (producto_id, insumo_id) do update set cantidad = public.recetas.cantidad + excluded.cantidad;
      n := n + 1;
    end loop;
  exception when others then
    return jsonb_build_object('ok', false, 'mensaje', sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'insumos', n, 'mensaje', 'Receta guardada con ' || n || ' insumo(s).');
end $$;

create or replace function public.resolver_alerta(p_alerta_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.requiere_admin();
  update public.alertas set resuelta = true, resuelta_en = now(), resuelta_por = auth.uid(), actualizado_en = now()
   where id = p_alerta_id and not resuelta;
  return jsonb_build_object('ok', true);
end $$;

-- =====================================================================
-- 11. REPORTES Y AGENTE INTELIGENTE
--     Todas las cifras salen de las tablas reales. "Venta" = pedido en
--     estado Confirmado, En preparación, Listo o Entregado.
-- =====================================================================
create or replace function public._dinero(p numeric)
returns text language sql immutable as $$
  select to_char(coalesce(p, 0), 'FM$999,999,990.00');
$$;

-- Totales de ventas de un periodo (fechas en la zona horaria del negocio)
create or replace function public._ventas_periodo(p_desde date, p_hasta date)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'desde', p_desde, 'hasta', p_hasta,
    'total', coalesce(sum(p.total), 0),
    'pedidos', count(*),
    'ticket_promedio', coalesce(round(avg(p.total), 2), 0),
    'efectivo', coalesce(sum(p.total) filter (where p.metodo_pago = 'efectivo'), 0),
    'tarjeta', coalesce(sum(p.total) filter (where p.metodo_pago = 'tarjeta'), 0),
    'transferencia', coalesce(sum(p.total) filter (where p.metodo_pago = 'transferencia'), 0)
  )
  from public.pedidos p
  join public.estados_pedido e on e.codigo = p.estado and e.es_venta
  where (p.creado_en at time zone public.tz())::date between p_desde and p_hasta;
$$;

-- Unidades vendidas por producto en un periodo (incluye productos activos con 0 ventas)
create or replace function public._productos_vendidos(p_desde date, p_hasta date)
returns table (producto_id bigint, nombre text, unidades bigint, ventas numeric)
language sql stable security definer set search_path = public as $$
  with v as (
    select d.producto_id, max(d.producto_nombre) as nombre, sum(d.cantidad) as unidades, sum(d.subtotal) as ventas
    from public.detalle_pedidos d
    join public.pedidos p on p.id = d.pedido_id
    join public.estados_pedido e on e.codigo = p.estado and e.es_venta
    where (p.creado_en at time zone public.tz())::date between p_desde and p_hasta
    group by d.producto_id
  )
  select coalesce(pr.id, v.producto_id), coalesce(pr.nombre, v.nombre),
         coalesce(v.unidades, 0)::bigint, coalesce(v.ventas, 0)
  from v full join (select id, nombre from public.productos where activo) pr on pr.id = v.producto_id;
$$;

create or replace function public.reporte_ventas(p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb; v_tz text := public.tz();
begin
  perform public.requiere_admin();
  if p_hasta < p_desde then
    raise exception 'La fecha final debe ser posterior a la inicial.';
  end if;
  with ped as (
    select p.*, (p.creado_en at time zone v_tz)::date as fecha, extract(hour from p.creado_en at time zone v_tz)::int as hora
    from public.pedidos p
    where (p.creado_en at time zone v_tz)::date between p_desde and p_hasta
  ), ventas as (
    select ped.* from ped join public.estados_pedido e on e.codigo = ped.estado and e.es_venta
  )
  select public._ventas_periodo(p_desde, p_hasta) || jsonb_build_object(
    'cancelados', (select count(*) from ped where estado = 'cancelado'),
    'pendientes', (select count(*) from ped where estado = 'nuevo'),
    'descuentos', (select coalesce(sum(descuento), 0) from ventas),
    'por_metodo', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (
        select m.codigo as metodo, m.nombre, m.icono, count(v.id) as pedidos, coalesce(sum(v.total), 0) as total
        from public.metodos_pago m left join ventas v on v.metodo_pago = m.codigo
        group by m.codigo, m.nombre, m.icono) x),
    'por_dia', (select coalesce(jsonb_agg(x order by x.fecha), '[]') from (
        select fecha, count(*) as pedidos, sum(total) as total from ventas group by fecha) x),
    'por_hora', (select coalesce(jsonb_agg(x order by x.hora), '[]') from (
        select hora, count(*) as pedidos, sum(total) as total from ventas group by hora) x),
    'mas_vendidos', (select coalesce(jsonb_agg(x), '[]') from (
        select * from public._productos_vendidos(p_desde, p_hasta) where unidades > 0
        order by unidades desc, ventas desc limit 10) x),
    'menos_vendidos', (select coalesce(jsonb_agg(x), '[]') from (
        select * from public._productos_vendidos(p_desde, p_hasta)
        order by unidades asc, nombre limit 10) x)
  ) into r;
  return r;
end $$;

-- Consumo de insumos en un periodo (según los movimientos reales)
create or replace function public.reporte_consumo_insumos(p_desde date, p_hasta date)
returns table (insumo_id bigint, insumo text, unidad text, consumo_ventas numeric, devoluciones numeric,
               mermas numeric, entradas numeric, ajustes numeric, costo_consumo numeric,
               consumo_texto text, stock_actual text, estado text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.requiere_admin();
  return query
  with m as (
    select mv.insumo_id,
           coalesce(-sum(mv.cantidad) filter (where mv.tipo = 'salida_venta'), 0) as salidas,
           coalesce(sum(mv.cantidad) filter (where mv.tipo = 'devolucion'), 0) as devol,
           coalesce(-sum(mv.cantidad) filter (where mv.tipo = 'merma'), 0) as merma,
           coalesce(sum(mv.cantidad) filter (where mv.tipo in ('entrada','inicial')), 0) as entra,
           coalesce(sum(mv.cantidad) filter (where mv.tipo = 'ajuste'), 0) as ajus
    from public.movimientos_inventario mv
    where (mv.creado_en at time zone public.tz())::date between p_desde and p_hasta
    group by mv.insumo_id
  )
  select i.id, i.nombre, i.unidad,
         (m.salidas - m.devol), m.devol, m.merma, m.entra, m.ajus,
         round((m.salidas - m.devol + m.merma) * i.costo_unitario, 2),
         public.formato_cantidad(m.salidas - m.devol, i.unidad),
         public.formato_cantidad(i.stock, i.unidad), i.estado
  from m join public.insumos i on i.id = m.insumo_id
  order by round((m.salidas - m.devol + m.merma) * i.costo_unitario, 2) desc, i.nombre;
end $$;

-- ¿Qué productos consumen más inventario? (costo de insumos de lo vendido)
create or replace function public.reporte_consumo_por_producto(p_desde date, p_hasta date)
returns table (producto_id bigint, producto text, unidades bigint, costo_insumos numeric, insumos jsonb)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.requiere_admin();
  return query
  with vend as (
    select d.producto_id, sum(d.cantidad) as unidades
    from public.detalle_pedidos d
    join public.pedidos p on p.id = d.pedido_id
    join public.estados_pedido e on e.codigo = p.estado and e.es_venta
    where (p.creado_en at time zone public.tz())::date between p_desde and p_hasta
    group by d.producto_id
  )
  select pr.id, pr.nombre, v.unidades::bigint,
         round(coalesce(sum(r.cantidad * v.unidades * i.costo_unitario), 0), 2),
         coalesce(jsonb_agg(jsonb_build_object('insumo', i.nombre,
                  'cantidad', public.formato_cantidad(r.cantidad * v.unidades, i.unidad)) order by i.nombre)
                  filter (where i.id is not null), '[]')
  from vend v
  join public.productos pr on pr.id = v.producto_id
  left join public.recetas r on r.producto_id = pr.id
  left join public.insumos i on i.id = r.insumo_id
  group by pr.id, pr.nombre, v.unidades
  order by 4 desc, 3 desc;
end $$;

-- Resumen completo del negocio (lo usan el dashboard y el agente)
create or replace function public.resumen_negocio()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_hoy date := public.hoy();
  v_semana date := date_trunc('week', public.hoy())::date;
  v_mes date := date_trunc('month', public.hoy())::date;
  r jsonb;
begin
  perform public.requiere_admin();
  select jsonb_build_object(
    'generado_en', now(),
    'fecha', v_hoy,
    'limites', jsonb_build_object(
        'preparacion', public.config_numero('minutos_atraso_preparacion', 20),
        'sin_atender', public.config_numero('minutos_atraso_sin_atender', 10)),
    'pedidos_por_estado', (
        select jsonb_object_agg(e.codigo, coalesce(x.n, 0))
        from public.estados_pedido e
        left join (select estado, count(*) as n from public.pedidos
                   where estado in ('nuevo','confirmado','en_preparacion','listo')
                      or (estado_actualizado_en at time zone public.tz())::date = v_hoy
                   group by estado) x on x.estado = e.codigo),
    'atrasados', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'codigo', codigo_seguimiento, 'estado', estado,
                    'estado_nombre', estado_nombre, 'minutos', minutos_en_estado, 'cliente', cliente) order by minutos_en_estado desc), '[]')
                  from public.vista_pedidos_atrasados),
    'ventas_hoy', public._ventas_periodo(v_hoy, v_hoy),
    'ventas_semana', public._ventas_periodo(v_semana, v_hoy),
    'ventas_mes', public._ventas_periodo(v_mes, v_hoy),
    'mas_vendidos_hoy', (select coalesce(jsonb_agg(x), '[]') from (
        select nombre, unidades, ventas from public._productos_vendidos(v_hoy, v_hoy)
        where unidades > 0 order by unidades desc, ventas desc limit 5) x),
    'mas_vendidos_mes', (select coalesce(jsonb_agg(x), '[]') from (
        select nombre, unidades, ventas from public._productos_vendidos(v_mes, v_hoy)
        where unidades > 0 order by unidades desc, ventas desc limit 5) x),
    'menos_vendidos_mes', (select coalesce(jsonb_agg(x), '[]') from (
        select nombre, unidades, ventas from public._productos_vendidos(v_mes, v_hoy)
        order by unidades asc, nombre limit 5) x),
    'inventario', jsonb_build_object(
        'total', (select count(*) from public.insumos where activo),
        'normales', (select count(*) from public.insumos where activo and estado in ('normal','exceso')),
        'bajos', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'stock', stock_texto,
                    'minimo', minimo_texto) order by nombre), '[]') from public.vista_inventario where activo and estado = 'bajo'),
        'agotados', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'stock', stock_texto,
                    'minimo', minimo_texto) order by nombre), '[]') from public.vista_inventario where activo and estado = 'agotado'),
        'valor_total', (select coalesce(sum(valor_inventario), 0) from public.vista_inventario where activo)),
    'reabastecer', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'estado', estado,
                    'sugerido', sugerido_texto, 'proveedor', proveedor, 'costo_estimado', costo_estimado) order by nombre), '[]')
                    from public.vista_reabastecimiento),
    'productos_no_disponibles', (select coalesce(jsonb_agg(jsonb_build_object('id', producto_id, 'nombre', nombre,
                    'faltantes', insumos_faltantes) order by nombre), '[]')
                    from public.vista_disponibilidad_productos where activo and not disponible),
    'productos_sin_receta', (select coalesce(jsonb_agg(nombre order by nombre), '[]')
                    from public.vista_disponibilidad_productos where activo and num_insumos = 0),
    'consumo_productos_mes', (select coalesce(jsonb_agg(x), '[]') from (
        select producto, unidades, costo_insumos from public.reporte_consumo_por_producto(v_mes, v_hoy) limit 5) x),
    'alertas_abiertas', (select count(*) from public.alertas where not resuelta),
    'acciones_pendientes', (select count(*) from public.agente_acciones where estado = 'pendiente')
  ) into r;
  return r;
end $$;

-- ---------- Agente: revisión automática del negocio ----------
-- Se ejecuta desde el panel (cada minuto) y, si está disponible, con pg_cron.
create or replace function public.agente_revisar()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_res jsonb; v_h jsonb := '[]'::jsonb; v_n int; v_lista text[]; x jsonb;
  v_lim_prep int := public.config_numero('minutos_atraso_preparacion', 20)::int;
  v_lim_sin int := public.config_numero('minutos_atraso_sin_atender', 10)::int;
  r record;
begin
  perform public.requiere_admin();

  -- 1) Automatizaciones: alertas al día
  perform public.revisar_pedidos_atrasados();
  for r in select id from public.insumos loop
    perform public._sincronizar_alertas_insumo(r.id);
  end loop;
  perform public._sincronizar_alertas_productos();
  perform public._sincronizar_alerta_reabastecimiento();

  -- 2) Propuestas automáticas (requieren autorización del administrador)
  insert into public.agente_acciones (tipo, descripcion, datos, origen)
  select 'cancelar_pedido',
         format('Cancelar el pedido #%s (%s): lleva %s minutos sin confirmarse.', v.id, v.cliente, v.minutos_en_estado),
         jsonb_build_object('pedido_id', v.id, 'motivo', 'Pedido sin confirmar por mucho tiempo'), 'automatico'
  from public.vista_pedidos_admin v
  where v.estado = 'nuevo'
    and v.minutos_en_estado >= public.config_numero('minutos_propuesta_cancelacion', 60)
    and not exists (select 1 from public.agente_acciones a
                    where a.tipo = 'cancelar_pedido' and a.datos ->> 'pedido_id' = v.id::text);

  -- 3) Hallazgos en lenguaje natural
  v_res := public.resumen_negocio();

  v_n := jsonb_array_length(v_res -> 'productos_no_disponibles');
  if v_n > 0 then
    select array_agg(e ->> 'nombre') into v_lista from jsonb_array_elements(v_res -> 'productos_no_disponibles') e;
    v_h := v_h || jsonb_build_object('nivel', 'alta', 'icono', '⛔',
      'mensaje', case when v_n = 1 then 'Se detectó 1 producto con inventario insuficiente: '
                      else format('Se detectaron %s productos con inventario insuficiente: ', v_n) end
                 || public.lista_texto(v_lista) || '.');
  end if;

  select count(*) into v_n from jsonb_array_elements(v_res -> 'atrasados') e where e ->> 'estado' = 'en_preparacion';
  if v_n > 0 then
    v_h := v_h || jsonb_build_object('nivel', 'alta', 'icono', '⏱️',
      'mensaje', case when v_n = 1 then format('Hay 1 pedido que lleva más de %s minutos en preparación.', v_lim_prep)
                      else format('Hay %s pedidos que llevan más de %s minutos en preparación.', v_n, v_lim_prep) end);
  end if;

  select count(*) into v_n from jsonb_array_elements(v_res -> 'atrasados') e where e ->> 'estado' in ('nuevo','confirmado');
  if v_n > 0 then
    v_h := v_h || jsonb_build_object('nivel', 'alta', 'icono', '⏱️',
      'mensaje', case when v_n = 1 then format('Hay 1 pedido que lleva más de %s minutos esperando ser atendido.', v_lim_sin)
                      else format('Hay %s pedidos que llevan más de %s minutos esperando ser atendidos.', v_n, v_lim_sin) end);
  end if;

  for x in select * from jsonb_array_elements(v_res -> 'inventario' -> 'agotados') loop
    v_h := v_h || jsonb_build_object('nivel', 'critica', 'icono', '🚨',
      'mensaje', format('%s está agotado.', x ->> 'nombre'));
  end loop;

  for x in select * from jsonb_array_elements(v_res -> 'inventario' -> 'bajos') loop
    v_h := v_h || jsonb_build_object('nivel', 'media', 'icono', '⚠️',
      'mensaje', format('%s tiene inventario bajo (%s; mínimo %s).', x ->> 'nombre', x ->> 'stock', x ->> 'minimo'));
  end loop;

  if jsonb_array_length(v_res -> 'reabastecer') > 0 then
    select array_agg(lower(e ->> 'nombre')) into v_lista from jsonb_array_elements(v_res -> 'reabastecer') e;
    v_h := v_h || jsonb_build_object('nivel', 'media', 'icono', '📦',
      'mensaje', 'Se recomienda reabastecer ' || public.lista_texto(v_lista) || '.');
  end if;

  v_n := coalesce((v_res -> 'pedidos_por_estado' ->> 'nuevo')::int, 0);
  if v_n > 0 then
    v_h := v_h || jsonb_build_object('nivel', 'info', 'icono', '🛎️',
      'mensaje', case when v_n = 1 then 'Hay 1 pedido nuevo esperando confirmación.'
                      else format('Hay %s pedidos nuevos esperando confirmación.', v_n) end);
  end if;

  if jsonb_array_length(v_res -> 'mas_vendidos_hoy') > 0 then
    v_h := v_h || jsonb_build_object('nivel', 'info', 'icono', '🏆',
      'mensaje', format('El producto más vendido de hoy es %s (%s unidades).',
                        v_res -> 'mas_vendidos_hoy' -> 0 ->> 'nombre', v_res -> 'mas_vendidos_hoy' -> 0 ->> 'unidades'));
  end if;

  v_h := v_h || jsonb_build_object('nivel', 'info', 'icono', '💰',
    'mensaje', format('Ventas de hoy: %s en %s pedido(s).',
                      public._dinero((v_res -> 'ventas_hoy' ->> 'total')::numeric), v_res -> 'ventas_hoy' ->> 'pedidos'));

  v_n := jsonb_array_length(v_res -> 'productos_sin_receta');
  if v_n > 0 then
    select array_agg(e #>> '{}') into v_lista from jsonb_array_elements(v_res -> 'productos_sin_receta') e;
    v_h := v_h || jsonb_build_object('nivel', 'media', 'icono', '📝',
      'mensaje', format('%s producto(s) sin receta: no descuentan inventario (%s).', v_n, public.lista_texto(v_lista)));
  end if;

  v_n := (v_res ->> 'acciones_pendientes')::int;
  if v_n > 0 then
    v_h := v_h || jsonb_build_object('nivel', 'media', 'icono', '🤖',
      'mensaje', format('Tienes %s acción(es) propuesta(s) por el agente esperando tu autorización.', v_n));
  end if;

  if not exists (select 1 from jsonb_array_elements(v_h) e where e ->> 'nivel' in ('alta','critica','media')) then
    v_h := jsonb_build_array(jsonb_build_object('nivel', 'ok', 'icono', '✅',
      'mensaje', 'Todo en orden: no hay pedidos atrasados ni problemas de inventario.')) || v_h;
  end if;

  return jsonb_build_object('hallazgos', v_h, 'resumen', v_res);
end $$;

-- El agente (o el administrador) propone una acción que requiere autorización
create or replace function public.proponer_accion_agente(p_tipo text, p_datos jsonb, p_descripcion text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform public.requiere_admin();
  if p_tipo in ('registrar_entrada','ajustar_stock_minimo')
     and not exists (select 1 from public.insumos where id = (p_datos ->> 'insumo_id')::bigint) then
    return jsonb_build_object('ok', false, 'mensaje', 'El insumo indicado no existe.');
  end if;
  if p_tipo in ('cambiar_estado_pedido','cancelar_pedido')
     and not exists (select 1 from public.pedidos where id = (p_datos ->> 'pedido_id')::bigint) then
    return jsonb_build_object('ok', false, 'mensaje', 'El pedido indicado no existe.');
  end if;
  if p_tipo in ('pausar_producto','reactivar_producto')
     and not exists (select 1 from public.productos where id = (p_datos ->> 'producto_id')::bigint) then
    return jsonb_build_object('ok', false, 'mensaje', 'El producto indicado no existe.');
  end if;
  insert into public.agente_acciones (tipo, descripcion, datos, origen)
  values (p_tipo, p_descripcion, coalesce(p_datos, '{}'::jsonb), 'chat')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- El administrador AUTORIZA o RECHAZA una acción propuesta
create or replace function public.resolver_accion_agente(p_accion_id bigint, p_aprobar boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.agente_acciones; d jsonb; res jsonb;
begin
  perform public.requiere_admin();
  select * into a from public.agente_acciones where id = p_accion_id for update;
  if not found or a.estado <> 'pendiente' then
    return jsonb_build_object('ok', false, 'mensaje', 'La acción no existe o ya fue resuelta.');
  end if;
  if not p_aprobar then
    update public.agente_acciones set estado = 'rechazada', resuelto_por = auth.uid(), resuelto_en = now(),
           resultado = 'Rechazada por el administrador' where id = a.id;
    return jsonb_build_object('ok', true, 'mensaje', 'Acción rechazada.');
  end if;

  d := a.datos;
  begin
    case a.tipo
      when 'registrar_entrada' then
        res := public.registrar_movimiento_inventario((d ->> 'insumo_id')::bigint, 'entrada', (d ->> 'cantidad')::numeric,
                 d ->> 'unidad', coalesce(d ->> 'motivo', 'Entrada autorizada desde el agente'),
                 nullif(d ->> 'costo_unitario', '')::numeric);
      when 'cambiar_estado_pedido' then
        res := public.cambiar_estado_pedido((d ->> 'pedido_id')::bigint, d ->> 'estado', 'Autorizado desde el agente');
      when 'cancelar_pedido' then
        res := public.cambiar_estado_pedido((d ->> 'pedido_id')::bigint, 'cancelado',
                 coalesce(d ->> 'motivo', 'Cancelado desde el agente'));
      when 'pausar_producto' then
        update public.productos set activo = false where id = (d ->> 'producto_id')::bigint;
        res := jsonb_build_object('ok', true, 'mensaje', 'Producto ocultado del menú.');
      when 'reactivar_producto' then
        update public.productos set activo = true where id = (d ->> 'producto_id')::bigint;
        res := jsonb_build_object('ok', true, 'mensaje', 'Producto visible en el menú.');
      when 'ajustar_stock_minimo' then
        update public.insumos set stock_minimo = (d ->> 'stock_minimo')::numeric where id = (d ->> 'insumo_id')::bigint;
        res := jsonb_build_object('ok', true, 'mensaje', 'Stock mínimo actualizado.');
    end case;
  exception when others then
    res := jsonb_build_object('ok', false, 'mensaje', sqlerrm);
  end;

  update public.agente_acciones
     set estado = case when coalesce((res ->> 'ok')::boolean, false) then 'aprobada' else 'error' end,
         resultado = res ->> 'mensaje', resuelto_por = auth.uid(), resuelto_en = now()
   where id = a.id;
  return res;
end $$;

-- Corte diario (historial de ventas por día). pg_cron lo genera cada noche.
create or replace function public.generar_corte_diario(p_fecha date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_fecha date := coalesce(p_fecha, public.hoy() - 1); v jsonb; v_top text; v_canc int;
begin
  perform public.requiere_admin();
  v := public._ventas_periodo(v_fecha, v_fecha);
  select nombre into v_top from public._productos_vendidos(v_fecha, v_fecha)
   where unidades > 0 order by unidades desc, ventas desc limit 1;
  select count(*) into v_canc from public.pedidos
   where estado = 'cancelado' and (creado_en at time zone public.tz())::date = v_fecha;
  insert into public.cortes_diarios (fecha, pedidos, ventas, efectivo, tarjeta, transferencia, ticket_promedio,
                                     cancelados, producto_mas_vendido, detalle, generado_en)
  values (v_fecha, (v ->> 'pedidos')::int, (v ->> 'total')::numeric, (v ->> 'efectivo')::numeric,
          (v ->> 'tarjeta')::numeric, (v ->> 'transferencia')::numeric, (v ->> 'ticket_promedio')::numeric,
          v_canc, v_top, v, now())
  on conflict (fecha) do update set pedidos = excluded.pedidos, ventas = excluded.ventas, efectivo = excluded.efectivo,
     tarjeta = excluded.tarjeta, transferencia = excluded.transferencia, ticket_promedio = excluded.ticket_promedio,
     cancelados = excluded.cancelados, producto_mas_vendido = excluded.producto_mas_vendido,
     detalle = excluded.detalle, generado_en = now();
  return jsonb_build_object('ok', true, 'fecha', v_fecha, 'ventas', v ->> 'total', 'pedidos', v ->> 'pedidos');
end $$;

-- =====================================================================
-- 12. DATOS INICIALES
--     (Se pueden ejecutar varias veces: no duplican ni sobrescriben tus cambios)
-- =====================================================================
insert into public.configuracion (clave, valor, descripcion, publica) values
  ('costo_envio', '20', 'Costo de envío por pedido (MXN).', true),
  ('zona_horaria', 'America/Mexico_City', 'Zona horaria del negocio para reportes y "ventas de hoy".', true),
  ('minutos_atraso_preparacion', '20', 'Minutos máximos EN PREPARACIÓN antes de marcar el pedido como atrasado.', false),
  ('minutos_atraso_sin_atender', '10', 'Minutos máximos como NUEVO o CONFIRMADO antes de marcarlo como atrasado.', false),
  ('confirmacion_automatica', 'false', 'true = los pedidos se confirman (y descuentan inventario) al crearse.', false),
  ('minutos_propuesta_cancelacion', '60', 'El agente propone cancelar pedidos nuevos sin confirmar después de estos minutos.', false)
on conflict (clave) do nothing;

insert into public.unidades_medida (codigo, nombre, tipo, factor_base) values
  ('g', 'gramos', 'masa', 1), ('kg', 'kilogramos', 'masa', 1000),
  ('ml', 'mililitros', 'volumen', 1), ('l', 'litros', 'volumen', 1000),
  ('pieza', 'piezas', 'conteo', 1), ('unidad', 'unidades', 'conteo', 1)
on conflict (codigo) do update set nombre = excluded.nombre, tipo = excluded.tipo, factor_base = excluded.factor_base;

insert into public.categorias (slug, nombre, icono, orden) values
  ('calientes', 'Cafés Calientes', '☕', 1), ('frias', 'Bebidas Frías', '🥤', 2),
  ('reposteria', 'Repostería', '🍰', 3), ('desayunos', 'Desayunos', '🍳', 4)
on conflict (slug) do nothing;

insert into public.metodos_pago (codigo, nombre, icono, orden) values
  ('efectivo', 'Efectivo', '💵', 1), ('tarjeta', 'Tarjeta', '💳', 2), ('transferencia', 'Transferencia', '📱', 3)
on conflict (codigo) do nothing;

insert into public.estados_pedido (codigo, nombre, orden, es_venta, es_final, color) values
  ('nuevo', 'Nuevo', 1, false, false, '#b86a16'),
  ('confirmado', 'Confirmado', 2, true, false, '#2f6f9f'),
  ('en_preparacion', 'En preparación', 3, true, false, '#8a5a2b'),
  ('listo', 'Listo', 4, true, false, '#287545'),
  ('entregado', 'Entregado', 5, true, true, '#4b5563'),
  ('cancelado', 'Cancelado', 9, false, true, '#a72f24')
on conflict (codigo) do update set nombre = excluded.nombre, orden = excluded.orden, es_venta = excluded.es_venta,
  es_final = excluded.es_final, color = excluded.color;

insert into public.cupones (codigo, descripcion, descuento, activo)
values ('AROMA10', '10% de descuento en tu próxima compra.', 10, true)
on conflict (codigo) do nothing;

-- ---------- Menú (mismos productos e imágenes de la V2) ----------
insert into public.productos (id, categoria_id, nombre, descripcion, precio, imagen, orden)
select x.id, c.id, x.nombre, x.descripcion, x.precio, x.imagen, x.id
from (values
 (1,'calientes','Latte Clásico','Espresso con leche vaporizada y un toque de espuma.',48,'https://images.unsplash.com/photo-1561047029-3000c68339ca?auto=format&fit=crop&w=800&q=85'),
 (2,'calientes','Cappuccino','Espresso con leche vaporizada y cacao en polvo.',46,'https://images.unsplash.com/photo-1572442388796-11668a67e53d?auto=format&fit=crop&w=800&q=85'),
 (3,'calientes','Espresso','Café intenso y aromático, preparado al estilo italiano.',36,'https://images.unsplash.com/photo-1510707577719-ae7c14805e3a?auto=format&fit=crop&w=800&q=85'),
 (4,'calientes','Mocha','Chocolate, espresso y leche vaporizada.',52,'https://images.unsplash.com/photo-1577968897966-3d4325b36b61?auto=format&fit=crop&w=800&q=85'),
 (5,'calientes','Americano','Espresso diluido en agua caliente para un sabor suave.',38,'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=800&q=85'),
 (6,'calientes','Caramel Macchiato','Leche vaporizada, espresso y un toque de caramelo.',54,'https://images.unsplash.com/photo-1485808191679-5f86510681a2?auto=format&fit=crop&w=800&q=85'),
 (7,'calientes','Latte Vainilla','Latte con esencia de vainilla, suave y reconfortante.',50,'https://images.unsplash.com/photo-1595434091143-b375ced5fe5c?auto=format&fit=crop&w=800&q=85'),
 (8,'calientes','Chocolate Caliente','Chocolate hecho con cacao de calidad y leche.',45,'https://images.unsplash.com/photo-1542990253-0b38b828a96f?auto=format&fit=crop&w=800&q=85'),
 (9,'frias','Iced Latte','Espresso, leche y hielo para una bebida refrescante.',55,'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=800&q=85'),
 (10,'frias','Cold Brew','Café de extracción lenta, suave y refrescante.',58,'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?auto=format&fit=crop&w=800&q=85'),
 (11,'frias','Frappé de Café','Café, hielo, leche y crema batida.',62,'https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&w=800&q=85'),
 (12,'frias','Limonada de Fresa','Fresas naturales, limón y hielo.',49,'https://images.unsplash.com/photo-1551024709-8f23befc6f87?auto=format&fit=crop&w=800&q=85'),
 (13,'reposteria','Cheesecake','Pastel cremoso de queso con frutos rojos.',58,'https://images.unsplash.com/photo-1565958011703-44f9829ba187?auto=format&fit=crop&w=800&q=85'),
 (14,'reposteria','Croissant','Clásico croissant de mantequilla, horneado al día.',39,'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=800&q=85'),
 (15,'reposteria','Brownie','Brownie de chocolate con textura suave por dentro.',44,'https://images.unsplash.com/photo-1519869325930-281384150729?auto=format&fit=crop&w=800&q=85'),
 (16,'reposteria','Pastel de Zanahoria','Bizcocho especiado con crema de queso.',52,'https://images.unsplash.com/photo-1599785209707-a456fc1337bb?auto=format&fit=crop&w=800&q=85'),
 (17,'desayunos','Chilaquiles','Totopos, salsa, crema, queso y huevo.',82,'https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?auto=format&fit=crop&w=800&q=85'),
 (18,'desayunos','Avocado Toast','Pan artesanal con aguacate, huevo y semillas.',78,'https://images.unsplash.com/photo-1525351484163-7529414344d8?auto=format&fit=crop&w=800&q=85'),
 (19,'desayunos','Hot Cakes','Hot cakes esponjosos con fruta y miel.',75,'https://images.unsplash.com/photo-1528207776546-365bb710ee93?auto=format&fit=crop&w=800&q=85'),
 (20,'desayunos','Molletes','Pan tostado con frijoles, queso gratinado y pico de gallo.',68,'https://images.unsplash.com/photo-1559847844-5315695dadae?auto=format&fit=crop&w=800&q=85')
) as x(id, categoria, nombre, descripcion, precio, imagen)
join public.categorias c on c.slug = x.categoria
where not exists (select 1 from public.productos p where p.id = x.id or lower(p.nombre) = lower(x.nombre));

select setval(pg_get_serial_sequence('public.productos', 'id'), greatest((select max(id) from public.productos), 1));

-- ---------- Insumos iniciales ----------
-- Unidades base recomendadas: g (sólidos), ml (líquidos), pieza (conteo).
-- costo_unitario = costo por 1 g / 1 ml / 1 pieza.
-- El stock inicial se registra como movimiento "inicial": AJÚSTALO a tu conteo real
-- desde el panel (Inventario > Conteo físico).
do $$
declare r record; v_id bigint;
begin
  for r in select * from (values
    ('Café en grano',       'g',     5000, 1500, 10000, 0.18),
    ('Leche',               'ml',   20000, 5000, 40000, 0.028),
    ('Agua purificada',     'ml',   60000, 10000, 100000, 0.002),
    ('Azúcar',              'g',     5000, 1000, 10000, 0.024),
    ('Chocolate en polvo',  'g',     3000,  800,  6000, 0.11),
    ('Jarabe de caramelo',  'ml',    2000,  500,  4000, 0.095),
    ('Jarabe de vainilla',  'ml',    1500,  400,  3000, 0.12),
    ('Hielo',               'g',    20000, 5000, 40000, 0.012),
    ('Crema batida',        'ml',    2000,  500,  4000, 0.09),
    ('Fresa',               'g',     4000, 1000,  8000, 0.075),
    ('Limón',               'pieza',   60,   15,   120, 2.0),
    ('Harina',              'g',    10000, 3000, 20000, 0.022),
    ('Mantequilla',         'g',     3000,  800,  6000, 0.15),
    ('Huevo',               'pieza',   90,   24,   180, 3.5),
    ('Queso crema',         'g',     4000, 1000,  8000, 0.12),
    ('Frutos rojos',        'g',     2000,  500,  4000, 0.2),
    ('Zanahoria',           'g',     3000,  800,  6000, 0.02),
    ('Totopos',             'g',     3000,  800,  6000, 0.06),
    ('Salsa verde',         'ml',    3000,  800,  6000, 0.04),
    ('Crema',               'ml',    2000,  500,  4000, 0.06),
    ('Queso',               'g',     4000, 1000,  8000, 0.13),
    ('Pan artesanal',       'pieza',   40,   10,    80, 8),
    ('Aguacate',            'pieza',   20,    6,    40, 12),
    ('Semillas',            'g',     1000,  200,  2000, 0.15),
    ('Miel',                'ml',    1500,  400,  3000, 0.1),
    ('Fruta de temporada',  'g',     3000,  800,  6000, 0.04),
    ('Frijoles refritos',   'g',     4000, 1000,  8000, 0.035),
    ('Pico de gallo',       'g',     2000,  500,  4000, 0.05)
  ) as t(nombre, unidad, stock, minimo, maximo, costo)
  loop
    if not exists (select 1 from public.insumos where lower(nombre) = lower(r.nombre)) then
      insert into public.insumos (nombre, unidad, stock, stock_minimo, stock_maximo, costo_unitario)
      values (r.nombre, r.unidad, 0, r.minimo, r.maximo, r.costo)
      returning id into v_id;
      insert into public.movimientos_inventario (insumo_id, tipo, cantidad, costo_unitario, motivo, usuario_id)
      values (v_id, 'inicial', r.stock, r.costo, 'Inventario inicial (ajústalo a tu conteo real)', null);
    end if;
  end loop;
end $$;

-- ---------- Recetas: Producto → Insumo → Cantidad (por 1 unidad vendida) ----------
insert into public.recetas (producto_id, insumo_id, cantidad)
select p.id, i.id, x.cantidad
from (values
  ('Latte Clásico','Café en grano',18), ('Latte Clásico','Leche',220), ('Latte Clásico','Azúcar',10),
  ('Cappuccino','Café en grano',20), ('Cappuccino','Leche',200), ('Cappuccino','Azúcar',10), ('Cappuccino','Chocolate en polvo',3),
  ('Espresso','Café en grano',18), ('Espresso','Agua purificada',60), ('Espresso','Azúcar',5),
  ('Mocha','Café en grano',18), ('Mocha','Leche',200), ('Mocha','Chocolate en polvo',25),
  ('Americano','Café en grano',20), ('Americano','Agua purificada',250), ('Americano','Azúcar',10),
  ('Caramel Macchiato','Café en grano',18), ('Caramel Macchiato','Leche',200), ('Caramel Macchiato','Jarabe de caramelo',20),
  ('Latte Vainilla','Café en grano',18), ('Latte Vainilla','Leche',220), ('Latte Vainilla','Jarabe de vainilla',15),
  ('Chocolate Caliente','Leche',250), ('Chocolate Caliente','Chocolate en polvo',35), ('Chocolate Caliente','Azúcar',10),
  ('Iced Latte','Café en grano',18), ('Iced Latte','Leche',180), ('Iced Latte','Hielo',150),
  ('Cold Brew','Café en grano',25), ('Cold Brew','Agua purificada',300), ('Cold Brew','Hielo',150),
  ('Frappé de Café','Café en grano',18), ('Frappé de Café','Leche',150), ('Frappé de Café','Hielo',200),
  ('Frappé de Café','Crema batida',30), ('Frappé de Café','Azúcar',15),
  ('Limonada de Fresa','Fresa',100), ('Limonada de Fresa','Limón',2), ('Limonada de Fresa','Azúcar',20),
  ('Limonada de Fresa','Agua purificada',300), ('Limonada de Fresa','Hielo',150),
  ('Cheesecake','Queso crema',80), ('Cheesecake','Harina',20), ('Cheesecake','Mantequilla',15),
  ('Cheesecake','Azúcar',25), ('Cheesecake','Huevo',0.5), ('Cheesecake','Frutos rojos',30),
  ('Croissant','Harina',60), ('Croissant','Mantequilla',30),
  ('Brownie','Harina',40), ('Brownie','Chocolate en polvo',30), ('Brownie','Mantequilla',20),
  ('Brownie','Azúcar',30), ('Brownie','Huevo',0.5),
  ('Pastel de Zanahoria','Harina',50), ('Pastel de Zanahoria','Zanahoria',60), ('Pastel de Zanahoria','Azúcar',30),
  ('Pastel de Zanahoria','Huevo',0.5), ('Pastel de Zanahoria','Queso crema',30),
  ('Chilaquiles','Totopos',120), ('Chilaquiles','Salsa verde',150), ('Chilaquiles','Crema',30),
  ('Chilaquiles','Queso',40), ('Chilaquiles','Huevo',2),
  ('Avocado Toast','Pan artesanal',2), ('Avocado Toast','Aguacate',0.5), ('Avocado Toast','Huevo',1), ('Avocado Toast','Semillas',5),
  ('Hot Cakes','Harina',120), ('Hot Cakes','Huevo',1), ('Hot Cakes','Leche',150), ('Hot Cakes','Mantequilla',15),
  ('Hot Cakes','Miel',30), ('Hot Cakes','Fruta de temporada',80),
  ('Molletes','Pan artesanal',2), ('Molletes','Frijoles refritos',100), ('Molletes','Queso',50), ('Molletes','Pico de gallo',40)
) as x(producto, insumo, cantidad)
join public.productos p on lower(p.nombre) = lower(x.producto)
join public.insumos i on lower(i.nombre) = lower(x.insumo)
on conflict (producto_id, insumo_id) do nothing;

-- =====================================================================
-- 13. SEGURIDAD: RLS (Row Level Security) Y PERMISOS
-- =====================================================================
alter table public.configuracion            enable row level security;
alter table public.unidades_medida          enable row level security;
alter table public.categorias               enable row level security;
alter table public.metodos_pago             enable row level security;
alter table public.estados_pedido           enable row level security;
alter table public.perfiles                 enable row level security;
alter table public.productos                enable row level security;
alter table public.proveedores              enable row level security;
alter table public.insumos                  enable row level security;
alter table public.recetas                  enable row level security;
alter table public.clientes                 enable row level security;
alter table public.pedidos                  enable row level security;
alter table public.detalle_pedidos          enable row level security;
alter table public.historial_estados_pedido enable row level security;
alter table public.movimientos_inventario   enable row level security;
alter table public.alertas                  enable row level security;
alter table public.agente_mensajes          enable row level security;
alter table public.agente_acciones          enable row level security;
alter table public.cortes_diarios           enable row level security;
alter table public.favoritos                enable row level security;
alter table public.puntos_cliente           enable row level security;
alter table public.movimientos_puntos       enable row level security;
alter table public.cupones                  enable row level security;
alter table public.notificaciones           enable row level security;
alter table public.resenas                  enable row level security;
alter table public.mensajes_contacto        enable row level security;

-- Borra políticas anteriores de estas tablas para poder re-ejecutar el script
do $$ declare r record; begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public' and tablename in (
             'configuracion','unidades_medida','categorias','metodos_pago','estados_pedido','perfiles','productos',
             'proveedores','insumos','recetas','clientes','pedidos','detalle_pedidos','historial_estados_pedido',
             'movimientos_inventario','alertas','agente_mensajes','agente_acciones','cortes_diarios','favoritos',
             'puntos_cliente','movimientos_puntos','cupones','notificaciones','resenas','mensajes_contacto')
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- Catálogos públicos (lectura) — solo el administrador modifica
create policy config_lectura on public.configuracion for select to anon, authenticated using (publica or public.es_admin());
create policy config_admin on public.configuracion for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy unidades_lectura on public.unidades_medida for select to authenticated using (true);
create policy unidades_admin on public.unidades_medida for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy categorias_lectura on public.categorias for select to anon, authenticated using (activo or public.es_admin());
create policy categorias_admin on public.categorias for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy metodos_lectura on public.metodos_pago for select to anon, authenticated using (activo or public.es_admin());
create policy metodos_admin on public.metodos_pago for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy estados_lectura on public.estados_pedido for select to anon, authenticated using (true);
create policy productos_lectura on public.productos for select to anon, authenticated using (activo or public.es_admin());
create policy productos_admin on public.productos for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy cupones_lectura on public.cupones for select to anon, authenticated using ((activo and (expira_en is null or expira_en > now())) or public.es_admin());
create policy cupones_admin on public.cupones for all to authenticated using (public.es_admin()) with check (public.es_admin());

-- Perfiles: cada quien ve y edita el suyo (el rol está protegido por trigger)
create policy perfil_select on public.perfiles for select to authenticated using (user_id = auth.uid() or public.es_admin());
create policy perfil_insert on public.perfiles for insert to authenticated with check (user_id = auth.uid() or public.es_admin());
create policy perfil_update on public.perfiles for update to authenticated
  using (user_id = auth.uid() or public.es_admin()) with check (user_id = auth.uid() or public.es_admin());

-- Información interna: SOLO administrador
create policy proveedores_admin on public.proveedores for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy insumos_admin on public.insumos for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy recetas_admin on public.recetas for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy movimientos_admin_select on public.movimientos_inventario for select to authenticated using (public.es_admin());
create policy movimientos_admin_insert on public.movimientos_inventario for insert to authenticated
  with check (public.es_admin() and tipo in ('entrada','merma','ajuste'));
create policy alertas_admin_select on public.alertas for select to authenticated using (public.es_admin());
create policy alertas_admin_update on public.alertas for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy agente_mensajes_admin on public.agente_mensajes for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy agente_acciones_admin on public.agente_acciones for select to authenticated using (public.es_admin());
create policy cortes_admin on public.cortes_diarios for select to authenticated using (public.es_admin());

-- Clientes y pedidos: el cliente ve solo lo suyo; los pedidos se crean con crear_pedido()
create policy clientes_select on public.clientes for select to authenticated using (user_id = auth.uid() or public.es_admin());
create policy clientes_admin on public.clientes for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy pedidos_select on public.pedidos for select to authenticated using (user_id = auth.uid() or public.es_admin());
create policy pedidos_admin_update on public.pedidos for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy detalles_select on public.detalle_pedidos for select to authenticated
  using (exists (select 1 from public.pedidos p where p.id = pedido_id and (p.user_id = auth.uid() or public.es_admin())));
create policy historial_select on public.historial_estados_pedido for select to authenticated
  using (exists (select 1 from public.pedidos p where p.id = pedido_id and (p.user_id = auth.uid() or public.es_admin())));

-- Funciones V2 del cliente
create policy fav_select on public.favoritos for select to authenticated using (user_id = auth.uid() or public.es_admin());
create policy fav_insert on public.favoritos for insert to authenticated with check (user_id = auth.uid());
create policy fav_delete on public.favoritos for delete to authenticated using (user_id = auth.uid());
create policy puntos_select on public.puntos_cliente for select to authenticated using (user_id = auth.uid() or public.es_admin());
create policy mov_puntos_select on public.movimientos_puntos for select to authenticated using (user_id = auth.uid() or public.es_admin());
create policy notif_select on public.notificaciones for select to authenticated using (user_id = auth.uid() or public.es_admin());
create policy notif_update on public.notificaciones for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy resenas_all on public.resenas for all to authenticated
  using (user_id = auth.uid() or public.es_admin()) with check (user_id = auth.uid() or public.es_admin());
create policy contacto_insert on public.mensajes_contacto for insert to anon, authenticated with check (not leido);
create policy contacto_admin on public.mensajes_contacto for select to authenticated using (public.es_admin());
create policy contacto_admin_update on public.mensajes_contacto for update to authenticated using (public.es_admin()) with check (public.es_admin());

-- ---------- Permisos a nivel tabla/columna (defensa adicional al RLS) ----------
-- Visitantes sin sesión (anon): solo lo mínimo para ver el menú y escribir mensajes.
revoke all on all tables in schema public from anon;
grant select on public.categorias, public.productos, public.metodos_pago, public.estados_pedido,
                public.configuracion, public.cupones to anon;
grant insert on public.mensajes_contacto to anon;

-- El stock SOLO cambia mediante movimientos de inventario (nadie lo edita directamente)
revoke insert, update on public.insumos from authenticated;
grant insert (nombre, unidad, stock_minimo, stock_maximo, costo_unitario, proveedor_id, activo) on public.insumos to authenticated;
grant update (nombre, unidad, stock_minimo, stock_maximo, costo_unitario, proveedor_id, activo) on public.insumos to authenticated;

-- Historiales: no se editan ni se borran desde la API
revoke update, delete, truncate on public.movimientos_inventario, public.historial_estados_pedido,
       public.agente_mensajes, public.cortes_diarios from authenticated;
revoke insert, delete, truncate on public.pedidos, public.detalle_pedidos, public.clientes from authenticated;
revoke insert, update, delete, truncate on public.agente_acciones from authenticated;

-- ---------- Permisos de funciones ----------
-- Funciones internas (prefijo "_") y de triggers: nadie las llama desde la API
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like '\_%' or p.proname like 'tg\_%'
                 or p.proname in ('crear_perfil_nuevo','requiere_admin'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- Funciones administrativas: requieren sesión (y además validan rol admin por dentro)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'cambiar_estado_pedido','revisar_pedidos_atrasados','registrar_movimiento_inventario',
             'ajustar_inventario_conteo','crear_insumo','guardar_receta','resolver_alerta','reporte_ventas',
             'reporte_consumo_insumos','reporte_consumo_por_producto','resumen_negocio','agente_revisar',
             'proponer_accion_agente','resolver_accion_agente','generar_corte_diario','config_texto','config_numero')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

-- Funciones públicas del sitio del cliente
grant execute on function public.obtener_menu() to anon, authenticated;
grant execute on function public.verificar_carrito(jsonb) to anon, authenticated;
grant execute on function public.crear_pedido(text, text, text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.consultar_pedido(text) to anon, authenticated;
grant execute on function public.cancelar_mi_pedido(text) to anon, authenticated;
grant execute on function public.es_admin() to anon, authenticated;

-- Las vistas administrativas solo para usuarios con sesión (y el RLS filtra al administrador)
grant select on public.vista_stock_comprometido, public.vista_disponibilidad_productos, public.vista_inventario,
  public.vista_reabastecimiento, public.vista_pedidos_admin, public.vista_pedidos_atrasados, public.vista_ventas_diarias,
  public.vista_productos_mas_vendidos, public.vista_ventas_metodo, public.vista_movimientos_inventario,
  public.vista_entradas_inventario, public.vista_salidas_inventario, public.vista_costo_productos to authenticated;

-- =====================================================================
-- 14. TIEMPO REAL (Supabase Realtime)
-- =====================================================================
do $$ declare t text; begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['pedidos','alertas','insumos','movimientos_inventario','agente_acciones','notificaciones'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  else
    raise notice 'No existe la publicación supabase_realtime (¿no es Supabase?). El panel funcionará con actualización periódica.';
  end if;
end $$;

-- =====================================================================
-- 15. TAREAS PROGRAMADAS (pg_cron) — opcional
--     Revisa pedidos atrasados cada minuto y genera el corte diario.
--     Si pg_cron no está disponible, el panel del administrador hace la
--     revisión automáticamente mientras está abierto.
-- =====================================================================
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron no está disponible: %. Puedes activarlo en Supabase > Integrations > Cron y volver a ejecutar esta sección.', sqlerrm;
    return;
  end;
  perform cron.unschedule(jobid) from cron.job where jobname in ('cafe_aroma_revision', 'cafe_aroma_corte_diario');
  perform cron.schedule('cafe_aroma_revision', '* * * * *', 'select public.agente_revisar()');
  -- 06:10 UTC = 00:10 en Ciudad de México
  perform cron.schedule('cafe_aroma_corte_diario', '10 6 * * *', 'select public.generar_corte_diario()');
exception when others then
  raise notice 'No se pudieron programar las tareas de pg_cron: %', sqlerrm;
end $$;

-- Revisión inicial de alertas
do $$ declare r record; begin
  for r in select id from public.insumos loop perform public._sincronizar_alertas_insumo(r.id); end loop;
  perform public._sincronizar_alertas_productos();
  perform public._sincronizar_alerta_reabastecimiento();
end $$;

select 'Café Aroma V3 instalado correctamente ✅  Siguiente paso: crea tu usuario administrador (README, Paso 7).' as resultado;
