# Verificación de Café Aroma V3

Antes de entregar, el proyecto se probó de dos formas:

1. **Base de datos:** el SQL se ejecutó en PostgreSQL con un entorno que imita a Supabase (roles `anon` y `authenticated`, `auth.uid()`, permisos por defecto de Supabase y publicación de Realtime). Se probaron las reglas de negocio llamando a las funciones como visitante, cliente y administrador. **71/71 pruebas OK.**
2. **De punta a punta:** las páginas reales (`index.html` y `admin.html`) se abrieron en Chromium usando la librería oficial `supabase-js`, conectadas a esa base de datos. Se simuló a un cliente y a un administrador haciendo clic en la interfaz. **64/64 pruebas OK**, sin errores de JavaScript.

También se probó que el SQL se puede **volver a ejecutar** sin perder datos y la **migración desde la V2** (respaldo → instalación → migración).

## Lista solicitada

| # | Requisito | Resultado | Cómo se comprobó |
|---|---|---|---|
| 1 | El menú funciona | ✅ | 20 productos y 4 categorías cargados desde Supabase; agregar al carrito y favoritos. |
| 2 | Los pedidos funcionan | ✅ | Pedido como invitado y como cliente con cuenta, con cupón, resumen y código de seguimiento. Precios calculados en el servidor. |
| 3 | Los estados funcionan | ✅ | Nuevo → Confirmado → En preparación → Listo → Entregado desde el panel; no se permite regresar; historial registrado; el cliente ve el estado actualizado. |
| 4 | El inventario se descuenta automáticamente | ✅ | 5 Americanos descuentan exactamente 100 g de café, 1250 ml de agua y 50 g de azúcar al confirmar. |
| 5 | No existen descuentos duplicados | ✅ | Avanzar estados no descuenta de nuevo; dos confirmaciones simultáneas producen un solo descuento; índice único; stock = suma de movimientos en todos los insumos. |
| 6 | Productos bloqueados sin insumos | ✅ | Con 100 ml de leche, el Cappuccino (200 ml) aparece “Agotado”, el botón se deshabilita, `crear_pedido` lo rechaza y se genera alerta. El último insumo apartado no se vende dos veces. |
| 7 | Las alertas funcionan | ✅ | Inventario bajo, insumo agotado, producto no disponible, reabastecimiento, venta rechazada, pedido sin inventario y pedido atrasado (“Pedido #N lleva 30 minutos en preparación.”). Se resuelven solas. |
| 8 | Reportes del administrador | ✅ | Ventas por periodo, efectivo/tarjeta/transferencia, más/menos vendidos, consumo de insumos, productos que más consumen, movimientos, reposición y cortes diarios. |
| 9 | El agente consulta información real | ✅ | 15 preguntas respondidas con datos de la base (pendientes, en preparación, ventas, efectivo, tarjeta, más/menos vendidos, bajos, agotados, no vendibles, qué comprar, atrasados, consumo, stock de un insumo, estado de un pedido). Ante una pregunta desconocida no inventa. |
| 10 | Supabase correctamente configurado | ✅ | Script completo e idempotente; Realtime; pg_cron opcional con respaldo desde el panel. |
| 11 | La seguridad está configurada | ✅ | Visitante y cliente no leen insumos ni vistas internas, no ejecutan reportes ni funciones internas, no insertan pedidos directo, no pueden hacerse admin; nadie edita el stock directo; historial inmutable. |
| 12 | El proyecto se ejecuta correctamente | ✅ | Sitio y panel funcionando en computadora, tablet y celular sin desbordes horizontales. |
| 13 | Todos los archivos incluidos | ✅ | HTML, CSS, JS, config, agente, SQL y documentación. |
| 14 | SQL completo incluido | ✅ | `supabase/01_cafe_aroma_v3.sql` (+ respaldo y migración V2). |
| 15 | README con instalación y configuración | ✅ | `README.md`, pasos 1 a 12. |

## Limitaciones conocidas
- Las pruebas se hicieron en un entorno que imita a Supabase, no en un proyecto de Supabase en la nube. Ejecuta la **Prueba rápida recomendada** del README después de instalar.
- Realtime (actualización “● En vivo”) depende de tu proyecto de Supabase; si no está disponible, el panel se actualiza cada minuto.
- El inventario inicial y las recetas son una base razonable: ajústalos a las cantidades reales de tu cafetería (Inventario → Conteo; Menú → Receta).
