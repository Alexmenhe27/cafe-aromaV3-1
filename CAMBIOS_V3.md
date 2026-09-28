# Café Aroma V3 — Cambios respecto a la V2

## Se conserva de la V2
- Diseño e identidad visual del sitio (mismos colores, tipografías, secciones Inicio/Nosotros/Menú/Contacto y footer).
- Carrito guardado en el dispositivo, cuenta del cliente (registro, perfil, historial, favoritos, puntos de lealtad, promociones, avisos), formulario de contacto, menú móvil.
- Panel con inicio de sesión de administrador, pedidos, inventario, reportes, productos, clientes y mensajes.
- Supabase como único backend; publicación en GitHub Pages.

## Base de datos (nueva estructura)
- Catálogos normalizados: `categorias`, `metodos_pago`, `estados_pedido`, `unidades_medida`, `configuracion`, `proveedores`.
- Insumos con unidad, mínimo, máximo, proveedor, costo, fecha de actualización y **estado calculado** (normal/bajo/agotado/exceso).
- **Recetas** en unidades reales (g, ml, piezas) con conversión automática de kg/L.
- **Movimientos de inventario** como fuente única del stock (entradas, ventas, devoluciones, mermas, ajustes, inicial) con stock anterior/nuevo e historial inmutable.
- Estados de pedido: Nuevo → Confirmado → En preparación → Listo → Entregado / Cancelado, con **historial de cambios**.
- Descuento automático al confirmar, devolución al cancelar, **triple protección contra duplicados**.
- Insumos “apartados” por pedidos nuevos para no vender dos veces el último insumo.
- Alertas automáticas sin duplicados; pedidos atrasados con límite configurable.
- Reportes (ventas, métodos de pago, más/menos vendidos, consumo de insumos, costo por producto) y cortes diarios.
- Tablas del agente: `agente_mensajes`, `agente_acciones` (acciones con autorización).
- Tiempo real (Supabase Realtime) y tareas programadas (pg_cron, opcional).

## Correcciones de seguridad respecto a la V2
- En la V2 un cliente podía cambiar su propio `rol` a `admin` editando su perfil. Ahora un trigger lo impide.
- El stock ya no se puede editar directamente (solo con movimientos registrados).
- Las funciones administrativas validan el rol dentro de la base de datos.
- El menú público ya no expone inventario; la disponibilidad se calcula en el servidor.
- El sitio ya no simula pedidos “en modo demostración” sin base de datos: si Supabase no está configurado, lo avisa.

## Sitio del cliente
- Menú y categorías cargados desde Supabase, con **disponibles/agotados** reales y opción “Ocultar agotados”.
- Verificación de inventario antes de pagar; cupones aplicados en el servidor.
- **Resumen del pedido** con código de seguimiento.
- **“📦 Mi pedido”**: seguimiento con línea de tiempo, actualización automática, pedidos recientes del dispositivo y cancelación mientras esté “Nuevo”.
- Clientes con cuenta: “Mis pedidos” con estado y enlace al seguimiento; avisos en tiempo real.
- CSS y JavaScript separados en archivos (`css/`, `js/`).

## Panel del administrador
- Dashboard profesional: pedidos por estado y atrasados, ventas día/semana/mes, efectivo/tarjeta/transferencia, inventario (disponibles, bajos, agotados, productos no vendibles, reposición), hallazgos del agente, actividad reciente.
- Tablero de pedidos por columnas con tiempos y cambio de estado en un clic; detalle con historial y movimientos.
- Inventario: entradas, mermas, conteo físico, nuevo insumo, reposición sugerida (lista para copiar), movimientos y proveedores.
- Menú y recetas: disponibilidad real, porciones posibles, insumo limitante, costo de receta y margen, editor de recetas.
- Reportes con rango de fechas y exportación CSV; alertas; configuración (tiempos, envío, confirmación automática, cupones, métodos de pago).
- Agente inteligente con datos reales, detecciones automáticas y acciones con autorización.
- Actualización en tiempo real y diseño responsive (computadora, tablet y celular).
