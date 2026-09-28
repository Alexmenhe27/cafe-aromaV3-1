# ☕ Café Aroma V3 — Sistema web inteligente para cafetería (Supabase)

Esta versión continúa el proyecto **Café Aroma V2**: conserva el diseño, el sitio del cliente, la cuenta con favoritos/puntos/cupones/avisos y el panel del administrador, y los convierte en un **sistema real de administración**:

- El **menú** se relaciona con los **insumos** mediante **recetas** (Producto → Insumo → Cantidad).
- Al **confirmar** un pedido, el inventario se **descuenta automáticamente**, **una sola vez**.
- Si un pedido ya descontado se **cancela**, los insumos **se devuelven** automáticamente.
- Un producto se **bloquea solo** cuando sus insumos no alcanzan (disponibilidad calculada, no manual).
- **Alertas automáticas**: inventario bajo, insumo agotado, producto no disponible, reabastecimiento, pedido atrasado.
- **Dashboard profesional** con pedidos por estado, ventas (día/semana/mes, efectivo/tarjeta), inventario y actividad **en tiempo real**.
- **Reportes** con datos reales y exportación a CSV.
- **Agente inteligente** que responde con datos reales de Supabase, detecta problemas solo y propone acciones que **tú autorizas**.

> No se usa ningún servicio además de Supabase. No necesitas instalar Node, XAMPP ni MySQL: son archivos HTML/CSS/JS que se pueden publicar en GitHub Pages.

---

## 📁 Estructura del proyecto

```
cafe-aroma/
├── index.html                 Sitio del cliente (menú, carrito, pedido, seguimiento, cuenta)
├── admin.html                 Panel del administrador
├── config.js                  ⚙️ URL y anon key de Supabase (lo editas tú)
├── css/
│   ├── estilos.css            Estilos del sitio (identidad visual V2 + nuevos componentes)
│   └── admin.css              Estilos del panel
├── js/
│   ├── comun.js               Conexión a Supabase y utilidades compartidas
│   ├── app.js                 Lógica del sitio del cliente
│   ├── admin.js               Lógica del panel administrativo
│   └── agente.js              🤖 Agente inteligente (modo básico, sin IA externa)
├── supabase/
│   ├── 01_cafe_aroma_v3.sql   ⭐ Base de datos COMPLETA (tablas, vistas, funciones, triggers, RLS, datos)
│   ├── 00_respaldo_v2.sql     Solo si ya tenías la V2 con datos: respalda sin borrar nada
│   └── 02_migrar_datos_v2.sql Solo si ya tenías la V2: copia tus datos a la V3
├── README.md                  Este archivo
├── CAMBIOS_V3.md              Qué cambió respecto a la V2
├── VERIFICACION.md            Pruebas realizadas y resultados
└── Documentacion_tecnica_23221124.pdf   Documentación original (V1/V2)
```

---

## Paso 1 — Crear / configurar el proyecto de Supabase

1. Entra a <https://supabase.com> e inicia sesión.
2. Clic en **New project**. Elige un nombre (ej. `cafe-aroma`), una contraseña para la base de datos (guárdala) y la región más cercana.
3. Espera a que el proyecto termine de crearse (1–2 minutos).
4. (Recomendado para pruebas) Ve a **Authentication → Sign In / Providers → Email** y desactiva **Confirm email**. Así los clientes pueden entrar justo después de registrarse. En producción puedes volver a activarlo.
5. Ve a **Authentication → URL Configuration** y en **Site URL** pon la dirección donde publicarás el sitio (ej. `https://tu-usuario.github.io/cafe-aroma/`). Para pruebas locales puedes dejar `http://localhost:5500`.

> 💡 Si ya tienes el proyecto de la V2, puedes usar el mismo proyecto (ver Paso 2B) o crear uno nuevo y limpio (recomendado si no tienes datos reales).

---

## Paso 2 — Ejecutar el SQL

### 2A. Proyecto nuevo o vacío (lo más común)

1. En Supabase abre **SQL Editor → New query**.
2. Abre el archivo `supabase/01_cafe_aroma_v3.sql`, **copia TODO** su contenido y pégalo.
3. Presiona **Run**.
4. Al final debe aparecer: `Café Aroma V3 instalado correctamente ✅`.

