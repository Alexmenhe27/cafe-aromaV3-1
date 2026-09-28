// =====================================================================
// Café Aroma — utilidades compartidas (sitio del cliente y panel admin)
// =====================================================================
(function () {
  const cfg = window.CAFE_AROMA_CONFIG || {};
  const listo = Boolean(
    cfg.url && cfg.anonKey &&
    !String(cfg.url).includes("TU_") && !String(cfg.anonKey).includes("TU_") &&
    window.supabase
  );
  const db = listo ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;
  const fmtMoney = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

  const ESTADOS = {
    nuevo:          { nombre: "Nuevo",          icono: "🆕" },
    confirmado:     { nombre: "Confirmado",     icono: "✅" },
    en_preparacion: { nombre: "En preparación", icono: "👨‍🍳" },
    listo:          { nombre: "Listo",          icono: "🛎️" },
    entregado:      { nombre: "Entregado",      icono: "📦" },
    cancelado:      { nombre: "Cancelado",      icono: "✖️" }
  };

  function num(v) {
    const n = Number(v || 0);
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }

  window.CA = {
    db,
    listo,
    ESTADOS,
    FLUJO: ["nuevo", "confirmado", "en_preparacion", "listo", "entregado"],

    money: v => fmtMoney.format(Number(v || 0)),

    esc: s => String(s ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),

    fecha: d => d ? new Date(d).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" }) : "—",
    hora: d => d ? new Date(d).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) : "—",

    // Igual que formato_cantidad() en SQL: 3000 ml -> "3 L"
    cantidad(n, unidad) {
      const v = Number(n || 0);
      if (unidad === "g" && Math.abs(v) >= 1000) return num(v / 1000) + " kg";
      if (unidad === "ml" && Math.abs(v) >= 1000) return num(v / 1000) + " L";
      if (unidad === "l") return num(v) + " L";
      if (unidad === "pieza") return num(v) + (v === 1 ? " pieza" : " piezas");
      if (unidad === "unidad") return num(v) + (v === 1 ? " unidad" : " unidades");
      return num(v) + " " + (unidad || "");
    },

    estadoBadge(codigo) {
      const e = ESTADOS[codigo] || { nombre: codigo, icono: "•" };
      return `<span class="status-badge ${CA.esc(codigo)}">${e.icono} ${e.nombre}</span>`;
    },

    // Mensaje de error entendible a partir de un error de Supabase
    errorMsg(err) {
      if (!err) return "Ocurrió un error.";
      const m = err.message || String(err);
      if (/Failed to fetch|NetworkError/i.test(m)) return "Sin conexión con el servidor. Revisa tu internet.";
      if (/JWT|session/i.test(m)) return "Tu sesión expiró. Vuelve a iniciar sesión.";
      if (/administrador|42501|permission denied/i.test(m)) return "No tienes permiso para esta acción.";
      return m;
    }
  };
})();
