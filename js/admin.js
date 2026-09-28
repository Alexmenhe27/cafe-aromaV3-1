// =====================================================================
// Café Aroma — PANEL ADMINISTRATIVO
// Dashboard · pedidos en tiempo real · inventario · menú y recetas ·
// reportes · alertas · agente · clientes · mensajes · configuración
// =====================================================================
(function () {
  const { db, money, esc } = CA;
  const $ = id => document.getElementById(id);

  const S = {
    user: null,
    resumen: null,
    hallazgos: [],
    orders: [],
    inventory: [],
    units: [],
    suppliers: [],
    moves: [],
    products: [],
    categories: [],
    availability: [],
    costs: [],
    recipes: [],
    alerts: [],
    actions: [],
    view: "dashboard",
    orderFilter: "activos",
    alertFilter: "abiertas",
    invTab: "supplies",
    productCat: "todas",
    range: "hoy",
    report: null
  };

  const TITLES = {
    dashboard: "Dashboard", orders: "Pedidos", inventory: "Inventario", products: "Menú y recetas",
    reports: "Reportes", alerts: "Alertas", agent: "Agente inteligente", customers: "Clientes",
    messages: "Mensajes", settings: "Configuración"
  };
  const NEXT = {
    nuevo: { estado: "confirmado", label: "✅ Confirmar" },
    confirmado: { estado: "en_preparacion", label: "👨‍🍳 Preparar" },
    en_preparacion: { estado: "listo", label: "🛎️ Listo" },
    listo: { estado: "entregado", label: "📦 Entregar" }
  };
  const MOV_LABEL = {
    inicial: "Inicial", entrada: "Entrada", salida_venta: "Venta", devolucion: "Devolución", merma: "Merma", ajuste: "Ajuste"
  };

  // =================================================================
  // UTILIDADES DE INTERFAZ
  // =================================================================
  function toast(msg, type = "") {
    const t = document.createElement("div");
    t.className = "toast " + type;
    t.textContent = msg;
    $("toasts").appendChild(t);
    setTimeout(() => t.remove(), type === "error" ? 6500 : 4200);
  }

  function fail(error) {
    console.error(error);
    toast(CA.errorMsg(error), "error");
  }

  // Ejecuta una RPC y muestra el resultado {ok, mensaje}
  async function call(fn, params, okMsg) {
    const { data, error } = await db.rpc(fn, params);
    if (error) { fail(error); return null; }
    if (data && data.ok === false) { toast(data.mensaje || "No se pudo completar.", "error"); return data; }
    if (okMsg !== false) toast(okMsg || data?.mensaje || "Listo ✓", "ok");
    return data;
  }

  // Diálogo reutilizable
  let dialogHandler = null;
  function openDialog({ title, body, ok = "Guardar", danger = false, onSubmit, onOpen }) {
    $("dialogTitle").textContent = title;
    $("dialogBody").innerHTML = body;
    $("dialogMsg").textContent = "";
    $("dialogMsg").className = "form-msg";
    const okBtn = $("dialogOk");
    okBtn.textContent = ok;
    okBtn.className = "btn " + (danger ? "danger" : "primary");
    okBtn.classList.toggle("hidden", !onSubmit);
    dialogHandler = onSubmit;
    $("dialog").classList.add("open");
    $("dialog").setAttribute("aria-hidden", "false");
    if (onOpen) onOpen($("dialogForm"));
    const first = $("dialogBody").querySelector("input:not([type=hidden]),select,textarea");
    if (first) setTimeout(() => first.focus(), 50);
  }
  function closeDialog() {
    $("dialog").classList.remove("open");
    $("dialog").setAttribute("aria-hidden", "true");
    dialogHandler = null;
  }
  document.querySelectorAll("[data-dialog-close]").forEach(el => el.addEventListener("click", closeDialog));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("dialog").classList.contains("open")) closeDialog(); });
  $("dialogForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!dialogHandler) return closeDialog();
    const btn = $("dialogOk");
    btn.disabled = true;
    try {
      const res = await dialogHandler(e.currentTarget);
      if (res === true) closeDialog();
      else if (typeof res === "string") $("dialogMsg").textContent = res;
    } catch (err) {
      $("dialogMsg").textContent = CA.errorMsg(err);
    } finally {
      btn.disabled = false;
    }
  });

  function bars(rows, label, value, fmt, alt) {
    if (!rows || !rows.length) return '<p class="empty">Sin datos en este periodo.</p>';
    const max = Math.max(...rows.map(r => Number(value(r)) || 0), 1);
    return rows.map(r => `<div class="bar-row"><b title="${esc(label(r))}">${esc(label(r))}</b>
      <div class="bar ${alt ? "alt" : ""}"><i style="width:${(Number(value(r)) || 0) / max * 100}%"></i></div><span>${fmt(r)}</span></div>`).join("");
  }

  function table(headers, rows, emptyMsg = "Sin registros.") {
    if (!rows.length) return `<p class="empty">${emptyMsg}</p>`;
    return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th${h.startsWith("#") ? ' class="num"' : ""}>${h.replace(/^#/, "")}</th>`).join("")}</tr></thead>
      <tbody>${rows.join("")}</tbody></table></div>`;
  }

  const tile = (label, value, sub = "", cls = "", attrs = "") =>
    `<button class="tile ${cls}" ${attrs}><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</button>`;

  function minutesSince(date) {
    return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  }
  function isLate(o) {
    const lim = S.resumen?.limites || { preparacion: 20, sin_atender: 10 };
    const m = minutesSince(o.estado_actualizado_en);
    return (o.estado === "en_preparacion" && m > lim.preparacion) || (["nuevo", "confirmado"].includes(o.estado) && m > lim.sin_atender);
  }
  function unitsFor(code) {
    const u = S.units.find(x => x.codigo === code);
    return u ? S.units.filter(x => x.tipo === u.tipo) : S.units;
  }
  function unitOptions(code, selected) {
    return unitsFor(code).map(u => `<option value="${u.codigo}" ${u.codigo === (selected || code) ? "selected" : ""}>${esc(u.nombre)}</option>`).join("");
  }
  function supplierOptions(selected) {
    return `<option value="">— Sin proveedor —</option>` + S.suppliers.filter(p => p.activo || p.id === selected)
      .map(p => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.nombre)}</option>`).join("");
  }
  // Costo legible: por kg / L cuando la unidad es g / ml
  function costLabel(c, unidad) {
    if (unidad === "g") return money(Number(c) * 1000) + "/kg";
    if (unidad === "ml") return money(Number(c) * 1000) + "/L";
    return money(c) + "/" + unidad;
  }
  const numOrNull = v => (v === "" || v == null ? null : Number(v));
  const dateStr = d => d.toISOString().slice(0, 10);

  function download(filename, text) {
    const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // =================================================================
  // SESIÓN (Supabase Auth + rol admin en la tabla perfiles)
  // =================================================================
  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!db) { $("loginMsg").textContent = "Configura config.js con tu URL y anon key de Supabase."; return; }
    const f = e.currentTarget;
    $("loginMsg").textContent = "Iniciando…";
    const { data, error } = await db.auth.signInWithPassword({ email: f.elements.email.value.trim(), password: f.elements.password.value });
    if (error) { $("loginMsg").textContent = CA.errorMsg(error); return; }
    await enter(data.user);
  });

  async function enter(user, restored) {
    const { data: isAdmin, error } = await db.rpc("es_admin");
    if (error || !isAdmin) {
      // Una sesión de cliente abierta en el sitio no se cierra; solo se pide iniciar como administrador
      if (!restored) await db.auth.signOut();
      $("loginMsg").textContent = error ? CA.errorMsg(error)
        : restored ? "La sesión actual es de un cliente. Inicia sesión con una cuenta de administrador."
        : "Este usuario no tiene permisos de administrador.";
      return;
    }
    const { data: p } = await db.from("perfiles").select("nombre").eq("user_id", user.id).maybeSingle();
    S.user = user;
    $("loginMsg").textContent = "";
    $("loginView").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("welcome").textContent = `Hola, ${p?.nombre || "Administrador"} 👋`;
    AgenteCafe.init(db);
    initChat();
    await loadCatalogs();
    await refreshAll();
    startRealtime();
    startTimers();
  }

  $("logout").addEventListener("click", async () => {
    await db.auth.signOut();
    location.reload();
  });

  // =================================================================
  // NAVEGACIÓN
  // =================================================================
  function showView(view, subtab) {
    S.view = view;
    document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
    $("view-" + view).classList.remove("hidden");
    $("viewTitle").textContent = TITLES[view];
    $("sidebar").classList.remove("open");
    if (subtab && view === "inventory") S.invTab = subtab;
    renderView();
    window.scrollTo({ top: 0 });
  }
  $("nav").addEventListener("click", e => { const b = e.target.closest("[data-view]"); if (b) showView(b.dataset.view); });
  document.addEventListener("click", e => {
    const g = e.target.closest("[data-goto]");
    if (!g) return;
    if (g.dataset.filter) S.orderFilter = g.dataset.filter;
    showView(g.dataset.goto, g.dataset.subtab);
  });
  $("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("open"));
  $("refreshAll").addEventListener("click", () => refreshAll(true));

  async function renderView() {
    switch (S.view) {
      case "dashboard": return renderDashboard();
      case "orders": return renderOrders();
      case "inventory": if (S.invTab === "movements") await loadMoves(); return renderInventory();
      case "products": await loadProducts(); return renderProducts();
      case "reports": if (!S.report) setRange(S.range); return;
      case "alerts": return renderAlerts();
      case "agent": await loadActions(); return renderAgent();
      case "customers": return loadCustomers();
      case "messages": return loadMessages();
      case "settings": return loadSettings();
    }
  }

  // =================================================================
  // CARGA DE DATOS
  // =================================================================
  async function loadCatalogs() {
    const [u, s] = await Promise.all([
      db.from("unidades_medida").select("*").order("tipo").order("factor_base"),
      db.from("proveedores").select("*").order("nombre")
    ]);
    S.units = u.data || [];
    S.suppliers = s.data || [];
  }

  // agente_revisar(): automatizaciones + hallazgos + resumen completo del negocio
  async function runAgent() {
    const { data, error } = await db.rpc("agente_revisar");
    if (error) { fail(error); return; }
    S.resumen = data.resumen;
    S.hallazgos = data.hallazgos || [];
  }

  async function loadOrders() {
    const activos = ["nuevo", "confirmado", "en_preparacion", "listo"];
    const [a, b] = await Promise.all([
      db.from("vista_pedidos_admin").select("*").in("estado", activos).order("creado_en"),
      db.from("vista_pedidos_admin").select("*").not("estado", "in", `(${activos.join(",")})`).order("creado_en", { ascending: false }).limit(200)
    ]);
    if (a.error || b.error) { fail(a.error || b.error); return; }
    S.orders = [...a.data, ...b.data].sort((x, y) => new Date(y.creado_en) - new Date(x.creado_en));
  }

  async function loadInventory() {
    const { data, error } = await db.from("vista_inventario").select("*").order("nombre");
    if (error) { fail(error); return; }
    S.inventory = data;
  }

  async function loadMoves() {
    const { data, error } = await db.from("vista_movimientos_inventario").select("*").order("creado_en", { ascending: false }).limit(300);
    if (error) { fail(error); return; }
    S.moves = data;
  }

  async function loadAlerts() {
    const { data, error } = await db.from("alertas").select("*").order("creado_en", { ascending: false }).limit(300);
    if (error) { fail(error); return; }
    S.alerts = data;
  }

  async function loadActions() {
    const { data, error } = await db.from("agente_acciones").select("*").order("creado_en", { ascending: false }).limit(40);
    if (error) { fail(error); return; }
    S.actions = data;
  }

  async function loadProducts() {
    const [p, c, a, k, r] = await Promise.all([
      db.from("productos").select("*").order("orden").order("id"),
      db.from("categorias").select("*").order("orden").order("id"),
      db.from("vista_disponibilidad_productos").select("*"),
      db.from("vista_costo_productos").select("*"),
      db.from("recetas").select("producto_id,insumo_id,cantidad")
    ]);
    const err = p.error || c.error || a.error || k.error || r.error;
    if (err) { fail(err); return; }
    S.products = p.data; S.categories = c.data; S.availability = a.data; S.costs = k.data; S.recipes = r.data;
  }

  async function loadUnreadMessages() {
    const { count } = await db.from("mensajes_contacto").select("id", { count: "exact", head: true }).eq("leido", false);
    $("navMessages").textContent = count || "";
  }

  let refreshing = false;
  async function refreshAll(manual) {
    if (refreshing) return;
    refreshing = true;
    try {
      await Promise.all([runAgent(), loadOrders(), loadInventory(), loadAlerts(), loadMoves(), loadActions(), loadUnreadMessages()]);
      updateBadges();
      await renderView();
      $("lastUpdate").textContent = "Actualizado " + CA.hora(new Date());
      if (manual) toast("Datos actualizados", "ok");
    } finally {
      refreshing = false;
    }
  }

  function updateBadges() {
    const r = S.resumen;
    if (!r) return;
    const e = r.pedidos_por_estado;
    const activos = (e.nuevo || 0) + (e.confirmado || 0) + (e.en_preparacion || 0) + (e.listo || 0);
    $("navOrders").textContent = activos || "";
    const inv = (r.inventario.bajos.length + r.inventario.agotados.length);
    $("navInventory").textContent = inv || "";
    $("navAlerts").textContent = S.alerts.filter(a => !a.resuelta).length || "";
    $("navAgent").textContent = r.acciones_pendientes || "";
    $("delayInfo").textContent = `${r.limites.preparacion} min en preparación · ${r.limites.sin_atender} min sin atender`;
  }

  // Refrescos parciales con “debounce” (para eventos en tiempo real)
  const pending = new Set();
  let debounceTimer = null;
  function schedule(...parts) {
    parts.forEach(p => pending.add(p));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const jobs = [...pending];
      pending.clear();
      const tasks = [];
      if (jobs.includes("orders")) tasks.push(loadOrders());
      if (jobs.includes("inventory")) tasks.push(loadInventory(), loadMoves());
      if (jobs.includes("alerts")) tasks.push(loadAlerts());
      if (jobs.includes("actions")) tasks.push(loadActions());
      tasks.push(runAgent());
      await Promise.all(tasks);
      updateBadges();
      if (S.view !== "reports") renderView();
      $("lastUpdate").textContent = "Actualizado " + CA.hora(new Date());
    }, 700);
  }

  // =================================================================
  // TIEMPO REAL (Supabase Realtime) + temporizadores
  // =================================================================
  function startRealtime() {
    const ch = db.channel("panel-admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "pedidos" }, payload => {
        if (payload.eventType === "INSERT") toast(`🛎️ Nuevo pedido #${payload.new.id} · ${money(payload.new.total)}`);
        schedule("orders", "inventory");
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "alertas" }, payload => {
        toast(`${payload.new.titulo}: ${payload.new.mensaje}`, ["critica", "alta"].includes(payload.new.severidad) ? "error" : "");
        schedule("alerts");
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "alertas" }, () => schedule("alerts"))
      .on("postgres_changes", { event: "*", schema: "public", table: "insumos" }, () => schedule("inventory"))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "movimientos_inventario" }, () => schedule("inventory"))
      .on("postgres_changes", { event: "*", schema: "public", table: "agente_acciones" }, () => schedule("actions"))
      .subscribe(status => {
        const live = $("liveStatus");
        const on = status === "SUBSCRIBED";
        live.className = "live " + (on ? "on" : "off");
        live.textContent = on ? "● En vivo" : "● Actualización periódica";
      });
    return ch;
  }

  function startTimers() {
    // Revisión automática del agente (pedidos atrasados, alertas, propuestas)
    setInterval(() => schedule(), 60000);
    // Relojes de los pedidos en curso
    setInterval(() => { if (S.view === "orders" && S.orderFilter === "activos") renderOrders(); }, 30000);
  }

  // =================================================================
  // DASHBOARD
  // =================================================================
  function renderDashboard() {
    const r = S.resumen;
    if (!r) return;
    const e = r.pedidos_por_estado;
    const late = (r.atrasados || []).length;
    $("dashOrders").innerHTML = [
      tile("🆕 Nuevos", e.nuevo || 0, "por confirmar", "t-orange", 'data-goto="orders" data-filter="activos"'),
      tile("✅ Confirmados", e.confirmado || 0, "", "t-blue", 'data-goto="orders" data-filter="activos"'),
      tile("👨‍🍳 En preparación", e.en_preparacion || 0, "", "t-brown", 'data-goto="orders" data-filter="activos"'),
      tile("🛎️ Listos", e.listo || 0, "para entregar", "t-green", 'data-goto="orders" data-filter="activos"'),
      tile("📦 Entregados", e.entregado || 0, "hoy", "t-gray", 'data-goto="orders" data-filter="entregado"'),
      tile("✖️ Cancelados", e.cancelado || 0, "hoy", "t-gray", 'data-goto="orders" data-filter="cancelado"'),
      tile("⏱️ Atrasados", late, late ? "¡atiéndelos!" : "todo a tiempo", "t-red " + (late ? "alert-on" : ""), 'data-goto="orders" data-filter="atrasados"')
    ].join("");

    const h = r.ventas_hoy, w = r.ventas_semana, m = r.ventas_mes;
    $("dashSales").innerHTML = [
      tile("💰 Ventas del día", money(h.total), `${h.pedidos} pedidos`, "t-orange", 'data-goto="reports"'),
      tile("📅 Ventas de la semana", money(w.total), `${w.pedidos} pedidos`, "t-brown", 'data-goto="reports"'),
      tile("🗓️ Ventas del mes", money(m.total), `${m.pedidos} pedidos`, "t-brown", 'data-goto="reports"'),
      tile("🧾 Pedidos hoy", h.pedidos, `ticket ${money(h.ticket_promedio)}`, "t-blue", 'data-goto="orders"'),
      tile("💵 Efectivo hoy", money(h.efectivo), "", "t-green", 'data-goto="reports"'),
      tile("💳 Tarjeta hoy", money(h.tarjeta), "", "t-blue", 'data-goto="reports"'),
      tile("📱 Transferencia hoy", money(h.transferencia), "", "t-gray", 'data-goto="reports"')
    ].join("");

    const inv = r.inventario;
    const noSell = (r.productos_no_disponibles || []).length;
    $("dashInventory").innerHTML = [
      tile("✅ Insumos disponibles", `${inv.normales}/${inv.total}`, "en nivel normal", "t-green", 'data-goto="inventory"'),
      tile("⚠️ Inventario bajo", inv.bajos.length, inv.bajos.slice(0, 2).map(i => i.nombre).join(", "), "t-orange " + (inv.bajos.length ? "alert-on" : ""), 'data-goto="inventory"'),
      tile("🚨 Agotados", inv.agotados.length, inv.agotados.slice(0, 2).map(i => i.nombre).join(", "), "t-red " + (inv.agotados.length ? "alert-on" : ""), 'data-goto="inventory"'),
      tile("⛔ No se pueden vender", noSell, "productos sin insumos", "t-red " + (noSell ? "alert-on" : ""), 'data-goto="products"'),
      tile("📦 Necesitan reposición", (r.reabastecer || []).length, "insumos", "t-brown", 'data-goto="inventory" data-subtab="restock"')
    ].join("");

    $("dashFindings").innerHTML = renderFindings(S.hallazgos);

    const rs = r.reabastecer || [];
    $("dashRestock").innerHTML = rs.length
      ? `<p class="small muted" style="margin:0 0 6px">Se recomienda comprar ${esc(rs.map(i => i.nombre.toLowerCase()).join(", "))}.</p>` +
        rs.map(i => `<div class="list-row"><div><b>${esc(i.nombre)}</b> <span class="badge ${i.estado}">${i.estado}</span>
          <small>Comprar ${esc(i.sugerido)}${i.proveedor ? " · " + esc(i.proveedor) : ""} · aprox. ${money(i.costo_estimado)}</small></div>
          <button class="btn tiny primary" data-entry="${i.id}">Registrar compra</button></div>`).join("")
      : '<p class="empty">✅ Ningún insumo necesita reposición.</p>';

    $("dashTop").innerHTML = bars(r.mas_vendidos_mes, x => x.nombre, x => x.unidades, x => `${x.unidades} uds.`);
    $("dashPayments").innerHTML = bars([
      { n: "💵 Efectivo", v: h.efectivo }, { n: "💳 Tarjeta", v: h.tarjeta }, { n: "📱 Transferencia", v: h.transferencia }
    ], x => x.n, x => x.v, x => money(x.v), true);

    $("dashLastOrders").innerHTML = S.orders.slice(0, 7).map(o => `<div><div><b>#${o.id}</b> ${esc(o.cliente)}<small>${esc(o.productos || "")}</small></div>
      <div style="text-align:right"><span class="badge ${o.estado}">${esc(o.estado_nombre)}</span><small>${money(o.total)} · ${CA.hora(o.creado_en)}</small></div></div>`).join("")
      || '<p class="empty">Aún no hay pedidos.</p>';
    $("dashLastMoves").innerHTML = S.moves.slice(0, 7).map(moveRow).join("") || '<p class="empty">Sin movimientos.</p>';
    $("dashLastAlerts").innerHTML = S.alerts.slice(0, 7).map(a => `<div><div><b>${esc(a.titulo)}</b><small>${esc(a.mensaje)}</small></div>
      <small>${a.resuelta ? "✓" : ""} ${CA.hora(a.creado_en)}</small></div>`).join("") || '<p class="empty">Sin alertas.</p>';
  }

  function moveRow(m) {
    const cls = Number(m.cantidad) > 0 ? "pos" : "neg";
    return `<div><div><b>${esc(m.insumo)}</b> <span class="${cls}">${Number(m.cantidad) > 0 ? "+" : ""}${esc(m.cantidad_texto)}</span>
      <small>${MOV_LABEL[m.tipo] || m.tipo}${m.pedido_id ? " · pedido #" + m.pedido_id : ""}${m.motivo && !m.pedido_id ? " · " + esc(m.motivo) : ""}</small></div>
      <small>${CA.hora(m.creado_en)}</small></div>`;
  }

  function renderFindings(list) {
    return (list || []).map(h => `<div class="finding ${esc(h.nivel)}"><span class="ico">${h.icono}</span><span>${esc(h.mensaje)}</span></div>`).join("")
      || '<p class="empty">Sin detecciones.</p>';
  }

  // Botones "Registrar compra" en cualquier vista
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-entry]");
    if (b) entryDialog(Number(b.dataset.entry));
  });

  // =================================================================
  // PEDIDOS
  // =================================================================
  $("orderFilters").addEventListener("click", e => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    S.orderFilter = b.dataset.filter;
    renderOrders();
  });
  $("orderSearch").addEventListener("input", () => renderOrders());

  function filteredOrders() {
    const q = $("orderSearch").value.trim().toLowerCase().replace("#", "");
    return S.orders.filter(o => !q || String(o.id) === q || (o.codigo_seguimiento || "").toLowerCase().includes(q) ||
      (o.cliente || "").toLowerCase().includes(q) || (o.telefono || "").includes(q));
  }

  function orderCard(o) {
    const mins = minutesSince(o.estado_actualizado_en);
    const late = isLate(o);
    const next = NEXT[o.estado];
    return `<article class="order-card ${late ? "late" : ""}">
      <header><b>#${o.id}</b><span class="timer ${late ? "late" : ""}">${late ? "⏱️ " : ""}${mins} min</span></header>
      <div class="items">${esc(o.productos || "")}</div>
      <div class="meta"><span>👤 ${esc(o.cliente)}</span><span>📞 ${esc(o.telefono)}</span><span>${esc(o.metodo_nombre)}</span><b>${money(o.total)}</b></div>
      ${o.notas ? `<div class="note">📝 ${esc(o.notas)}</div>` : ""}
      <div class="actions">
        ${next ? `<button class="btn tiny ${o.estado === "nuevo" ? "primary" : ""}" data-state="${o.id}" data-to="${next.estado}">${next.label}</button>` : ""}
        <button class="btn tiny light" data-detail="${o.id}">Detalle</button>
        <button class="btn tiny light" data-cancel="${o.id}" title="Cancelar">✖</button>
      </div></article>`;
  }

  function renderOrders() {
    document.querySelectorAll("#orderFilters .chip").forEach(c => c.classList.toggle("active", c.dataset.filter === S.orderFilter));
    const list = filteredOrders();
    const box = $("ordersBoard");
    if (S.orderFilter === "activos") {
      const cols = ["nuevo", "confirmado", "en_preparacion", "listo"];
      box.innerHTML = `<div class="board">${cols.map(c => {
        const items = list.filter(o => o.estado === c).sort((a, b) => new Date(a.estado_actualizado_en) - new Date(b.estado_actualizado_en));
        return `<div class="column"><h3>${CA.ESTADOS[c].icono} ${CA.ESTADOS[c].nombre}<span class="badge">${items.length}</span></h3>
          ${items.map(orderCard).join("") || '<p class="empty" style="text-align:center">—</p>'}</div>`;
      }).join("")}</div>`;
      return;
    }
    const rows = list.filter(o => S.orderFilter === "todos" ? true : S.orderFilter === "atrasados" ? isLate(o) : o.estado === S.orderFilter);
    box.innerHTML = table(["Pedido", "Cliente", "Productos", "#Total", "Pago", "Estado", "Fecha", ""], rows.map(o => `<tr>
      <td><b>#${o.id}</b><br><span class="small muted">${esc(o.codigo_seguimiento)}</span></td>
      <td>${esc(o.cliente)}<br><span class="small muted">${esc(o.telefono)}</span></td>
      <td class="small">${esc(o.productos || "")}${o.motivo_cancelacion ? `<br><span class="muted">Motivo: ${esc(o.motivo_cancelacion)}</span>` : ""}</td>
      <td class="num">${money(o.total)}</td><td>${esc(o.metodo_nombre)}</td>
      <td><span class="badge ${o.estado}">${esc(o.estado_nombre)}</span>${isLate(o) ? ' <span class="badge critica">⏱️</span>' : ""}</td>
      <td class="small">${CA.fecha(o.creado_en)}</td>
      <td><div class="row-actions">${NEXT[o.estado] ? `<button class="btn tiny" data-state="${o.id}" data-to="${NEXT[o.estado].estado}">${NEXT[o.estado].label}</button>` : ""}
        <button class="btn tiny light" data-detail="${o.id}">Detalle</button></div></td></tr>`), "No hay pedidos con este filtro.");
  }

  $("ordersBoard").addEventListener("click", async e => {
    const s = e.target.closest("[data-state]");
    const d = e.target.closest("[data-detail]");
    const c = e.target.closest("[data-cancel]");
    if (s) {
      s.disabled = true;
      await changeState(Number(s.dataset.state), s.dataset.to);
    }
    if (d) orderDetail(Number(d.dataset.detail));
    if (c) cancelDialog(Number(c.dataset.cancel));
  });

  async function changeState(id, estado, nota) {
    const r = await call("cambiar_estado_pedido", { p_pedido_id: id, p_estado: estado, p_nota: nota || null });
    await Promise.all([loadOrders(), loadInventory(), loadMoves(), loadAlerts(), runAgent()]);
    updateBadges();
    renderView();
    return r;
  }

  function cancelDialog(id) {
    const o = S.orders.find(x => x.id === id);
    openDialog({
      title: `Cancelar pedido #${id}`,
      ok: "Cancelar pedido", danger: true,
      body: `<p>${o && o.inventario_descontado ? "Este pedido ya descontó inventario: <b>los insumos se devolverán automáticamente</b>." : "Este pedido aún no descontaba inventario."}</p>
        <label>Motivo<textarea name="motivo" required maxlength="200" placeholder="Ej. El cliente no llegó"></textarea></label>`,
      async onSubmit(f) {
        const r = await changeState(id, "cancelado", f.elements.motivo.value.trim());
        return r && r.ok ? true : (r?.mensaje || "No se pudo cancelar.");
      }
    });
  }

  async function orderDetail(id) {
    const [o, d, h, m] = await Promise.all([
      db.from("vista_pedidos_admin").select("*").eq("id", id).single(),
      db.from("detalle_pedidos").select("*").eq("pedido_id", id).order("id"),
      db.from("historial_estados_pedido").select("*").eq("pedido_id", id).order("creado_en"),
      db.from("vista_movimientos_inventario").select("*").eq("pedido_id", id).order("id")
    ]);
    if (o.error) return fail(o.error);
    const p = o.data;
    openDialog({
      title: `Pedido #${p.id} · ${p.codigo_seguimiento}`,
      body: `<p><span class="badge ${p.estado}">${esc(p.estado_nombre)}</span> · ${esc(p.cliente)} · ${esc(p.telefono)} ${p.email ? "· " + esc(p.email) : ""}</p>
        ${p.notas ? `<p class="small">📝 ${esc(p.notas)}</p>` : ""}
        ${table(["Producto", "#Cant.", "#Precio", "#Subtotal"], (d.data || []).map(x => `<tr><td>${esc(x.producto_nombre)}</td><td class="num">${x.cantidad}</td><td class="num">${money(x.precio_unitario)}</td><td class="num">${money(x.subtotal)}</td></tr>`))}
        <p class="small" style="text-align:right">Subtotal ${money(p.subtotal)}${Number(p.descuento) ? ` · Descuento −${money(p.descuento)} (${esc(p.cupon_codigo)})` : ""} · Envío ${money(p.envio)} · <b>Total ${money(p.total)}</b> · ${esc(p.metodo_nombre)}</p>
        <h3 style="margin-top:14px">Historial de estados</h3>
        <div class="activity">${(h.data || []).map(x => `<div><div>${x.estado_anterior ? esc(CA.ESTADOS[x.estado_anterior]?.nombre || x.estado_anterior) + " → " : ""}<b>${esc(CA.ESTADOS[x.estado_nuevo]?.nombre || x.estado_nuevo)}</b>${x.nota ? `<small>${esc(x.nota)}</small>` : ""}</div><small>${CA.fecha(x.creado_en)}</small></div>`).join("")}</div>
        <h3 style="margin-top:14px">Movimientos de inventario</h3>
        <div class="activity">${(m.data || []).map(moveRow).join("") || '<p class="empty">Aún no se descuenta inventario (se descuenta al confirmar).</p>'}</div>`
    });
  }

  // =================================================================
  // INVENTARIO
  // =================================================================
  $("invTabs").addEventListener("click", async e => {
    const b = e.target.closest("[data-subtab]");
    if (!b) return;
    S.invTab = b.dataset.subtab;
    if (S.invTab === "movements") await loadMoves();
    renderInventory();
  });
  $("invSearch").addEventListener("input", () => renderInventory());
  $("newSupply").addEventListener("click", () => newSupplyDialog());

  function renderInventory() {
    document.querySelectorAll("#invTabs .chip").forEach(c => c.classList.toggle("active", c.dataset.subtab === S.invTab));
    const all = S.inventory.filter(i => i.activo);
    const val = all.reduce((s, i) => s + Number(i.valor_inventario || 0), 0);
    $("invTiles").innerHTML = [
      tile("Insumos activos", all.length, "", "t-brown"),
      tile("✅ Normales", all.filter(i => ["normal", "exceso"].includes(i.estado)).length, "", "t-green"),
      tile("⚠️ Bajos", all.filter(i => i.estado === "bajo").length, "en o bajo el mínimo", "t-orange"),
      tile("🚨 Agotados", all.filter(i => i.estado === "agotado").length, "", "t-red"),
      tile("💲 Valor del inventario", money(val), "a costo actual", "t-blue")
    ].join("");
    const q = $("invSearch").value.trim().toLowerCase();
    const box = $("invContent");

    if (S.invTab === "supplies") {
      const rows = S.inventory.filter(i => !q || i.nombre.toLowerCase().includes(q))
        .sort((a, b) => ({ agotado: 0, bajo: 1, normal: 2, exceso: 3 }[a.estado] - { agotado: 0, bajo: 1, normal: 2, exceso: 3 }[b.estado]) || a.nombre.localeCompare(b.nombre));
      box.innerHTML = table(["Insumo", "Estado", "#Stock", "#Mínimo", "#Máximo", "Proveedor", "#Costo", "Actualizado", ""], rows.map(i => `<tr ${i.activo ? "" : 'style="opacity:.55"'}>
        <td><b>${esc(i.nombre)}</b><br><span class="small muted">${esc(i.unidad_nombre)} · usado en ${i.usado_en_productos} producto(s)${i.activo ? "" : " · inactivo"}</span></td>
        <td><span class="badge ${i.estado}">${i.estado}</span></td>
        <td class="num"><b>${esc(i.stock_texto)}</b>${Number(i.comprometido) > 0 ? `<br><span class="small muted">${CA.cantidad(i.comprometido, i.unidad)} apartado</span>` : ""}</td>
        <td class="num">${esc(i.minimo_texto)}</td><td class="num">${i.stock_maximo != null ? CA.cantidad(i.stock_maximo, i.unidad) : "—"}</td>
        <td>${esc(i.proveedor || "—")}</td><td class="num small">${costLabel(i.costo_unitario, i.unidad)}</td>
        <td class="small">${CA.fecha(i.actualizado_en)}</td>
        <td><div class="row-actions">
          <button class="btn tiny primary" data-entry="${i.id}">+ Entrada</button>
          <button class="btn tiny light" data-waste="${i.id}">Merma</button>
          <button class="btn tiny light" data-count="${i.id}">Conteo</button>
          <button class="btn tiny light" data-edit-supply="${i.id}">Editar</button></div></td></tr>`), "No hay insumos.");
    }

    if (S.invTab === "restock") {
      const rows = S.inventory.filter(i => i.activo && (["bajo", "agotado"].includes(i.estado) || Number(i.comprometido) > Number(i.stock)));
      const total = rows.reduce((s, i) => s + Number(i.cantidad_sugerida) * Number(i.costo_unitario), 0);
      box.innerHTML = `<div class="toolbar"><p class="hint" style="margin:0">Cantidad sugerida = llevar el insumo a su stock máximo. Costo estimado total: <b>${money(total)}</b></p>
        ${rows.length ? '<button class="btn light" id="copyList">📋 Copiar lista de compras</button>' : ""}</div>` +
        table(["Insumo", "Estado", "#Hay", "#Mínimo", "#Comprar", "Proveedor", "#Costo aprox.", ""], rows.map(i => `<tr>
          <td><b>${esc(i.nombre)}</b></td><td><span class="badge ${i.estado}">${i.estado}</span></td>
          <td class="num">${esc(i.stock_texto)}</td><td class="num">${esc(i.minimo_texto)}</td>
          <td class="num"><b>${CA.cantidad(i.cantidad_sugerida, i.unidad)}</b></td><td>${esc(i.proveedor || "—")}</td>
          <td class="num">${money(Number(i.cantidad_sugerida) * Number(i.costo_unitario))}</td>
          <td><button class="btn tiny primary" data-entry="${i.id}">Registrar compra</button></td></tr>`), "✅ Ningún insumo necesita reposición.");
      const copy = $("copyList");
      if (copy) copy.onclick = async () => {
        const txt = "Lista de compras Café Aroma\n" + rows.map(i => `- ${i.nombre}: ${CA.cantidad(i.cantidad_sugerida, i.unidad)}${i.proveedor ? " (" + i.proveedor + ")" : ""}`).join("\n");
        try { await navigator.clipboard.writeText(txt); toast("Lista copiada ✓", "ok"); } catch { toast("No se pudo copiar", "error"); }
      };
    }

    if (S.invTab === "movements") {
      const tipo = box.dataset.tipo || "";
      const rows = S.moves.filter(m => (!q || m.insumo.toLowerCase().includes(q)) && (!tipo || m.tipo === tipo));
      box.innerHTML = `<div class="chips" id="moveTypes" style="margin-bottom:10px">${["", "entrada", "salida_venta", "devolucion", "merma", "ajuste", "inicial"].map(t =>
          `<button class="chip ${t === tipo ? "active" : ""}" data-type="${t}">${t ? MOV_LABEL[t] : "Todos"}</button>`).join("")}</div>` +
        table(["Fecha", "Insumo", "Tipo", "#Cantidad", "#Stock después", "Detalle", "Usuario"], rows.map(m => `<tr>
          <td class="small">${CA.fecha(m.creado_en)}</td><td><b>${esc(m.insumo)}</b></td>
          <td><span class="badge ${Number(m.cantidad) > 0 ? "ok" : "media"}">${MOV_LABEL[m.tipo] || m.tipo}</span></td>
          <td class="num ${Number(m.cantidad) > 0 ? "pos" : "neg"}">${Number(m.cantidad) > 0 ? "+" : ""}${esc(m.cantidad_texto)}</td>
          <td class="num">${esc(m.stock_nuevo_texto)}</td>
          <td class="small">${m.pedido_id ? `Pedido #${m.pedido_id}` : ""} ${esc(m.motivo || "")} ${m.proveedor ? "· " + esc(m.proveedor) : ""}</td>
          <td class="small">${esc(m.usuario || (m.usuario_id ? "—" : "Sistema"))}</td></tr>`), "Sin movimientos.");
      $("moveTypes").onclick = e => { const b = e.target.closest("[data-type]"); if (b) { box.dataset.tipo = b.dataset.type; renderInventory(); } };
    }

    if (S.invTab === "suppliers") {
      box.innerHTML = `<div class="toolbar"><span></span><button class="btn primary" id="newSupplier">+ Nuevo proveedor</button></div>` +
        table(["Proveedor", "Contacto", "Teléfono", "Correo", "Insumos", "Estado", ""], S.suppliers.filter(p => !q || p.nombre.toLowerCase().includes(q)).map(p => `<tr>
          <td><b>${esc(p.nombre)}</b>${p.notas ? `<br><span class="small muted">${esc(p.notas)}</span>` : ""}</td><td>${esc(p.contacto || "—")}</td>
          <td>${esc(p.telefono || "—")}</td><td>${esc(p.email || "—")}</td>
          <td class="small">${esc(S.inventory.filter(i => i.proveedor_id === p.id).map(i => i.nombre).join(", ") || "—")}</td>
          <td><span class="badge ${p.activo ? "ok" : ""}">${p.activo ? "activo" : "inactivo"}</span></td>
          <td><button class="btn tiny light" data-edit-supplier="${p.id}">Editar</button></td></tr>`), "Aún no registras proveedores.");
      $("newSupplier").onclick = () => supplierDialog();
    }
  }

  $("invContent").addEventListener("click", e => {
    const w = e.target.closest("[data-waste]"), c = e.target.closest("[data-count]");
    const ed = e.target.closest("[data-edit-supply]"), sp = e.target.closest("[data-edit-supplier]");
    if (w) wasteDialog(Number(w.dataset.waste));
    if (c) countDialog(Number(c.dataset.count));
    if (ed) editSupplyDialog(Number(ed.dataset.editSupply));
    if (sp) supplierDialog(S.suppliers.find(p => p.id === Number(sp.dataset.editSupplier)));
  });

  async function afterInventoryChange() {
    await Promise.all([loadInventory(), loadMoves(), loadAlerts(), runAgent()]);
    AgenteCafe.invalidar();
    updateBadges();
    renderView();
  }

  function entryDialog(id) {
    const i = S.inventory.find(x => x.id === id);
    if (!i) return;
    const big = { g: "kg", ml: "l" }[i.unidad] || i.unidad;
    openDialog({
      title: `Registrar entrada · ${i.nombre}`,
      ok: "Registrar entrada",
      body: `<p class="small muted">Stock actual: <b>${esc(i.stock_texto)}</b>. Sugerido para llegar al máximo: ${CA.cantidad(i.cantidad_sugerida, i.unidad)}.</p>
        <div class="form-grid">
          <label>Cantidad<input type="number" name="cantidad" min="0.001" step="any" required></label>
          <label>Unidad<select name="unidad">${unitOptions(i.unidad, big)}</select></label>
          <label>Costo por unidad elegida (opcional)<input type="number" name="costo" min="0" step="any" placeholder="Ej. 180 por kg"></label>
          <label>Proveedor<select name="proveedor">${supplierOptions(i.proveedor_id)}</select></label>
          <label class="full">Nota<input name="motivo" maxlength="150" placeholder="Ej. Factura 1234"></label>
        </div>`,
      async onSubmit(f) {
        const r = await call("registrar_movimiento_inventario", {
          p_insumo_id: id, p_tipo: "entrada", p_cantidad: Number(f.elements.cantidad.value), p_unidad: f.elements.unidad.value,
          p_motivo: f.elements.motivo.value || "Compra", p_costo_unitario: numOrNull(f.elements.costo.value), p_proveedor_id: numOrNull(f.elements.proveedor.value)
        });
        if (r && r.ok) { await afterInventoryChange(); return true; }
        return r?.mensaje || "No se pudo registrar.";
      }
    });
  }

  function wasteDialog(id) {
    const i = S.inventory.find(x => x.id === id);
    openDialog({
      title: `Registrar merma · ${i.nombre}`,
      ok: "Registrar merma", danger: true,
      body: `<p class="small muted">Úsalo para desperdicios, derrames o productos caducados. Stock actual: <b>${esc(i.stock_texto)}</b>.</p>
        <div class="form-grid">
          <label>Cantidad<input type="number" name="cantidad" min="0.001" step="any" required></label>
          <label>Unidad<select name="unidad">${unitOptions(i.unidad)}</select></label>
          <label class="full">Motivo<input name="motivo" required maxlength="150" placeholder="Ej. Leche caducada"></label>
        </div>`,
      async onSubmit(f) {
        const r = await call("registrar_movimiento_inventario", {
          p_insumo_id: id, p_tipo: "merma", p_cantidad: Number(f.elements.cantidad.value), p_unidad: f.elements.unidad.value, p_motivo: f.elements.motivo.value
        });
        if (r && r.ok) { await afterInventoryChange(); return true; }
        return r?.mensaje || "No se pudo registrar.";
      }
    });
  }

  function countDialog(id) {
    const i = S.inventory.find(x => x.id === id);
    openDialog({
      title: `Conteo físico · ${i.nombre}`,
      ok: "Guardar conteo",
      body: `<p class="small muted">Escribe la cantidad que <b>realmente</b> hay. El sistema registra un ajuste por la diferencia (queda en el historial). Stock en sistema: <b>${esc(i.stock_texto)}</b>.</p>
        <div class="form-grid">
          <label>Cantidad real<input type="number" name="real" min="0" step="any" required></label>
          <label>Unidad<select name="unidad">${unitOptions(i.unidad)}</select></label>
          <label class="full">Nota<input name="motivo" maxlength="150" value="Conteo físico"></label>
        </div>`,
      async onSubmit(f) {
        const r = await call("ajustar_inventario_conteo", {
          p_insumo_id: id, p_stock_real: Number(f.elements.real.value), p_unidad: f.elements.unidad.value, p_motivo: f.elements.motivo.value
        });
        if (r && r.ok) { await afterInventoryChange(); return true; }
        return r?.mensaje || "No se pudo guardar.";
      }
    });
  }

  function newSupplyDialog() {
    openDialog({
      title: "Nuevo insumo",
      ok: "Crear insumo",
      body: `<p class="small muted">Recomendación: usa gramos (sólidos), mililitros (líquidos) o piezas. Las recetas usan la misma unidad.</p>
        <div class="form-grid">
          <label class="full">Nombre<input name="nombre" required maxlength="80" placeholder="Ej. Leche de almendra"></label>
          <label>Unidad de medida<select name="unidad">${S.units.map(u => `<option value="${u.codigo}">${esc(u.nombre)}</option>`).join("")}</select></label>
          <label>Stock inicial<input type="number" name="stock" min="0" step="any" value="0"></label>
          <label>Stock mínimo (alerta)<input type="number" name="minimo" min="0" step="any" required></label>
          <label>Stock máximo<input type="number" name="maximo" min="0" step="any"></label>
          <label>Costo por unidad<input type="number" name="costo" min="0" step="any" value="0"></label>
          <label>Proveedor<select name="proveedor">${supplierOptions(null)}</select></label>
        </div>`,
      async onSubmit(f) {
        const el = f.elements;
        if (el.maximo.value && Number(el.maximo.value) < Number(el.minimo.value)) return "El máximo debe ser mayor o igual que el mínimo.";
        const r = await call("crear_insumo", {
          p_nombre: el.nombre.value.trim(), p_unidad: el.unidad.value, p_stock_inicial: Number(el.stock.value || 0),
          p_stock_minimo: Number(el.minimo.value || 0), p_stock_maximo: numOrNull(el.maximo.value),
          p_costo_unitario: Number(el.costo.value || 0), p_proveedor_id: numOrNull(el.proveedor.value)
        });
        if (r && r.ok) { await afterInventoryChange(); return true; }
        return r?.mensaje || "No se pudo crear.";
      }
    });
  }

  function editSupplyDialog(id) {
    const i = S.inventory.find(x => x.id === id);
    openDialog({
      title: `Editar insumo · ${i.nombre}`,
      body: `<p class="small muted">El stock no se edita aquí: usa Entrada, Merma o Conteo para que todo quede registrado.</p>
        <div class="form-grid">
          <label class="full">Nombre<input name="nombre" required maxlength="80" value="${esc(i.nombre)}"></label>
          <label>Unidad<input value="${esc(i.unidad_nombre)}" disabled></label>
          <label>Proveedor<select name="proveedor">${supplierOptions(i.proveedor_id)}</select></label>
          <label>Stock mínimo (${esc(i.unidad)})<input type="number" name="minimo" min="0" step="any" value="${Number(i.stock_minimo)}" required></label>
          <label>Stock máximo (${esc(i.unidad)})<input type="number" name="maximo" min="0" step="any" value="${i.stock_maximo ?? ""}"></label>
          <label>Costo por ${esc(i.unidad)} (${costLabel(i.costo_unitario, i.unidad)})<input type="number" name="costo" min="0" step="any" value="${Number(i.costo_unitario)}"></label>
          <label class="check"><input type="checkbox" name="activo" ${i.activo ? "checked" : ""}> Insumo activo</label>
        </div>`,
      async onSubmit(f) {
        const el = f.elements;
        if (el.maximo.value && Number(el.maximo.value) < Number(el.minimo.value)) return "El máximo debe ser mayor o igual que el mínimo.";
        const { error } = await db.from("insumos").update({
          nombre: el.nombre.value.trim(), proveedor_id: numOrNull(el.proveedor.value), stock_minimo: Number(el.minimo.value),
          stock_maximo: numOrNull(el.maximo.value), costo_unitario: Number(el.costo.value || 0), activo: el.activo.checked
        }).eq("id", id);
        if (error) return CA.errorMsg(error);
        toast("Insumo actualizado ✓", "ok");
        await afterInventoryChange();
        return true;
      }
    });
  }

  function supplierDialog(p) {
    openDialog({
      title: p ? `Editar proveedor · ${p.nombre}` : "Nuevo proveedor",
      body: `<div class="form-grid">
        <label class="full">Nombre<input name="nombre" required maxlength="100" value="${esc(p?.nombre || "")}"></label>
        <label>Contacto<input name="contacto" maxlength="100" value="${esc(p?.contacto || "")}"></label>
        <label>Teléfono<input name="telefono" maxlength="30" value="${esc(p?.telefono || "")}"></label>
        <label class="full">Correo<input type="email" name="email" maxlength="150" value="${esc(p?.email || "")}"></label>
        <label class="full">Notas<textarea name="notas" maxlength="300">${esc(p?.notas || "")}</textarea></label>
        <label class="check"><input type="checkbox" name="activo" ${!p || p.activo ? "checked" : ""}> Activo</label></div>`,
      async onSubmit(f) {
        const el = f.elements;
        const row = { nombre: el.nombre.value.trim(), contacto: el.contacto.value.trim() || null, telefono: el.telefono.value.trim() || null,
          email: el.email.value.trim() || null, notas: el.notas.value.trim() || null, activo: el.activo.checked };
        const { error } = p ? await db.from("proveedores").update(row).eq("id", p.id) : await db.from("proveedores").insert(row);
        if (error) return CA.errorMsg(error);
        toast("Proveedor guardado ✓", "ok");
        await loadCatalogs();
        await loadInventory();
        renderInventory();
        return true;
      }
    });
  }

  // =================================================================
  // MENÚ Y RECETAS
  // =================================================================
  $("productCats").addEventListener("click", e => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    S.productCat = b.dataset.cat;
    renderProducts();
  });
  $("newProduct").addEventListener("click", () => productDialog());
  $("manageCats").addEventListener("click", () => categoriesDialog());

  function renderProducts() {
    $("productCats").innerHTML = [`<button class="chip ${S.productCat === "todas" ? "active" : ""}" data-cat="todas">Todas</button>`,
      ...S.categories.map(c => `<button class="chip ${String(c.id) === S.productCat ? "active" : ""}" data-cat="${c.id}">${esc(c.icono || "")} ${esc(c.nombre)}</button>`)].join("");
    const list = S.products.filter(p => S.productCat === "todas" || String(p.categoria_id) === S.productCat);
    if (!list.length) { $("productsContent").innerHTML = '<p class="empty">No hay productos en esta categoría.</p>'; return; }
    $("productsContent").innerHTML = `<div class="product-grid">${list.map(p => {
      const a = S.availability.find(x => x.producto_id === p.id) || {};
      const k = S.costs.find(x => x.producto_id === p.id) || {};
      const cat = S.categories.find(c => c.id === p.categoria_id);
      const rec = S.recipes.filter(r => r.producto_id === p.id).map(r => {
        const i = S.inventory.find(x => x.id === r.insumo_id);
        return i ? `${esc(i.nombre)} ${CA.cantidad(r.cantidad, i.unidad)}` : "";
      }).filter(Boolean);
      const disp = !a.num_insumos ? '<span class="badge media">Sin receta</span>'
        : a.disponible ? `<span class="badge ok">Disponible · ${a.porciones_posibles} porciones</span>`
        : `<span class="badge agotado">Sin insumos: ${esc((a.insumos_faltantes || []).join(", "))}</span>`;
      return `<article class="product ${p.activo ? "" : "off"}">
        <img src="${esc(p.imagen || "")}" alt="" loading="lazy">
        <div class="body">
          <div class="row"><h4>${esc(p.nombre)}</h4><b>${money(p.precio)}</b></div>
          <div class="row"><span class="small muted">${esc(cat ? cat.nombre : "")}</span><span class="badge ${p.activo ? "ok" : ""}">${p.activo ? "Visible" : "Oculto"}</span></div>
          <div>${disp}</div>
          ${a.num_insumos && a.disponible ? `<div class="small muted">Limita: ${esc(a.insumo_limitante || "—")}</div>` : ""}
          <div class="row small"><span>Costo receta: <b>${money(k.costo_receta)}</b></span><span>Margen: <b>${money(k.margen)}</b></span></div>
          <div class="recipe">🧾 ${rec.length ? rec.join(" · ") : "Sin insumos asignados (no descuenta inventario)"}</div>
          <div class="actions">
            <button class="btn tiny primary" data-recipe="${p.id}">Receta</button>
            <button class="btn tiny light" data-edit-product="${p.id}">Editar</button>
            <button class="btn tiny light" data-toggle-product="${p.id}">${p.activo ? "Ocultar" : "Mostrar"}</button>
          </div>
        </div></article>`;
    }).join("")}</div>`;
  }

  $("productsContent").addEventListener("click", async e => {
    const r = e.target.closest("[data-recipe]"), ed = e.target.closest("[data-edit-product]"), t = e.target.closest("[data-toggle-product]");
    if (r) recipeDialog(Number(r.dataset.recipe));
    if (ed) productDialog(S.products.find(p => p.id === Number(ed.dataset.editProduct)));
    if (t) {
      const p = S.products.find(x => x.id === Number(t.dataset.toggleProduct));
      const { error } = await db.from("productos").update({ activo: !p.activo }).eq("id", p.id);
      if (error) return fail(error);
      toast(p.activo ? "Producto oculto del menú" : "Producto visible en el menú", "ok");
      await loadProducts(); renderProducts();
    }
  });

  function productDialog(p) {
    openDialog({
      title: p ? `Editar · ${p.nombre}` : "Nuevo producto",
      ok: p ? "Guardar" : "Crear y definir receta",
      body: `<div class="form-grid">
        <label class="full">Nombre<input name="nombre" required maxlength="80" value="${esc(p?.nombre || "")}"></label>
        <label>Categoría<select name="categoria" required>${S.categories.map(c => `<option value="${c.id}" ${p?.categoria_id === c.id ? "selected" : ""}>${esc(c.nombre)}</option>`).join("")}</select></label>
        <label>Precio (MXN)<input type="number" name="precio" min="0" step="0.5" required value="${p ? Number(p.precio) : ""}"></label>
        <label class="full">Descripción<textarea name="descripcion" maxlength="250">${esc(p?.descripcion || "")}</textarea></label>
        <label class="full">URL de la imagen<input type="url" name="imagen" value="${esc(p?.imagen || "")}" placeholder="https://…"></label>
        <label>Orden en el menú<input type="number" name="orden" step="1" value="${p?.orden ?? 0}"></label>
        <label class="check"><input type="checkbox" name="activo" ${!p || p.activo ? "checked" : ""}> Visible en el menú</label></div>`,
      async onSubmit(f) {
        const el = f.elements;
        const row = { nombre: el.nombre.value.trim(), categoria_id: Number(el.categoria.value), precio: Number(el.precio.value),
          descripcion: el.descripcion.value.trim(), imagen: el.imagen.value.trim() || null, orden: Number(el.orden.value || 0), activo: el.activo.checked };
        const res = p ? await db.from("productos").update(row).eq("id", p.id).select().single()
                      : await db.from("productos").insert(row).select().single();
        if (res.error) return CA.errorMsg(res.error);
        toast("Producto guardado ✓", "ok");
        await loadProducts(); renderProducts();
        if (!p) setTimeout(() => recipeDialog(res.data.id), 50);
        return true;
      }
    });
  }

  function recipeDialog(productId) {
    const p = S.products.find(x => x.id === productId);
    const current = S.recipes.filter(r => r.producto_id === productId);
    const activeSupplies = S.inventory.filter(i => i.activo || current.some(r => r.insumo_id === i.id));
    const rowHtml = (r = {}) => {
      const i = S.inventory.find(x => x.id === r.insumo_id) || activeSupplies[0] || {};
      return `<div class="recipe-row">
        <select name="insumo">${activeSupplies.map(s => `<option value="${s.id}" data-unit="${s.unidad}" ${s.id === i.id ? "selected" : ""}>${esc(s.nombre)}</option>`).join("")}</select>
        <input type="number" name="cantidad" min="0.001" step="any" required value="${r.cantidad != null ? Number(r.cantidad) : ""}" placeholder="Cantidad">
        <select name="unidad">${unitOptions(i.unidad)}</select>
        <button type="button" class="btn tiny light" data-remove-row title="Quitar">✕</button></div>`;
    };
    openDialog({
      title: `Receta · ${p.nombre}`,
      ok: "Guardar receta",
      body: `<p class="small muted">Indica cuánto de cada insumo usa <b>1 ${esc(p.nombre)}</b>. Con esto el sistema calcula la disponibilidad y descuenta el inventario automáticamente al confirmar pedidos.</p>
        <div id="recipeRows">${(current.length ? current : [{}]).map(rowHtml).join("")}</div>
        <button type="button" class="btn tiny light" id="addRecipeRow">+ Agregar insumo</button>
        <p class="small" id="recipeCost" style="margin-top:10px"></p>`,
      onOpen(form) {
        const rows = form.querySelector("#recipeRows");
        const recalc = () => {
          let cost = 0;
          rows.querySelectorAll(".recipe-row").forEach(row => {
            const ins = S.inventory.find(x => x.id === Number(row.querySelector("[name=insumo]").value));
            const u = S.units.find(x => x.codigo === row.querySelector("[name=unidad]").value);
            const base = S.units.find(x => x.codigo === ins?.unidad);
            const qty = Number(row.querySelector("[name=cantidad]").value || 0) * (u && base ? u.factor_base / base.factor_base : 1);
            cost += qty * Number(ins?.costo_unitario || 0);
          });
          form.querySelector("#recipeCost").innerHTML = `Costo estimado por unidad: <b>${money(cost)}</b> · Precio: ${money(p.precio)} · Margen: <b>${money(p.precio - cost)}</b>`;
        };
        rows.addEventListener("change", e => {
          if (e.target.name === "insumo") {
            const unit = e.target.selectedOptions[0].dataset.unit;
            e.target.closest(".recipe-row").querySelector("[name=unidad]").innerHTML = unitOptions(unit);
          }
          recalc();
        });
        rows.addEventListener("input", recalc);
        rows.addEventListener("click", e => { if (e.target.closest("[data-remove-row]")) { e.target.closest(".recipe-row").remove(); recalc(); } });
        form.querySelector("#addRecipeRow").onclick = () => { rows.insertAdjacentHTML("beforeend", rowHtml()); recalc(); };
        recalc();
      },
      async onSubmit(form) {
        const items = [...form.querySelectorAll(".recipe-row")].map(row => ({
          insumo_id: Number(row.querySelector("[name=insumo]").value),
          cantidad: Number(row.querySelector("[name=cantidad]").value),
          unidad: row.querySelector("[name=unidad]").value
        }));
        const ids = items.map(i => i.insumo_id);
        if (new Set(ids).size !== ids.length) return "Hay un insumo repetido. Déjalo en una sola fila.";
        const r = await call("guardar_receta", { p_producto_id: productId, p_items: items });
        if (r && r.ok) { await Promise.all([loadProducts(), runAgent()]); renderProducts(); return true; }
        return r?.mensaje || "No se pudo guardar.";
      }
    });
  }

  function categoriesDialog() {
    const row = c => `<div class="recipe-row" data-id="${c?.id || ""}" style="grid-template-columns:60px minmax(0,2fr) minmax(0,1.3fr) 70px 90px">
      <input name="icono" maxlength="4" value="${esc(c?.icono || "")}" placeholder="☕">
      <input name="nombre" required maxlength="40" value="${esc(c?.nombre || "")}" placeholder="Nombre">
      <input name="slug" required maxlength="30" pattern="[a-z0-9_-]+" value="${esc(c?.slug || "")}" placeholder="clave-url" ${c ? "readonly" : ""}>
      <input name="orden" type="number" value="${c?.orden ?? 0}">
      <label class="check" style="margin:0"><input type="checkbox" name="activo" ${!c || c.activo ? "checked" : ""}> Activa</label></div>`;
    openDialog({
      title: "Categorías del menú",
      body: `<p class="small muted">Ícono · Nombre · Clave (minúsculas, sin espacios) · Orden · Activa</p>
        <div id="catRows">${S.categories.map(row).join("")}</div>
        <button type="button" class="btn tiny light" id="addCat">+ Nueva categoría</button>`,
      onOpen(f) { f.querySelector("#addCat").onclick = () => f.querySelector("#catRows").insertAdjacentHTML("beforeend", row()); },
      async onSubmit(f) {
        for (const r of f.querySelectorAll("#catRows .recipe-row")) {
          const data = { icono: r.querySelector("[name=icono]").value.trim() || null, nombre: r.querySelector("[name=nombre]").value.trim(),
            slug: r.querySelector("[name=slug]").value.trim().toLowerCase(), orden: Number(r.querySelector("[name=orden]").value || 0),
            activo: r.querySelector("[name=activo]").checked };
          const { error } = r.dataset.id ? await db.from("categorias").update(data).eq("id", Number(r.dataset.id)) : await db.from("categorias").insert(data);
          if (error) return CA.errorMsg(error);
        }
        toast("Categorías guardadas ✓", "ok");
        await loadProducts(); renderProducts();
        return true;
      }
    });
  }

  // =================================================================
  // REPORTES
  // =================================================================
  $("reportRange").addEventListener("click", e => {
    const b = e.target.closest("[data-range]");
    if (b) setRange(b.dataset.range);
  });
  $("runReport").addEventListener("click", () => {
    S.range = "custom";
    document.querySelectorAll("#reportRange .chip").forEach(c => c.classList.toggle("active", c.dataset.range === "custom"));
    runReport();
  });
  $("exportReport").addEventListener("click", exportReport);
  $("makeCut").addEventListener("click", async () => { await call("generar_corte_diario", { p_fecha: null }, "Corte generado ✓"); runReport(); });

  function setRange(range) {
    S.range = range;
    document.querySelectorAll("#reportRange .chip").forEach(c => c.classList.toggle("active", c.dataset.range === range));
    const hoy = S.resumen?.fecha || dateStr(new Date());
    const d = new Date(hoy + "T12:00:00Z");
    let desde = hoy;
    if (range === "semana") { const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); desde = dateStr(d); }
    if (range === "mes") desde = hoy.slice(0, 8) + "01";
    if (range !== "custom") { $("repFrom").value = desde; $("repTo").value = hoy; runReport(); }
    else if (!$("repFrom").value) { $("repFrom").value = hoy; $("repTo").value = hoy; }
  }

  async function runReport() {
    const desde = $("repFrom").value, hasta = $("repTo").value;
    if (!desde || !hasta) return toast("Elige las fechas del reporte", "error");
    if (hasta < desde) return toast("La fecha final debe ser posterior a la inicial", "error");
    const fromIso = new Date(desde + "T00:00:00").toISOString(), toIso = new Date(new Date(hasta + "T00:00:00").getTime() + 86400000).toISOString();
    const [v, ci, cp, mv, rs, ct] = await Promise.all([
      db.rpc("reporte_ventas", { p_desde: desde, p_hasta: hasta }),
      db.rpc("reporte_consumo_insumos", { p_desde: desde, p_hasta: hasta }),
      db.rpc("reporte_consumo_por_producto", { p_desde: desde, p_hasta: hasta }),
      db.from("vista_movimientos_inventario").select("*").gte("creado_en", fromIso).lt("creado_en", toIso).order("creado_en", { ascending: false }).limit(500),
      db.from("vista_reabastecimiento").select("*").order("nombre"),
      db.from("cortes_diarios").select("*").order("fecha", { ascending: false }).limit(31)
    ]);
    const err = v.error || ci.error || cp.error || mv.error || rs.error || ct.error;
    if (err) return fail(err);
    S.report = { desde, hasta, ventas: v.data, consumo: ci.data, productos: cp.data, moves: mv.data, restock: rs.data, cortes: ct.data };
    renderReport();
  }

  function renderReport() {
    const R = S.report, v = R.ventas;
    $("repTiles").innerHTML = [
      tile("💰 Ventas", money(v.total), `${v.desde} → ${v.hasta}`, "t-orange"),
      tile("🧾 Número de pedidos", v.pedidos, `ticket promedio ${money(v.ticket_promedio)}`, "t-blue"),
      tile("💵 Efectivo", money(v.efectivo), "", "t-green"),
      tile("💳 Tarjeta", money(v.tarjeta), `📱 Transferencia ${money(v.transferencia)}`, "t-blue"),
      tile("✖️ Cancelados", v.cancelados, `por confirmar: ${v.pendientes}`, "t-gray"),
      tile("🎟️ Descuentos", money(v.descuentos), "cupones aplicados", "t-brown"),
      tile("🥛 Costo de insumos usados", money(R.consumo.reduce((s, x) => s + Number(x.costo_consumo || 0), 0)), "ventas + mermas", "t-red"),
      tile("🔁 Movimientos", R.moves.length, "de inventario", "t-gray")
    ].join("");
    $("repDays").innerHTML = bars(v.por_dia, x => new Date(x.fecha + "T12:00:00Z").toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }), x => x.total, x => `${money(x.total)} · ${x.pedidos}`);
    $("repMethods").innerHTML = bars(v.por_metodo, x => `${x.icono || ""} ${x.nombre}`, x => x.total, x => `${money(x.total)} · ${x.pedidos}`, true);
    $("repTop").innerHTML = bars(v.mas_vendidos, x => x.nombre, x => x.unidades, x => `${x.unidades} uds. · ${money(x.ventas)}`);
    $("repBottom").innerHTML = bars(v.menos_vendidos, x => x.nombre, x => x.unidades, x => `${x.unidades} uds.`, true);
    $("repHours").innerHTML = bars(v.por_hora, x => `${String(x.hora).padStart(2, "0")}:00`, x => x.total, x => money(x.total));
    $("repProductUse").innerHTML = table(["Producto", "#Vendidos", "#Costo insumos", "Insumos usados"], R.productos.slice(0, 10).map(p => `<tr>
      <td><b>${esc(p.producto)}</b></td><td class="num">${p.unidades}</td><td class="num">${money(p.costo_insumos)}</td>
      <td class="small">${(p.insumos || []).map(i => `${esc(i.insumo)} ${esc(i.cantidad)}`).join(", ")}</td></tr>`), "Sin ventas en el periodo.");
    $("repSupplyUse").innerHTML = table(["Insumo", "#Usado en ventas", "#Devuelto", "#Mermas", "#Entradas", "#Ajustes", "#Costo consumo", "#Stock actual", "Estado"], R.consumo.map(c => `<tr>
      <td><b>${esc(c.insumo)}</b></td><td class="num">${esc(c.consumo_texto)}</td><td class="num">${CA.cantidad(c.devoluciones, c.unidad)}</td>
      <td class="num">${CA.cantidad(c.mermas, c.unidad)}</td><td class="num">${CA.cantidad(c.entradas, c.unidad)}</td><td class="num">${CA.cantidad(c.ajustes, c.unidad)}</td>
      <td class="num">${money(c.costo_consumo)}</td><td class="num">${esc(c.stock_actual)}</td><td><span class="badge ${c.estado}">${c.estado}</span></td></tr>`), "Sin movimientos de insumos en el periodo.");
    const byType = {};
    R.moves.forEach(m => { byType[m.tipo] = (byType[m.tipo] || 0) + 1; });
    $("repMoves").innerHTML = `<div class="chips" style="margin-bottom:8px">${Object.entries(byType).map(([t, n]) => `<span class="badge">${MOV_LABEL[t] || t}: ${n}</span>`).join("") || ""}</div>
      <div class="activity">${R.moves.slice(0, 12).map(moveRow).join("") || '<p class="empty">Sin movimientos.</p>'}</div>`;
    $("repRestock").innerHTML = R.restock.length
      ? R.restock.map(i => `<div class="list-row"><div><b>${esc(i.nombre)}</b> <span class="badge ${i.estado}">${i.estado}</span><small>Comprar ${esc(i.sugerido_texto)} · aprox. ${money(i.costo_estimado)}</small></div>
          <button class="btn tiny primary" data-entry="${i.id}">Registrar compra</button></div>`).join("")
      : '<p class="empty">✅ Ningún insumo necesita reposición.</p>';
    $("repCuts").innerHTML = table(["Fecha", "#Pedidos", "#Ventas", "#Efectivo", "#Tarjeta", "#Transferencia", "#Ticket", "#Cancelados", "Más vendido"], R.cortes.map(c => `<tr>
      <td>${c.fecha}</td><td class="num">${c.pedidos}</td><td class="num"><b>${money(c.ventas)}</b></td><td class="num">${money(c.efectivo)}</td>
      <td class="num">${money(c.tarjeta)}</td><td class="num">${money(c.transferencia)}</td><td class="num">${money(c.ticket_promedio)}</td>
      <td class="num">${c.cancelados}</td><td>${esc(c.producto_mas_vendido || "—")}</td></tr>`), "Aún no hay cortes. Se generan cada noche (pg_cron) o con el botón “Generar corte de ayer”.");
  }

  function exportReport() {
    if (!S.report) return toast("Primero consulta un reporte", "error");
    const R = S.report, v = R.ventas;
    const q = x => `"${String(x ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["Reporte Café Aroma", `${R.desde} a ${R.hasta}`], [],
      ["Ventas totales", v.total], ["Pedidos", v.pedidos], ["Ticket promedio", v.ticket_promedio],
      ["Efectivo", v.efectivo], ["Tarjeta", v.tarjeta], ["Transferencia", v.transferencia], ["Cancelados", v.cancelados], [],
      ["Ventas por día"], ["Fecha", "Pedidos", "Total"], ...v.por_dia.map(d => [d.fecha, d.pedidos, d.total]), [],
      ["Productos más vendidos"], ["Producto", "Unidades", "Ventas"], ...v.mas_vendidos.map(p => [p.nombre, p.unidades, p.ventas]), [],
      ["Productos menos vendidos"], ["Producto", "Unidades", "Ventas"], ...v.menos_vendidos.map(p => [p.nombre, p.unidades, p.ventas]), [],
      ["Consumo de insumos"], ["Insumo", "Unidad", "Usado en ventas", "Mermas", "Entradas", "Costo consumo"],
      ...R.consumo.map(c => [c.insumo, c.unidad, c.consumo_ventas, c.mermas, c.entradas, c.costo_consumo]), [],
      ["Insumos que necesitan reposición"], ["Insumo", "Estado", "Comprar", "Costo estimado"],
      ...R.restock.map(i => [i.nombre, i.estado, i.sugerido_texto, i.costo_estimado])
    ];
    download(`reporte-cafe-aroma-${R.desde}_${R.hasta}.csv`, lines.map(l => l.map(q).join(",")).join("\n"));
  }

  // =================================================================
  // ALERTAS
  // =================================================================
  $("alertFilters").addEventListener("click", e => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    S.alertFilter = b.dataset.filter;
    renderAlerts();
  });

  function renderAlerts() {
    document.querySelectorAll("#alertFilters .chip").forEach(c => c.classList.toggle("active", c.dataset.filter === S.alertFilter));
    const list = S.alerts.filter(a => S.alertFilter === "todas" || (S.alertFilter === "abiertas" ? !a.resuelta : a.resuelta));
    const sev = { critica: 0, alta: 1, media: 2, baja: 3 };
    list.sort((a, b) => (a.resuelta - b.resuelta) || (sev[a.severidad] - sev[b.severidad]) || new Date(b.creado_en) - new Date(a.creado_en));
    $("alertsContent").innerHTML = list.length ? `<div class="card">${list.map(a => `<div class="list-row">
        <div><b>${esc(a.titulo)}</b> <span class="badge ${a.severidad}">${a.severidad}</span>${a.resuelta ? ' <span class="badge ok">resuelta</span>' : ""}
          <small>${esc(a.mensaje)}</small><small>${CA.fecha(a.creado_en)}${a.resuelta_en ? " · resuelta " + CA.fecha(a.resuelta_en) : ""}</small></div>
        <div class="row-actions">
          ${a.insumo_id && !a.resuelta ? `<button class="btn tiny primary" data-entry="${a.insumo_id}">Registrar compra</button>` : ""}
          ${a.pedido_id ? `<button class="btn tiny light" data-alert-order="${a.pedido_id}">Ver pedido</button>` : ""}
          ${!a.resuelta ? `<button class="btn tiny light" data-resolve="${a.id}">Marcar resuelta</button>` : ""}</div>
      </div>`).join("")}</div>` : '<p class="empty">✅ No hay alertas en esta vista.</p>';
  }

  $("alertsContent").addEventListener("click", async e => {
    const r = e.target.closest("[data-resolve]"), o = e.target.closest("[data-alert-order]");
    if (r) { await call("resolver_alerta", { p_alerta_id: Number(r.dataset.resolve) }, "Alerta marcada como resuelta"); await loadAlerts(); updateBadges(); renderAlerts(); }
    if (o) orderDetail(Number(o.dataset.alertOrder));
  });

  // =================================================================
  // AGENTE
  // =================================================================
  function addMsg(html, who) {
    const d = document.createElement("div");
    d.className = "msg " + who;
    d.innerHTML = html;
    $("chatLog").appendChild(d);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
    return d;
  }

  function initChat() {
    $("chatLog").innerHTML = "";
    addMsg(`<p>¡Hola! Soy el agente de Café Aroma. Respondo con los datos reales de tu base de datos en Supabase: pedidos, ventas, inventario y alertas.</p>
      <p>También puedo <b>preparar acciones</b> (registrar compras, cambiar estados, pausar productos), pero siempre esperan tu autorización. Escribe <b>ayuda</b> para ver ejemplos.</p>`, "bot");
    $("chatSuggestions").innerHTML = AgenteCafe.sugerencias.map(s => `<button type="button">${esc(s)}</button>`).join("");
  }

  async function ask(q) {
    if (!q.trim()) return;
    addMsg(esc(q), "user");
    const typing = addMsg("Consultando Supabase…", "bot typing");
    try {
      const r = await AgenteCafe.preguntar(q);
      typing.remove();
      addMsg(r.html, "bot");
      if (/data-autorizar/.test(r.html)) { await loadActions(); updateBadges(); renderAgentSide(); }
    } catch (err) {
      typing.remove();
      addMsg(`<p>No pude consultar la base de datos: ${esc(CA.errorMsg(err))}</p>`, "bot");
    }
  }

  $("chatForm").addEventListener("submit", e => {
    e.preventDefault();
    const q = e.currentTarget.elements.q.value;
    e.currentTarget.elements.q.value = "";
    ask(q);
  });
  $("chatSuggestions").addEventListener("click", e => { const b = e.target.closest("button"); if (b) ask(b.textContent); });
  $("runAgent").addEventListener("click", async () => { await runAgent(); await loadActions(); updateBadges(); renderAgent(); toast("Revisión completada ✓", "ok"); });

  // Autorizar / rechazar desde el chat o desde la lista
  document.addEventListener("click", async e => {
    const a = e.target.closest("[data-autorizar]"), r = e.target.closest("[data-rechazar]");
    if (!a && !r) return;
    const id = Number((a || r).dataset.autorizar || (a || r).dataset.rechazar);
    const box = (a || r).closest(".row-actions");
    if (box) box.querySelectorAll("button").forEach(b => b.disabled = true);
    const res = await call("resolver_accion_agente", { p_accion_id: id, p_aprobar: Boolean(a) });
    if (box && res) box.innerHTML = `<span class="badge ${res.ok === false ? "error" : a ? "aprobada" : "rechazada"}">${res.ok === false ? "Error" : a ? "Autorizada ✓" : "Rechazada"}</span>`;
    AgenteCafe.invalidar();
    await Promise.all([loadActions(), loadOrders(), loadInventory(), loadMoves(), loadAlerts(), runAgent()]);
    updateBadges();
    if (S.view === "agent") renderAgentSide(); else renderView();
  });

  function renderAgentSide() {
    $("agentFindings").innerHTML = renderFindings(S.hallazgos);
    const pend = S.actions.filter(a => a.estado === "pendiente");
    $("agentActions").innerHTML = pend.length ? pend.map(a => `<div class="action-item"><b>${esc(a.descripcion)}</b>
        <small class="muted"> · ${a.origen === "automatico" ? "detectada automáticamente" : "desde el chat"} · ${CA.fecha(a.creado_en)}</small>
        <div class="row-actions"><button class="btn tiny success" data-autorizar="${a.id}">Autorizar</button>
        <button class="btn tiny light" data-rechazar="${a.id}">Rechazar</button></div></div>`).join("")
      : '<p class="empty">No hay acciones pendientes.</p>';
    $("agentHistory").innerHTML = S.actions.filter(a => a.estado !== "pendiente").slice(0, 10).map(a => `<div><div>${esc(a.descripcion)}<small>${esc(a.resultado || "")}</small></div>
      <span class="badge ${a.estado}">${a.estado}</span></div>`).join("") || '<p class="empty">Sin historial.</p>';
  }
  function renderAgent() { renderAgentSide(); }

  // =================================================================
  // CLIENTES Y MENSAJES (V2)
  // =================================================================
  let customers = [];
  $("customerSearch").addEventListener("input", renderCustomers);
  async function loadCustomers() {
    const [c, p] = await Promise.all([
      db.from("clientes").select("*").order("creado_en", { ascending: false }).limit(1000),
      db.from("pedidos").select("cliente_id,total,estado").limit(10000)
    ]);
    if (c.error) return fail(c.error);
    const stats = {};
    (p.data || []).forEach(o => {
      const s = stats[o.cliente_id] ||= { n: 0, total: 0 };
      if (o.estado !== "cancelado") { s.n++; s.total += Number(o.total); }
    });
    customers = c.data.map(x => ({ ...x, ...(stats[x.id] || { n: 0, total: 0 }) }));
    renderCustomers();
  }
  function renderCustomers() {
    const q = $("customerSearch").value.trim().toLowerCase();
    const rows = customers.filter(x => !q || [x.nombre, x.telefono, x.email].join(" ").toLowerCase().includes(q));
    $("customersContent").innerHTML = `<div class="card">${table(["Nombre", "Teléfono", "Correo", "Cuenta", "#Pedidos", "#Total comprado", "Registro"], rows.map(x => `<tr>
      <td><b>${esc(x.nombre)}</b></td><td>${esc(x.telefono)}</td><td>${esc(x.email || "—")}</td>
      <td>${x.user_id ? '<span class="badge ok">Registrado</span>' : '<span class="badge">Invitado</span>'}</td>
      <td class="num">${x.n}</td><td class="num">${money(x.total)}</td><td class="small">${CA.fecha(x.creado_en)}</td></tr>`), "Aún no hay clientes.")}</div>`;
  }

  async function loadMessages() {
    const { data, error } = await db.from("mensajes_contacto").select("*").order("creado_en", { ascending: false }).limit(300);
    if (error) return fail(error);
    $("messagesContent").innerHTML = `<div class="card">${table(["Fecha", "Nombre", "Correo", "Mensaje", ""], data.map(x => `<tr ${x.leido ? 'style="opacity:.65"' : ""}>
      <td class="small">${CA.fecha(x.creado_en)}</td><td><b>${esc(x.nombre)}</b></td><td><a href="mailto:${esc(x.email)}">${esc(x.email)}</a></td>
      <td style="white-space:pre-wrap;max-width:460px">${esc(x.mensaje)}</td>
      <td>${x.leido ? '<span class="badge ok">Leído</span>' : `<button class="btn tiny light" data-read="${x.id}">Marcar leído</button>`}</td></tr>`), "No hay mensajes.")}</div>`;
    $("messagesContent").querySelectorAll("[data-read]").forEach(b => b.onclick = async () => {
      const { error: err } = await db.from("mensajes_contacto").update({ leido: true }).eq("id", Number(b.dataset.read));
      if (err) return fail(err);
      await loadUnreadMessages();
      loadMessages();
    });
  }

  // =================================================================
  // CONFIGURACIÓN
  // =================================================================
  const SETTINGS = [
    { clave: "minutos_atraso_preparacion", label: "Minutos máx. en preparación (pedido atrasado)", type: "number", min: 1 },
    { clave: "minutos_atraso_sin_atender", label: "Minutos máx. sin atender (nuevo/confirmado)", type: "number", min: 1 },
    { clave: "minutos_propuesta_cancelacion", label: "El agente propone cancelar pedidos nuevos después de (min)", type: "number", min: 5 },
    { clave: "costo_envio", label: "Costo de envío (MXN)", type: "number", min: 0 },
    { clave: "confirmacion_automatica", label: "Confirmar pedidos automáticamente al recibirlos (descuenta inventario al instante)", type: "bool" },
    { clave: "zona_horaria", label: "Zona horaria del negocio", type: "text" }
  ];

  async function loadSettings() {
    const [c, cp, mp] = await Promise.all([
      db.from("configuracion").select("*"),
      db.from("cupones").select("*").order("creado_en", { ascending: false }),
      db.from("metodos_pago").select("*").order("orden")
    ]);
    const err = c.error || cp.error || mp.error;
    if (err) return fail(err);
    const val = k => (c.data.find(x => x.clave === k) || {}).valor ?? "";
    $("settingsForm").innerHTML = SETTINGS.map(s => s.type === "bool"
      ? `<label class="check full"><input type="checkbox" name="${s.clave}" ${val(s.clave) === "true" ? "checked" : ""}> ${s.label}</label>`
      : `<label class="${s.type === "text" ? "full" : ""}">${s.label}<input name="${s.clave}" type="${s.type}" ${s.min != null ? `min="${s.min}"` : ""} step="any" value="${esc(val(s.clave))}" required></label>`).join("") +
      `<div class="full"><button class="btn primary" type="submit">Guardar configuración</button><p class="form-msg" id="settingsMsg"></p></div>`;

    $("couponsContent").innerHTML = table(["Código", "Descuento", "Descripción", "Vence", ""], cp.data.map(x => `<tr>
      <td><b>${esc(x.codigo)}</b></td><td>${Number(x.descuento)}%</td><td class="small">${esc(x.descripcion || "")}</td>
      <td class="small">${x.expira_en ? CA.fecha(x.expira_en) : "—"}</td>
      <td><button class="btn tiny ${x.activo ? "light" : "success"}" data-coupon="${x.id}" data-on="${x.activo}">${x.activo ? "Desactivar" : "Activar"}</button></td></tr>`), "Sin cupones.");
    $("paymentsContent").innerHTML = mp.data.map(m => `<div class="list-row"><div>${esc(m.icono || "")} <b>${esc(m.nombre)}</b></div>
      <button class="btn tiny ${m.activo ? "light" : "success"}" data-pay="${esc(m.codigo)}" data-on="${m.activo}">${m.activo ? "Desactivar" : "Activar"}</button></div>`).join("");
  }

  $("settingsForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.currentTarget;
    for (const s of SETTINGS) {
      const el = f.elements[s.clave];
      const valor = s.type === "bool" ? String(el.checked) : el.value.trim();
      const { error } = await db.from("configuracion").update({ valor, actualizado_en: new Date().toISOString() }).eq("clave", s.clave);
      if (error) { $("settingsMsg").textContent = CA.errorMsg(error); return; }
    }
    $("settingsMsg").className = "form-msg ok";
    $("settingsMsg").textContent = "Configuración guardada ✓";
    await runAgent(); updateBadges();
  });

  $("view-settings").addEventListener("click", async e => {
    const c = e.target.closest("[data-coupon]"), p = e.target.closest("[data-pay]");
    if (c) { const { error } = await db.from("cupones").update({ activo: c.dataset.on !== "true" }).eq("id", Number(c.dataset.coupon)); if (error) fail(error); loadSettings(); }
    if (p) { const { error } = await db.from("metodos_pago").update({ activo: p.dataset.on !== "true" }).eq("codigo", p.dataset.pay); if (error) fail(error); loadSettings(); }
  });

  $("newCoupon").addEventListener("click", () => openDialog({
    title: "Nuevo cupón",
    body: `<div class="form-grid">
      <label>Código<input name="codigo" required maxlength="30" pattern="[A-Za-z0-9_-]+" placeholder="VERANO15"></label>
      <label>Descuento (%)<input type="number" name="descuento" min="1" max="100" step="0.5" required></label>
      <label class="full">Descripción<input name="descripcion" maxlength="150"></label>
      <label>Vence (opcional)<input type="date" name="expira"></label></div>`,
    async onSubmit(f) {
      const el = f.elements;
      const { error } = await db.from("cupones").insert({ codigo: el.codigo.value.trim().toUpperCase(), descuento: Number(el.descuento.value),
        descripcion: el.descripcion.value.trim() || null, expira_en: el.expira.value ? new Date(el.expira.value + "T23:59:59").toISOString() : null });
      if (error) return CA.errorMsg(error);
      toast("Cupón creado ✓", "ok");
      loadSettings();
      return true;
    }
  }));

  // =================================================================
  // INICIO
  // =================================================================
  if (!db) {
    $("loginMsg").textContent = "Configura config.js con la URL y la anon key de tu proyecto de Supabase.";
  } else {
    db.auth.getSession().then(({ data }) => { if (data.session) enter(data.session.user, true); });
  }
})();