Esto crea todo: 26 tablas, 13 vistas, las funciones, los triggers, las políticas de seguridad (RLS), el menú (20 productos), 28 insumos con inventario inicial y **78 relaciones producto-insumo (recetas)**.

> El script se puede ejecutar varias veces sin duplicar datos ni borrar lo que ya editaste.

### 2B. Si tu proyecto ya tiene la base de datos V2 con datos

El script `01` detecta la V2 y se detiene para proteger tus datos. Ejecuta, en este orden y seguidos:

1. `supabase/00_respaldo_v2.sql` → mueve tus tablas V2 al esquema `respaldo_v2` (**no borra nada**).
2. `supabase/01_cafe_aroma_v3.sql` → crea la estructura nueva.
3. `supabase/02_migrar_datos_v2.sql` → copia perfiles/roles, productos (con tus precios), clientes, pedidos, favoritos, puntos, cupones, avisos, reseñas, mensajes y el stock de insumos (convierte kg → g y L → ml).

Notas de la migración:
- Estados: `pendiente → nuevo`, `preparando → en_preparacion`.
- La V2 descontaba inventario al crear el pedido, por eso los pedidos migrados quedan marcados como “inventario ya descontado” (no se descuentan dos veces).
- Las recetas de la V2 eran de demostración; se usan las nuevas (en g/ml/piezas). Revísalas en el panel.
- Tus datos originales siguen en el esquema `respaldo_v2` por si los necesitas.

---

## Paso 3 — Configurar las variables necesarias

### 3.1 `config.js` (conexión del sitio con Supabase)

En Supabase ve a **Project Settings → API** (o **Data API / API Keys**) y copia:
- **Project URL** (ej. `https://abcd1234.supabase.co`)
- **anon public** key (o **publishable key**)

Abre `config.js` y pégalas:

```js
window.CAFE_AROMA_CONFIG = {
  url: "https://abcd1234.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6..."
};
```

🔒 **Seguridad:** la anon/publishable key está hecha para usarse en el navegador; solo permite lo que autorizan las políticas RLS. **Nunca** pongas la `service_role` / secret key en ningún archivo del proyecto. Este proyecto no la necesita.

### 3.2 Configuración del negocio (sin programar)

Se edita desde el panel: **Configuración**. Se guarda en la tabla `configuracion`:

| Clave | Para qué sirve | Valor inicial |
|---|---|---|
| `minutos_atraso_preparacion` | Minutos en “En preparación” para marcar un pedido como atrasado | 20 |
| `minutos_atraso_sin_atender` | Minutos en “Nuevo” o “Confirmado” para marcarlo atrasado | 10 |
| `minutos_propuesta_cancelacion` | El agente propone cancelar pedidos nuevos no confirmados después de… | 60 |
| `costo_envio` | Costo de envío por pedido | 20 |
| `confirmacion_automatica` | `true` = el pedido se confirma y descuenta inventario al recibirse | false |
| `zona_horaria` | Para “ventas de hoy” y reportes | America/Mexico_City |

---

## Paso 4 — Conectar el proyecto con Supabase

1. Guarda `config.js` con tus datos (Paso 3.1).
2. Abre el sitio (Paso 6). Si todo está bien, el menú aparece con sus 4 categorías. Si ves el aviso “⚙️ El sitio aún no está conectado a Supabase”, revisa `config.js`.
3. **Tiempo real:** el SQL ya agrega las tablas `pedidos`, `alertas`, `insumos`, `movimientos_inventario`, `agente_acciones` y `notificaciones` a Supabase Realtime. Puedes comprobarlo en **Database → Publications → supabase_realtime**. En el panel verás “● En vivo” en la esquina inferior izquierda.
4. **Tareas programadas (opcional pero recomendado):** el SQL intenta activar `pg_cron` para revisar pedidos atrasados cada minuto y generar el corte diario a medianoche. Si en el resultado del SQL viste el aviso “pg_cron no está disponible”, ve a **Integrations → Cron**, actívalo y vuelve a ejecutar `01_cafe_aroma_v3.sql` (es seguro). Sin pg_cron todo funciona igual mientras el panel esté abierto (el panel hace la revisión cada minuto).

