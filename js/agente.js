// =====================================================================
// Café Aroma — AGENTE (modo básico, sin IA externa)
// ---------------------------------------------------------------------
// • Entiende preguntas en español por palabras clave (intenciones).
// • Cada respuesta se construye con datos REALES de Supabase
//   (funciones resumen_negocio, reporte_ventas, reporte_consumo_*, vistas).
// • Nunca inventa: si no reconoce la pregunta, lo dice y sugiere opciones.
// • Las acciones (registrar compras, cambiar estados, pausar productos,
//   ajustar mínimos) se PROPONEN y quedan pendientes hasta que el
//   administrador las autoriza.
// =====================================================================
(function () {
  const { money, esc } = CA;
  let db = null;
  let cache = { t: 0, insumos: [], productos: [], unidades: [] };

  // ---------- Utilidades de texto y fechas ----------
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!,;:()"]/g, " ").replace(/\s+/g, " ").trim();

  const toDate = s => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const toStr = d => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return toStr(d); };
  const fmtDay = s => toDate(s).toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

  function periodo(q, hoy, porDefecto) {
    const dow = (toDate(hoy).getUTCDay() + 6) % 7; // 0 = lunes
    const lunes = addDays(hoy, -dow);
    const inicioMes = hoy.slice(0, 8) + "01";
    let m;
    if (/\bayer\b/.test(q)) return { desde: addDays(hoy, -1), hasta: addDays(hoy, -1), etiqueta: "ayer" };
    if (/semana pasada/.test(q)) return { desde: addDays(lunes, -7), hasta: addDays(lunes, -1), etiqueta: "la semana pasada" };
    if (/mes pasado/.test(q)) {
      const fin = addDays(inicioMes, -1);
      return { desde: fin.slice(0, 8) + "01", hasta: fin, etiqueta: "el mes pasado" };
    }
    if ((m = q.match(/ultim[oa]s? (\d{1,3}) dias/))) return { desde: addDays(hoy, -(Number(m[1]) - 1)), hasta: hoy, etiqueta: `los últimos ${m[1]} días` };
    if (/\bsemana\b|semanal/.test(q)) return { desde: lunes, hasta: hoy, etiqueta: "esta semana" };
    if (/\bmes\b|mensual/.test(q)) return { desde: inicioMes, hasta: hoy, etiqueta: "este mes" };
    if (/\bano\b|anual/.test(q)) return { desde: hoy.slice(0, 5) + "01-01", hasta: hoy, etiqueta: "este año" };
    if (/\bhoy\b|del dia|diari/.test(q)) return { desde: hoy, hasta: hoy, etiqueta: "hoy" };
    return porDefecto === "mes"
      ? { desde: inicioMes, hasta: hoy, etiqueta: "este mes" }
      : { desde: hoy, hasta: hoy, etiqueta: "hoy" };
  }

  const UNIDADES = {
    kg: "kg", kilo: "kg", kilos: "kg", kilogramo: "kg", kilogramos: "kg",
    g: "g", gr: "g", grs: "g", gramo: "g", gramos: "g",
    l: "l", lt: "l", lts: "l", litro: "l", litros: "l",
    ml: "ml", mililitro: "ml", mililitros: "ml",
    pieza: "pieza", piezas: "pieza", pz: "pieza", pzs: "pieza", pza: "pieza", pzas: "pieza",
    unidad: "unidad", unidades: "unidad"
  };
  const UNIT_RE = "(kg|kilos?|kilogramos?|gramos?|grs?|g|litros?|lts?|l|mililitros?|ml|piezas?|pzas?|pzs?|pza|pz|unidades|unidad)";

  // Busca un insumo o producto mencionado en el texto (el nombre más largo gana)
  function buscar(lista, texto) {
    const t = " " + norm(texto) + " ";
    let mejor = null, largo = 0;
    for (const item of lista) {
      const n = norm(item.nombre);
      const variantes = [n, n + "s", n + "es"];
      const primera = n.split(" ")[0];
      if (primera.length >= 4 && primera !== n) variantes.push(primera, primera + "s");
      for (const v of variantes) {
        if (t.includes(" " + v + " ") && v.length > largo) { mejor = item; largo = v.length; }
      }
    }
    return mejor;
  }

  async function datosBase() {
    if (Date.now() - cache.t < 30000 && cache.insumos.length) return cache;
    const [ins, prod, uni] = await Promise.all([
      db.from("vista_inventario").select("id,nombre,unidad,stock,stock_texto,minimo_texto,estado,comprometido,proveedor,cantidad_sugerida"),
      db.from("productos").select("id,nombre,activo"),
      db.from("unidades_medida").select("*")
    ]);
    cache = { t: Date.now(), insumos: ins.data || [], productos: prod.data || [], unidades: uni.data || [] };
    return cache;
  }

  async function rpc(nombre, params) {
    const { data, error } = await db.rpc(nombre, params || {});
    if (error) throw error;
    return data;
  }

  const lista = arr => arr.length ? `<ul>${arr.map(x => `<li>${x}</li>`).join("")}</ul>` : "";
  const tabla = (heads, rows) => `<div class="table-wrap"><table><thead><tr>${heads.map(h => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const fuente = txt => `<span class="source">📊 ${txt || "Datos reales de Supabase"} · ${new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</span>`;

  async function proponer(tipo, datos, descripcion) {
    const r = await rpc("proponer_accion_agente", { p_tipo: tipo, p_datos: datos, p_descripcion: descripcion });
    if (!r.ok) return `<p>No pude preparar la acción: ${esc(r.mensaje)}</p>`;
    return `<p>Preparé esta acción, pero <b>necesita tu autorización</b>:</p>
      <div class="proposal" data-accion="${r.id}"><b>${esc(descripcion)}</b>
        <div class="row-actions" style="margin-top:8px">
          <button class="btn tiny success" data-autorizar="${r.id}">Autorizar</button>
          <button class="btn tiny light" data-rechazar="${r.id}">Rechazar</button>
        </div></div>`;
  }

  // =================================================================
  // INTENCIONES (en orden de prioridad)
  // =================================================================
  const INTENCIONES = [
    // ---------- Acciones que requieren autorización ----------
    {
      id: "accion_entrada",
      test: q => new RegExp(`(registra\\w*( una)? entrada|entrada de|compre|compramos|llegaron|llego|recibi|recibimos|agrega\\w*|suma\\w*)\\s+(de\\s+)?\\d`).test(q),
      async run(q) {
        const { insumos, unidades } = await datosBase();
        const m = q.match(new RegExp(`(\\d+(?:[.]\\d+)?)\\s*(?:${UNIT_RE}(?![a-z]))?\\s*(?:de\\s+)?(.*)`));
        if (!m) return "<p>Indica la cantidad, por ejemplo: <i>“Registra entrada de 5 litros de leche”.</i></p>";
        const cantidad = Number(m[1]);
        const ins = buscar(insumos, m[3] || q);
        if (!ins) return `<p>No encontré ese insumo en el inventario. Insumos registrados: ${insumos.slice(0, 12).map(i => esc(i.nombre)).join(", ")}…</p>`;
        const unidad = m[2] ? UNIDADES[m[2]] : ins.unidad;
        const uIns = unidades.find(u => u.codigo === ins.unidad), uNew = unidades.find(u => u.codigo === unidad);
        if (uIns && uNew && uIns.tipo !== uNew.tipo) return `<p>${esc(ins.nombre)} se mide en ${esc(uIns.nombre)}; no puedo registrar ${esc(uNew.nombre)}.</p>`;
        return proponer("registrar_entrada", { insumo_id: ins.id, cantidad, unidad, motivo: "Compra registrada desde el agente" },
          `Registrar entrada de ${CA.cantidad(cantidad, unidad)} de ${ins.nombre}`);
      }
    },
    {
      id: "accion_estado",
      test: q => /pedido\s*#?\s*\d+/.test(q) && /\b(marca|pasa|cambia|pon|confirma|cancela|entrega|prepara|inicia)\w*\b|como listo|a listo|como entregado/.test(q),
      async run(q) {
        const id = Number(q.match(/pedido\s*#?\s*(\d+)/)[1]);
        if (/cancel/.test(q)) return proponer("cancelar_pedido", { pedido_id: id, motivo: "Cancelado desde el agente" }, `Cancelar el pedido #${id}`);
        const estado = /entreg/.test(q) ? "entregado" : /listo/.test(q) ? "listo" : /prepar|inicia/.test(q) ? "en_preparacion" : /confirm/.test(q) ? "confirmado" : null;
        if (!estado) return "<p>¿A qué estado lo cambio? (confirmado, en preparación, listo o entregado)</p>";
        return proponer("cambiar_estado_pedido", { pedido_id: id, estado }, `Cambiar el pedido #${id} a “${CA.ESTADOS[estado].nombre}”`);
      }
    },
    {
      id: "accion_producto",
      test: q => /^(pausa|oculta|quita|desactiva|retira|reactiva|activa|muestra|habilita)\w*\b/.test(q),
      async run(q) {
        const { productos } = await datosBase();
        const p = buscar(productos, q);
        if (!p) return null; // no era una orden sobre un producto
        const pausar = /^(pausa|oculta|quita|desactiva|retira)/.test(q);
        return proponer(pausar ? "pausar_producto" : "reactivar_producto", { producto_id: p.id },
          `${pausar ? "Ocultar del menú" : "Volver a mostrar en el menú"}: ${p.nombre}`);
      }
    },
    {
      id: "accion_minimo",
      test: q => /minimo de .+ a \d/.test(q),
      async run(q) {
        const { insumos, unidades } = await datosBase();
        const m = q.match(new RegExp(`minimo de (.+?) a (\\d+(?:[.]\\d+)?)\\s*(?:${UNIT_RE}(?![a-z]))?`));
        const ins = m && buscar(insumos, m[1]);
        if (!ins) return "<p>No encontré ese insumo.</p>";
        const unidad = m[3] ? UNIDADES[m[3]] : ins.unidad;
        const f = c => (unidades.find(u => u.codigo === c) || { factor_base: 1 }).factor_base;
        const valor = Number(m[2]) * f(unidad) / f(ins.unidad);
        return proponer("ajustar_stock_minimo", { insumo_id: ins.id, stock_minimo: valor },
          `Cambiar el mínimo de ${ins.nombre} a ${CA.cantidad(valor, ins.unidad)}`);
      }
    },

    // ---------- Preguntas ----------
    {
      id: "ayuda",
      test: q => /^(ayuda|help|hola|que puedes|que sabes|como funcionas)/.test(q),
      run: async () => `<p>Consulto la base de datos en tiempo real. Puedes preguntarme, por ejemplo:</p>${lista([
        "¿Cuántos pedidos tenemos pendientes? / ¿Hay pedidos atrasados?",
        "¿Cuánto hemos vendido hoy / esta semana / este mes?",
        "¿Cuánto corresponde a efectivo? ¿Y a tarjeta?",
        "¿Qué productos se venden más / menos?",
        "¿Qué insumos están bajos / agotados? ¿Qué necesitamos comprar?",
        "¿Qué productos ya no pueden venderse?",
        "¿Qué productos consumen más inventario?",
        "¿Cuánta leche queda? · ¿Cómo va el pedido 12?",
        "Acciones: “Registra entrada de 5 litros de leche”, “Marca el pedido 12 como listo”, “Pausa el Mocha”, “Cambia el mínimo de leche a 6 litros”."
      ])}<p>Las acciones siempre quedan pendientes hasta que tú las autorizas.</p>`
    },
    {
      id: "estado_pedido",
      test: q => /pedido\s*#?\s*\d+/.test(q),
      async run(q) {
        const id = Number(q.match(/pedido\s*#?\s*(\d+)/)[1]);
        const { data, error } = await db.from("vista_pedidos_admin").select("*").eq("id", id).maybeSingle();
        if (error) throw error;
        if (!data) return `<p>No existe el pedido #${id}.</p>`;
        return `<p><b>Pedido #${data.id}</b> (${esc(data.codigo_seguimiento)}) de ${esc(data.cliente)}: ${CA.estadoBadge(data.estado)}</p>
          ${lista([`Productos: ${esc(data.productos || "—")}`, `Total: ${money(data.total)} · ${esc(data.metodo_nombre)}`,
                   `Lleva ${data.minutos_en_estado} min en este estado${data.atrasado ? " ⏱️ <b>(atrasado)</b>" : ""}`,
                   `Inventario: ${data.inventario_devuelto ? "devuelto" : data.inventario_descontado ? "descontado" : "pendiente de descontar (se descuenta al confirmar)"}`])}${fuente()}`;
      }
    },
    {
      id: "atrasados",
      test: q => /atrasad|retrasad|demorad|tarde|mucho tiempo/.test(q),
      async run() {
        const r = await rpc("resumen_negocio");
        const a = r.atrasados || [];
        if (!a.length) return `<p>✅ No hay pedidos atrasados. Límites: ${r.limites.preparacion} min en preparación y ${r.limites.sin_atender} min sin atender.</p>${fuente()}`;
        return `<p>⏱️ Hay <b>${a.length}</b> pedido(s) atrasado(s):</p>${lista(a.map(p => `Pedido #${p.id} (${esc(p.cliente)}) lleva <b>${p.minutos} min</b> en “${esc(p.estado_nombre)}”`))}${fuente()}`;
      }
    },
    {
      id: "en_preparacion",
      test: q => /preparacion|preparando|se estan preparando|cocina/.test(q),
      async run() {
        const r = await rpc("resumen_negocio");
        const n = r.pedidos_por_estado.en_preparacion || 0;
        const { data } = await db.from("vista_pedidos_admin").select("id,cliente,minutos_en_estado,atrasado").eq("estado", "en_preparacion").order("estado_actualizado_en");
        return `<p>👨‍🍳 Hay <b>${n}</b> pedido(s) en preparación.</p>${lista((data || []).map(p => `#${p.id} ${esc(p.cliente)} — ${p.minutos_en_estado} min${p.atrasado ? " ⏱️ atrasado" : ""}`))}${fuente()}`;
      }
    },
    {
      id: "pendientes",
      test: q => /pendiente|por atender|sin atender|en espera|en curso|activos|cuantos pedidos (tenemos|hay)\b(?! hoy)/.test(q),
      async run() {
        const r = await rpc("resumen_negocio");
        const e = r.pedidos_por_estado;
        const total = (e.nuevo || 0) + (e.confirmado || 0) + (e.en_preparacion || 0) + (e.listo || 0);
        return `<p>Tenemos <b>${total}</b> pedido(s) pendientes de entregar:</p>${lista([
          `🆕 Nuevos (por confirmar): <b>${e.nuevo || 0}</b>`, `✅ Confirmados: <b>${e.confirmado || 0}</b>`,
          `👨‍🍳 En preparación: <b>${e.en_preparacion || 0}</b>`, `🛎️ Listos para entregar: <b>${e.listo || 0}</b>`,
          `⏱️ Atrasados: <b>${(r.atrasados || []).length}</b>`])}${fuente()}`;
      }
    },
    {
      id: "consumo_productos",
      test: q => /consum\w* mas|mas inventario|gastan mas|usan mas insumos/.test(q),
      async run(q, hoy) {
        const p = periodo(q, hoy, "mes");
        const { data, error } = await db.rpc("reporte_consumo_por_producto", { p_desde: p.desde, p_hasta: p.hasta });
        if (error) throw error;
        if (!data.length) return `<p>No hay ventas registradas ${p.etiqueta}, así que no hay consumo que analizar.</p>${fuente()}`;
        return `<p>🔥 Productos que más inventario consumieron ${p.etiqueta} (costo de insumos según receta):</p>
          ${tabla(["Producto", "Vendidos", "Costo insumos", "Principales insumos"], data.slice(0, 8).map(r => [esc(r.producto), r.unidades, money(r.costo_insumos),
            (r.insumos || []).slice(0, 3).map(i => `${esc(i.insumo)} ${esc(i.cantidad)}`).join(", ")]))}${fuente()}`;
      }
    },
    {
      id: "consumo_insumos",
      test: q => /insumos? (se )?(usad|utilizad|consumid|gastad)|consumo de insumos|cuanto (se )?(uso|usamos|gastamos|consumimos)/.test(q),
      async run(q, hoy) {
        const p = periodo(q, hoy, "hoy");
        const { data, error } = await db.rpc("reporte_consumo_insumos", { p_desde: p.desde, p_hasta: p.hasta });
        if (error) throw error;
        const usados = (data || []).filter(r => Number(r.consumo_ventas) > 0 || Number(r.mermas) > 0);
        if (!usados.length) return `<p>No se registró consumo de insumos ${p.etiqueta}.</p>${fuente()}`;
        return `<p>🥛 Insumos utilizados ${p.etiqueta}:</p>${tabla(["Insumo", "Usado en ventas", "Mermas", "Costo"],
          usados.map(r => [esc(r.insumo), esc(r.consumo_texto), CA.cantidad(r.mermas, r.unidad), money(r.costo_consumo)]))}${fuente()}`;
      }
    },
    {
      id: "no_vendibles",
      test: q => /no (se )?(pueden|puede) vender|no (estan |esta )?disponible|productos agotados|productos bloqueados|ya no (se )?(pueden|puede)/.test(q),
      async run() {
        const r = await rpc("resumen_negocio");
        const p = r.productos_no_disponibles || [];
        if (!p.length) return `<p>✅ Todos los productos visibles del menú pueden prepararse con el inventario actual.</p>${fuente()}`;
        return `<p>⛔ <b>${p.length}</b> producto(s) no pueden venderse por falta de insumos:</p>${lista(p.map(x => `<b>${esc(x.nombre)}</b> — falta: ${esc((x.faltantes || []).join(", "))}`))}${fuente()}`;
      }
    },
    {
      id: "comprar",
      test: q => /comprar|reabastec|reponer|reposicion|lista de (compra|super)|surtir|pedir al proveedor/.test(q),
      async run() {
        const r = await rpc("resumen_negocio");
        const x = r.reabastecer || [];
        if (!x.length) return `<p>✅ No hace falta comprar nada por ahora: ningún insumo está en su mínimo.</p>${fuente()}`;
        const total = x.reduce((s, i) => s + Number(i.costo_estimado || 0), 0);
        return `<p>📦 Se recomienda comprar (para llegar al stock máximo):</p>${tabla(["Insumo", "Estado", "Comprar", "Proveedor", "Costo aprox."],
          x.map(i => [esc(i.nombre), `<span class="badge ${esc(i.estado)}">${esc(i.estado)}</span>`, esc(i.sugerido), esc(i.proveedor || "—"), money(i.costo_estimado)]))}
          <p>Costo estimado total: <b>${money(total)}</b>. Cuando compres, dime por ejemplo “registra entrada de 5 litros de leche”.</p>${fuente()}`;
      }
    },
    {
      id: "agotados",
      test: q => /agotad|sin existencia|se acabo|se termino|en cero/.test(q),
      async run() {
        const r = await rpc("resumen_negocio");
        const a = r.inventario.agotados || [];
        if (!a.length) return `<p>✅ No hay insumos agotados.</p>${fuente()}`;
        return `<p>🚨 Insumos agotados:</p>${lista(a.map(i => `<b>${esc(i.nombre)}</b>: ${esc(i.stock)}`))}${fuente()}`;
      }
    },
    {
      id: "bajos",
      test: q => /bajo|poco|por acabarse|minimo|escase|faltan? insumos|insumos? (que )?(faltan|necesit)/.test(q),
      async run() {
        const r = await rpc("resumen_negocio");
        const b = r.inventario.bajos || [], a = r.inventario.agotados || [];
        if (!b.length && !a.length) return `<p>✅ Ningún insumo está en su nivel mínimo.</p>${fuente()}`;
        return `<p>⚠️ Insumos con inventario bajo (en o por debajo del mínimo):</p>${lista([
          ...b.map(i => `<b>${esc(i.nombre)}</b>: ${esc(i.stock)} (mínimo ${esc(i.minimo)})`),
          ...a.map(i => `<b>${esc(i.nombre)}</b>: 🚨 agotado`)])}${fuente()}`;
      }
    },
    {
      id: "menos_vendidos",
      test: q => /menos vend|venden menos|vende menos|peor|no se venden|menos populares/.test(q),
      async run(q, hoy) {
        const p = periodo(q, hoy, "mes");
        const r = await rpc("reporte_ventas", { p_desde: p.desde, p_hasta: p.hasta });
        return `<p>🐢 Productos menos vendidos ${p.etiqueta}:</p>${lista((r.menos_vendidos || []).slice(0, 8).map(x => `${esc(x.nombre)} — <b>${x.unidades}</b> uds.`))}${fuente()}`;
      }
    },
    {
      id: "mas_vendidos",
      test: q => /mas vend|venden mas|vende mas|mejor vend|top|populares|favorito de los clientes|estrella/.test(q),
      async run(q, hoy) {
        const p = periodo(q, hoy, "mes");
        const r = await rpc("reporte_ventas", { p_desde: p.desde, p_hasta: p.hasta });
        const top = r.mas_vendidos || [];
        if (!top.length) return `<p>No hay ventas registradas ${p.etiqueta}.</p>${fuente()}`;
        return `<p>🏆 Productos más vendidos ${p.etiqueta}:</p>${tabla(["#", "Producto", "Unidades", "Ventas"],
          top.slice(0, 8).map((x, i) => [i + 1, esc(x.nombre), x.unidades, money(x.ventas)]))}${fuente()}`;
      }
    },
    {
      id: "metodo_pago",
      test: q => /efectivo|tarjeta|transferencia|metodos? de pago|forma de pago/.test(q),
      async run(q, hoy) {
        const p = periodo(q, hoy, "hoy");
        const r = await rpc("reporte_ventas", { p_desde: p.desde, p_hasta: p.hasta });
        const pide = ["efectivo", "tarjeta", "transferencia"].filter(m => q.includes(m));
        const filas = (r.por_metodo || []).filter(m => !pide.length || pide.includes(m.metodo));
        return `<p>💳 Ventas por método de pago ${p.etiqueta}:</p>${lista(filas.map(m => `${esc(m.icono || "")} ${esc(m.nombre)}: <b>${money(m.total)}</b> (${m.pedidos} pedidos)`))}
          <p>Total vendido: <b>${money(r.total)}</b>.</p>${fuente()}`;
      }
    },
    {
      id: "ticket",
      test: q => /ticket|promedio por pedido|gasto promedio/.test(q),
      async run(q, hoy) {
        const p = periodo(q, hoy, "hoy");
        const r = await rpc("reporte_ventas", { p_desde: p.desde, p_hasta: p.hasta });
        return `<p>🧾 Ticket promedio ${p.etiqueta}: <b>${money(r.ticket_promedio)}</b> en ${r.pedidos} pedidos.</p>${fuente()}`;
      }
    },
    {
      id: "stock_insumo",
      test: q => /(cuant[oa]s?|hay|queda|quedan|stock|existencia|inventario de|tenemos)/.test(q) && !/vend|venta/.test(q),
      async run(q) {
        const { insumos } = await datosBase();
        const ins = buscar(insumos, q);
        if (!ins) return null; // deja pasar a la siguiente intención
        const extra = Number(ins.comprometido) > 0 ? ` (${CA.cantidad(ins.comprometido, ins.unidad)} apartados por pedidos nuevos)` : "";
        return `<p><b>${esc(ins.nombre)}</b>: ${esc(ins.stock_texto)} disponibles${extra}. Mínimo: ${esc(ins.minimo_texto)}. Estado: <span class="badge ${esc(ins.estado)}">${esc(ins.estado)}</span>${ins.proveedor ? ` · Proveedor: ${esc(ins.proveedor)}` : ""}.</p>${fuente()}`;
      }
    },
    {
      id: "ventas",
      test: q => /vend|venta|ingres|ganamos|facturamos|cuanto (dinero|llevamos|hicimos)|cuantos pedidos|numero de pedidos|caja|corte/.test(q),
      async run(q, hoy) {
        const p = periodo(q, hoy, "hoy");
        const r = await rpc("reporte_ventas", { p_desde: p.desde, p_hasta: p.hasta });
        const dias = (r.por_dia || []).length > 1 ? tabla(["Día", "Pedidos", "Ventas"], r.por_dia.map(d => [fmtDay(d.fecha), d.pedidos, money(d.total)])) : "";
        return `<p>💰 Ventas ${p.etiqueta}: <b>${money(r.total)}</b> en <b>${r.pedidos}</b> pedido(s).</p>${lista([
          `💵 Efectivo: ${money(r.efectivo)}`, `💳 Tarjeta: ${money(r.tarjeta)}`, `📱 Transferencia: ${money(r.transferencia)}`,
          `🧾 Ticket promedio: ${money(r.ticket_promedio)}`, `Cancelados: ${r.cancelados} · Por confirmar: ${r.pendientes}`])}${dias}
          <span class="source">Se cuentan pedidos confirmados, en preparación, listos y entregados.</span>${fuente()}`;
      }
    },
    {
      id: "resumen",
      test: q => /resumen|como vamos|como va|estado del negocio|situacion|diagnostico|que hay de nuevo|novedades|reporte del dia|revisa/.test(q),
      async run() {
        const r = await rpc("agente_revisar");
        return `<p>🔎 Esto es lo que detecto ahora mismo:</p>${lista(r.hallazgos.map(h => `${h.icono} ${esc(h.mensaje)}`))}${fuente()}`;
      }
    }
  ];

  const SUGERENCIAS = [
    "¿Cuántos pedidos tenemos pendientes?", "¿Cuántos pedidos están en preparación?", "¿Hay pedidos atrasados?",
    "¿Cuánto hemos vendido hoy?", "¿Cuánto corresponde a efectivo?", "¿Cuánto corresponde a tarjeta?",
    "¿Qué productos se venden más?", "¿Qué productos se venden menos?", "¿Qué insumos están bajos?",
    "¿Qué insumos están agotados?", "¿Qué productos ya no pueden venderse?", "¿Qué insumos necesitamos comprar?",
    "¿Qué productos consumen más inventario?", "Resumen del negocio"
  ];

  async function responder(pregunta) {
    const q = norm(pregunta).replace(/(\d),(\d)/g, "$1.$2");
    const hoy = (await rpc("resumen_negocio")).fecha;
    for (const intent of INTENCIONES) {
      if (!intent.test(q)) continue;
      const html = await intent.run(q, hoy);
      if (html) return { html, intencion: intent.id };
    }
    return {
      intencion: "desconocida",
      html: `<p>No estoy seguro de qué me preguntas y prefiero no adivinar. Prueba con alguna de estas preguntas:</p>${lista(SUGERENCIAS.slice(0, 6).map(esc))}<p>Escribe <b>ayuda</b> para ver todo lo que puedo hacer.</p>`
    };
  }

  window.AgenteCafe = {
    init(client) { db = client; },
    sugerencias: SUGERENCIAS,
    async preguntar(pregunta) {
      const r = await responder(pregunta);
      // Historial de conversaciones (tabla agente_mensajes)
      const tmp = document.createElement("div");
      tmp.innerHTML = r.html;
      db.from("agente_mensajes").insert({ pregunta: pregunta.slice(0, 500), respuesta: tmp.textContent.slice(0, 4000), intencion: r.intencion })
        .then(({ error }) => error && console.warn("No se guardó el historial del agente", error));
      return r;
    },
    invalidar() { cache.t = 0; }
  };
})();