---

## Paso 5 — Configurar el agente

El agente **no necesita claves de IA ni pagos**: funciona en “modo básico” y siempre responde con **datos reales** de Supabase.

**Cómo funciona**
- `js/agente.js` reconoce la intención de tu pregunta (palabras clave en español) y llama a funciones seguras de la base de datos: `resumen_negocio()`, `reporte_ventas()`, `reporte_consumo_insumos()`, `reporte_consumo_por_producto()` y las vistas de inventario/pedidos.
- Si no entiende la pregunta, **lo dice** y sugiere preguntas; **nunca inventa** cifras.
- Cada conversación se guarda en la tabla `agente_mensajes`.

**Preguntas que responde** (ejemplos)
- ¿Cuántos pedidos tenemos pendientes? · ¿Cuántos están en preparación? · ¿Hay pedidos atrasados?
- ¿Cuánto hemos vendido hoy / esta semana / este mes / ayer / los últimos 7 días?
- ¿Cuánto corresponde a efectivo? ¿Y a tarjeta?
- ¿Qué productos se venden más / menos?
- ¿Qué insumos están bajos / agotados? ¿Qué insumos necesitamos comprar?
- ¿Qué productos ya no pueden venderse? ¿Qué productos consumen más inventario?
- ¿Cuánta leche queda? · ¿Cómo va el pedido 12? · Resumen del negocio

**Acciones con autorización** (el agente las prepara; tú decides)
- “Registra entrada de 5 litros de leche” / “Compré 2 kg de café en grano”
- “Marca el pedido 12 como listo” / “Cancela el pedido 12”
- “Pausa el Mocha” / “Reactiva el Mocha”
- “Cambia el mínimo de leche a 6 litros”

Aparecen con botones **Autorizar / Rechazar** y quedan registradas en la tabla `agente_acciones` (quién, cuándo y el resultado). Nada se ejecuta sin tu clic.

**Automatización**
Cada minuto (pg_cron o panel abierto) la función `agente_revisar()`:
- detecta pedidos atrasados y crea alertas,
- revisa inventario y disponibilidad de productos,
- propone cancelar pedidos que llevan demasiado tiempo sin confirmar,
- genera hallazgos como: *“Se detectaron 4 productos con inventario insuficiente”*, *“Hay 3 pedidos que llevan más de 20 minutos en preparación”*, *“Leche tiene inventario bajo”*, *“El producto más vendido de hoy es Americano”*, *“Se recomienda reabastecer café en grano”*.

Los hallazgos se ven en el **Dashboard** y en la sección **Agente**.

---

## Paso 6 — Ejecutar la página

**Opción A: en tu computadora (servidor local)**

```bash
# dentro de la carpeta cafe-aroma
python -m http.server 5500
```
Abre <http://localhost:5500> (cliente) y <http://localhost:5500/admin.html> (administrador).
También puedes usar la extensión **Live Server** de VS Code (clic derecho en `index.html` → *Open with Live Server*).

> No abras el archivo con doble clic (`file://`): algunos navegadores bloquean las peticiones. Usa siempre un servidor local o publícalo.

**Opción B: publicar con GitHub Pages**
1. Crea un repositorio y sube **todos** los archivos (incluidas las carpetas `css/`, `js/` y `supabase/`).
2. **Settings → Pages → Build and deployment**: Source *Deploy from a branch*, Branch `main`, carpeta `/ (root)`.
3. Guarda. Tu sitio quedará en `https://tu-usuario.github.io/tu-repo/`. Agrega esa URL en Supabase (Paso 1.5).

---

## Paso 7 — Acceder al administrador

1. En Supabase: **Authentication → Users → Add user → Create new user**. Escribe el correo y la contraseña del dueño y marca **Auto Confirm User**.
2. Copia el **UUID** del usuario creado.
3. En **SQL Editor** ejecuta (cambia el UUID):

```sql
update public.perfiles set rol = 'admin', nombre = 'Alejandro Mendoza Hernandez'
where user_id = '267a87cd-e829-4373-823a-acb185f58a2a';
```

4. Abre `admin.html` e inicia sesión con ese correo y contraseña.

> 🔒 Un cliente **no puede** darse el rol de administrador: un trigger (`tg_proteger_rol`) lo impide aunque intente modificar su perfil desde el navegador. Solo se puede hacer desde el SQL Editor o por otro administrador.

---

## Paso 8 — Agregar nuevos productos al menú

Desde el panel: **Menú y recetas → + Nuevo producto**
1. Escribe nombre, categoría, precio, descripción, URL de la imagen y orden.
2. Al guardar se abre la **receta** para indicar sus insumos (Paso 10).
3. “Visible” decide si aparece en el menú. La **disponibilidad** (agotado o no) la calcula el sistema con el inventario.

Para crear o renombrar categorías usa el botón **Categorías**.

> ⚠️ Un producto sin receta **no descuenta inventario** y nunca se marca como agotado. El agente te avisa si hay productos sin receta.

---

## Paso 9 — Agregar nuevos insumos

Desde el panel: **Inventario → + Nuevo insumo**
- **Nombre**, **unidad de medida** (gramos, kilogramos, mililitros, litros, piezas, unidades), **stock inicial**, **mínimo** (genera la alerta), **máximo** (para calcular cuánto comprar), **costo por unidad** y **proveedor** (opcional; se registran en la pestaña *Proveedores*).

Recomendación: usa **gramos** para sólidos, **mililitros** para líquidos y **piezas** para lo que se cuenta. Al registrar compras puedes capturar en kg o litros y el sistema convierte solo (2 kg → 2000 g).

**Cómo cambia el stock** (siempre queda historial en `movimientos_inventario`):

| Botón | Qué hace |
|---|---|
| **+ Entrada** | Registra una compra (suma). Opcional: costo y proveedor. |
| **Merma** | Desperdicio, derrame, caducado (resta). |
| **Conteo** | Escribes lo que hay físicamente y se registra un ajuste por la diferencia. |
| Ventas | Automático al confirmar pedidos. |
| Devoluciones | Automático al cancelar un pedido ya descontado. |

> El stock **no se puede editar a mano** en la tabla: así siempre se cumple que *stock = suma de movimientos*, sin inconsistencias.

---

## Paso 10 — Relacionar un producto con sus insumos (receta)

Desde el panel: **Menú y recetas → Receta** (en la tarjeta del producto).
1. Agrega una fila por insumo: **insumo**, **cantidad** y **unidad** (por **1 unidad vendida**).
2. El panel muestra el **costo estimado** y el **margen**.
3. **Guardar receta**.

Ejemplo (ya incluido en los datos iniciales):

| Producto | Insumo | Cantidad |
|---|---|---|
| Americano | Café en grano | 20 g |
| Americano | Agua purificada | 250 ml |
| Americano | Azúcar | 10 g |
| Cappuccino | Café en grano | 20 g |
| Cappuccino | Leche | 200 ml |
| Cappuccino | Azúcar | 10 g |

También se puede hacer con SQL:

```sql
insert into public.recetas (producto_id, insumo_id, cantidad)
select p.id, i.id, 20
from public.productos p, public.insumos i
where p.nombre = 'Americano' and i.nombre = 'Café en grano'
on conflict (producto_id, insumo_id) do update set cantidad = excluded.cantidad;
```

---

## Paso 11 — Cómo funciona el descuento automático del inventario

```
Cliente hace el pedido ─► se verifica que alcancen los insumos ─► Pedido NUEVO
   (los insumos quedan "apartados": otros clientes no pueden comprar lo mismo)
            │
Administrador CONFIRMA ─► ✅ se descuentan los insumos (una sola vez)
            │                 5 Americanos = 100 g café, 1250 ml agua, 50 g azúcar
            ▼
EN PREPARACIÓN ─► LISTO ─► ENTREGADO   (avanzar NO vuelve a descontar)

Cancelado siendo NUEVO                 → no se descontó nada, no hay que devolver
Cancelado después de CONFIRMADO        → ↩️ se devuelve exactamente lo descontado
```

**Por qué no hay descuentos duplicados** (triple protección):
1. El pedido tiene la bandera `inventario_descontado`; el trigger solo descuenta si está en `false` (y nadie puede cambiarla a mano).
2. Un índice único en `movimientos_inventario (pedido_id, insumo_id)` para ventas impide físicamente un segundo descuento.
3. El cambio de estado bloquea la fila del pedido (`FOR UPDATE`): dos administradores confirmando al mismo tiempo producen **un solo** descuento.

Además, los pedidos solo avanzan (no pueden regresar de estado), un pedido entregado o cancelado ya no cambia, y el stock nunca puede quedar negativo.

**Productos bloqueados:** la vista `vista_disponibilidad_productos` calcula cuántas porciones se pueden preparar con el stock real (menos lo apartado). Si algún insumo no alcanza para 1 porción, el producto aparece **Agotado** en el menú, no se puede agregar al carrito, `crear_pedido()` lo rechaza y el administrador recibe una alerta.

Opcional: con `confirmacion_automatica = true` los pedidos se confirman y descuentan en cuanto llegan.

---

## Paso 12 — Cómo funcionan las alertas y los reportes

### Alertas (tabla `alertas`, se crean solas)

| Alerta | Cuándo aparece | Cuándo se resuelve sola |
|---|---|---|
| ⚠️ INVENTARIO BAJO | stock ≤ mínimo (ej. *Leche: 3 L disponibles. Mínimo establecido: 5 L.*) | al reabastecer |
| 🚨 INSUMO AGOTADO | stock = 0 (ej. *Café en grano: 0 g disponibles.*) | al reabastecer |
| ⛔ PRODUCTO NO DISPONIBLE | un producto ya no se puede preparar | cuando vuelve a alcanzar |
| 📦 REABASTECIMIENTO NECESARIO | *Se recomienda comprar leche, café en grano y azúcar.* | cuando todo está sobre el mínimo |
| ⏱️ PEDIDO ATRASADO | *Pedido #105 lleva 30 minutos en preparación.* | cuando el pedido avanza |
| 🛑 VENTA RECHAZADA | un cliente intentó comprar algo sin insumos | cuando el producto vuelve a alcanzar |
| 🚫 PEDIDO SIN INVENTARIO | no se pudo confirmar un pedido | al confirmarlo o cancelarlo |

No se duplican (solo una alerta abierta por situación). Aparecen en el panel **al instante** (notificación emergente), en el Dashboard y en la sección **Alertas**.

### Reportes (sección **Reportes**)
Elige **Hoy / Esta semana / Este mes / Personalizado** y obtén: ventas, número de pedidos, ticket promedio, **efectivo, tarjeta y transferencia**, ventas por día y por hora, productos **más** y **menos** vendidos, **consumo de insumos**, productos que más inventario consumen, movimientos de inventario, insumos que necesitan reposición e historial de **cortes diarios**. Botón **⬇ CSV** para abrir en Excel.

“Venta” = pedido **confirmado, en preparación, listo o entregado** (no cuentan los nuevos sin confirmar ni los cancelados). Las fechas usan la zona horaria configurada.

---

## 🔒 Seguridad (resumen)

- **RLS activado en todas las tablas.** Un visitante solo puede ver el menú (sin cantidades de inventario), categorías, métodos de pago y cupones activos, y enviar mensajes.
- Un **cliente** solo ve **sus** pedidos, avisos, puntos y favoritos. No ve inventario, recetas, costos, alertas, reportes ni datos de otros clientes.
- Los pedidos se crean **solo** con la función `crear_pedido()`: precios y totales se calculan en el servidor (el navegador no puede alterar precios).
- Las funciones administrativas validan el rol `admin` **dentro** de la base de datos (`requiere_admin()`), además de ocultarse del rol anónimo.
- El stock solo cambia mediante movimientos; los historiales no se pueden editar ni borrar.
- El seguimiento público de pedidos usa un **código aleatorio** (`CA-XXXXXXXX`) y no muestra nombre ni teléfono.
- Solo se usa la anon key en el frontend; ninguna clave secreta.

---

## ✅ Prueba rápida recomendada

1. **Cliente:** abre el sitio → agrega 2 Americanos → *Finalizar pedido* → llena tus datos → verás el **resumen con código**.
2. **Admin:** abre `admin.html` → Dashboard muestra **1 nuevo** → *Pedidos* → **Confirmar**.
3. **Inventario → Movimientos:** verás las salidas por venta (40 g de café, 500 ml de agua, 20 g de azúcar).
4. Pasa el pedido a *Preparar* y *Listo*: el inventario **no** vuelve a cambiar.
5. **Cliente:** “📦 Mi pedido” muestra el nuevo estado (se actualiza solo).
6. **Admin:** en Inventario registra una **Merma** de leche hasta dejar muy poca → el menú del cliente muestra *Cappuccino/Latte* como **Agotado** y aparecen las alertas.
7. **Agente:** pregunta “¿Qué insumos necesitamos comprar?” y luego escribe “Registra entrada de 10 litros de leche” → **Autorizar** → los productos vuelven a estar disponibles.
8. **Reportes:** revisa ventas del día, efectivo/tarjeta y consumo de insumos.

---

## 🛠️ Solución de problemas

| Problema | Solución |
|---|---|
| “El sitio aún no está conectado a Supabase” | Revisa `config.js` (URL y anon key sin espacios). |
| El menú no carga y dice “¿Ya ejecutaste el SQL?” | Ejecuta `supabase/01_cafe_aroma_v3.sql`. |
| El SQL dice “Se detectó la base de datos V2” | Sigue el Paso 2B. |
| “Este usuario no tiene permisos de administrador” | Ejecuta el `update … set rol='admin'` del Paso 7 con el UUID correcto. |
| El cliente se registra pero no puede entrar | Desactiva *Confirm email* (Paso 1.4) o confirma el correo. |
| El panel dice “Actualización periódica” en vez de “En vivo” | Revisa Database → Publications → `supabase_realtime`. El panel sigue funcionando (se actualiza cada minuto). |
| No hay cortes diarios automáticos | Activa pg_cron (Paso 4.4) o usa el botón “Generar corte de ayer”. |
| Un producto nunca se agota | No tiene receta: agrégala (Paso 10). |

---

## 🗄️ Estructura de la base de datos (resumen)

**Catálogos:** `categorias`, `metodos_pago`, `estados_pedido`, `unidades_medida`, `configuracion`
**Usuarios:** `perfiles` (rol cliente/admin), `clientes`
**Menú:** `productos`, `recetas` (producto → insumo → cantidad)
**Inventario:** `insumos` (estado calculado automáticamente), `proveedores`, `movimientos_inventario` (entradas, salidas, devoluciones, mermas, ajustes)
**Pedidos:** `pedidos`, `detalle_pedidos`, `historial_estados_pedido`
**Automatización:** `alertas`, `agente_acciones`, `agente_mensajes`, `cortes_diarios`
**Cliente (V2):** `favoritos`, `puntos_cliente`, `movimientos_puntos`, `cupones`, `notificaciones`, `resenas`, `mensajes_contacto`

**Vistas:** `vista_disponibilidad_productos`, `vista_inventario`, `vista_stock_comprometido`, `vista_reabastecimiento`, `vista_pedidos_admin`, `vista_pedidos_atrasados`, `vista_ventas_diarias`, `vista_productos_mas_vendidos`, `vista_ventas_metodo`, `vista_movimientos_inventario`, `vista_entradas_inventario`, `vista_salidas_inventario`, `vista_costo_productos`.

**Funciones (RPC) públicas:** `obtener_menu`, `verificar_carrito`, `crear_pedido`, `consultar_pedido`, `cancelar_mi_pedido`.
**Funciones administrativas:** `cambiar_estado_pedido`, `registrar_movimiento_inventario`, `ajustar_inventario_conteo`, `crear_insumo`, `guardar_receta`, `resolver_alerta`, `revisar_pedidos_atrasados`, `reporte_ventas`, `reporte_consumo_insumos`, `reporte_consumo_por_producto`, `resumen_negocio`, `agente_revisar`, `proponer_accion_agente`, `resolver_accion_agente`, `generar_corte_diario`.
