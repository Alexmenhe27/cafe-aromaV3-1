// =====================================================================
// Café Aroma — sitio del cliente
// Menú con disponibilidad real · carrito · pedido · resumen · seguimiento
// cuenta del cliente (perfil, pedidos, favoritos, promos, avisos)
// =====================================================================
(function () {
  const { db, money, esc } = CA;
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------
  let products = [];              // viene de obtener_menu() en Supabase
  let categories = [];
  let selectedCategory = null;
  let shippingCost = 20;          // se lee de configuracion.costo_envio
  let paymentMethods = [];
  let menuLoaded = false;
  let blockedIds = new Set();     // productos del carrito sin insumos suficientes
  let cart = readJSON("cafeAromaCart", []);            // [{id, qty}]
  let favoriteIds = new Set(readJSON("cafeAromaFavorites", []).map(Number));
  let currentUser = null;
  let currentProfile = null;
  let trackCode = null;
  let trackTimer = null;
  let userChannel = null;

  const menuGrid = $("menuGrid");
  const cartBody = $("cartBody");
  const cartDrawer = $("cartDrawer");
  const cartOverlay = $("cartOverlay");
  const checkoutBtn = $("checkoutBtn");
  const checkoutModal = $("checkoutModal");
  const checkoutForm = $("checkoutForm");

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* almacenamiento no disponible */ }
  }

  let toastTimeout;
  function showToast(message) {
    const toast = $("toast");
    clearTimeout(toastTimeout);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimeout = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function openModal(id) {
    const m = $(id);
    m.classList.add("open");
    m.setAttribute("aria-hidden", "false");
  }
  function closeModal(id) {
    const m = $(id);
    m.classList.remove("open");
    m.setAttribute("aria-hidden", "true");
    if (id === "trackModal") stopTrackRefresh();
  }
  document.addEventListener("click", e => {
    const c = e.target.closest("[data-close]");
    if (c) closeModal(c.dataset.close);
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    ["summaryModal", "trackModal"].forEach(id => $(id).classList.contains("open") && closeModal(id));
  });

  // ---------------------------------------------------------------
  // Menú (desde Supabase, con disponibilidad calculada por insumos)
  // ---------------------------------------------------------------
  async function loadMenu() {
    if (!db) return;
    const firstLoad = !menuLoaded;
    const requests = [db.rpc("obtener_menu")];
    if (firstLoad) {
      requests.push(db.from("configuracion").select("clave,valor").eq("publica", true));
      requests.push(db.from("metodos_pago").select("codigo,nombre,icono").eq("activo", true).order("orden"));
    }
    const [menuRes, cfgRes, payRes] = await Promise.all(requests);

    if (menuRes.error) {
      console.error(menuRes.error);
      if (!menuLoaded) {
        menuGrid.innerHTML = `<div class="menu-empty">No se pudo cargar el menú: ${esc(CA.errorMsg(menuRes.error))}<br>¿Ya ejecutaste el SQL de la V3 en Supabase?</div>`;
        $("menuStatus").textContent = "";
      }
      return;
    }

    products = (menuRes.data || []).map(p => ({
      id: Number(p.id),
      category: p.categoria_slug,
      categoryName: p.categoria_nombre,
      categoryIcon: p.categoria_icono || "",
      name: p.nombre,
      description: p.descripcion,
      price: Number(p.precio),
      image: p.imagen,
      available: p.disponible === true
    }));

    categories = [];
    products.forEach(p => {
      if (!categories.find(c => c.slug === p.category)) {
        categories.push({ slug: p.category, name: p.categoryName, icon: p.categoryIcon });
      }
    });

    if (cfgRes && cfgRes.data) {
      const envio = cfgRes.data.find(x => x.clave === "costo_envio");
      if (envio && !isNaN(Number(envio.valor))) shippingCost = Number(envio.valor);
    }
    if (payRes && payRes.data && payRes.data.length) {
      paymentMethods = payRes.data;
      $("paymentSelect").innerHTML = paymentMethods
        .map(m => `<option value="${esc(m.codigo)}">${esc(m.icono || "")} ${esc(m.nombre)}</option>`).join("");
    }

    if (!selectedCategory || !categories.find(c => c.slug === selectedCategory)) {
      selectedCategory = categories[0]?.slug || null;
    }
    // Si un producto vuelve a estar disponible, se quita la marca del carrito
    blockedIds.forEach(id => { const p = getProduct(id); if (p && p.available) blockedIds.delete(id); });

    menuLoaded = true;
    renderTabs();
    renderMenu();
    updateCart();
  }

  function renderTabs() {
    $("categoryTabs").innerHTML = categories.map(c => `
      <button class="tab-btn ${c.slug === selectedCategory ? "active" : ""}" data-category="${esc(c.slug)}">
        ${esc(c.icon)} ${esc(c.name)}
      </button>`).join("");
  }

  function getProduct(id) {
    return products.find(product => product.id === id);
  }

  function renderMenu() {
    if (!menuLoaded) return;
    const hide = $("hideSoldOut").checked;
    const inCategory = products.filter(p => p.category === selectedCategory);
    const list = hide ? inCategory.filter(p => p.available) : inCategory;
    const soldOut = inCategory.filter(p => !p.available).length;

    $("menuStatus").innerHTML = inCategory.length
      ? `☕ <b>${inCategory.length - soldOut}</b> disponibles${soldOut ? ` · <b>${soldOut}</b> agotado${soldOut > 1 ? "s" : ""}` : ""}`
      : "";

    if (!list.length) {
      menuGrid.innerHTML = `<div class="menu-empty">${products.length
        ? "No hay productos disponibles en esta categoría por ahora."
        : "El menú está vacío. El administrador puede agregar productos desde el panel."}</div>`;
      return;
    }

    menuGrid.innerHTML = list.map(product => {
      const fav = favoriteIds.has(product.id);
      return `
      <article class="product-card ${product.available ? "" : "agotado"}">
        <div class="product-media">
          <img src="${esc(product.image || "")}" alt="${esc(product.name)}" loading="lazy" />
          ${product.available ? "" : '<span class="sold-out">Agotado</span>'}
        </div>
        <div class="product-content">
          <h3>${esc(product.name)}</h3>
          <p>${esc(product.description)}</p>
          <div class="product-bottom">
            <span class="price">${money(product.price)}</span>
            <div class="product-actions">
              <button class="favorite-btn ${fav ? "active" : ""}" data-favorite="${product.id}" aria-label="Favorito">${fav ? "♥" : "♡"}</button>
              <button class="add-btn" data-add="${product.id}" aria-label="Agregar ${esc(product.name)}" ${product.available ? "" : "disabled"}>
                ${product.available ? "🛒 Agregar" : "Agotado"}
              </button>
            </div>
          </div>
        </div>
      </article>`;
    }).join("");
  }

  $("categoryTabs").addEventListener("click", event => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    selectedCategory = button.dataset.category;
    renderTabs();
    renderMenu();
  });
  $("hideSoldOut").addEventListener("change", renderMenu);

  // ---------------------------------------------------------------
  // Carrito (se conserva en este dispositivo)
  // ---------------------------------------------------------------
  function saveCart() {
    writeJSON("cafeAromaCart", cart);
  }

  function addToCart(productId) {
    const product = getProduct(productId);
    if (!product || !product.available) {
      showToast("Este producto está agotado por ahora.");
      return;
    }
    const existing = cart.find(item => item.id === productId);
    if (existing) {
      if (existing.qty >= 50) { showToast("Máximo 50 piezas por producto."); return; }
      existing.qty += 1;
    } else {
      cart.push({ id: productId, qty: 1 });
    }
    saveCart();
    updateCart();
    showToast("Producto agregado al carrito.");
  }

  function changeQuantity(productId, delta) {
    const item = cart.find(i => i.id === productId);
    if (!item) return;
    item.qty = Math.min(50, item.qty + delta);
    if (item.qty <= 0) cart = cart.filter(i => i.id !== productId);
    if (delta < 0) blockedIds.delete(productId);
    saveCart();
    updateCart();
  }

  function removeFromCart(productId) {
    cart = cart.filter(item => item.id !== productId);
    blockedIds.delete(productId);
    saveCart();
    updateCart();
    showToast("Producto eliminado.");
  }

  function getCartTotals() {
    const subtotal = cart.reduce((sum, item) => {
      const product = getProduct(item.id);
      return sum + (product ? product.price * item.qty : 0);
    }, 0);
    const shipping = subtotal > 0 ? shippingCost : 0;
    return { subtotal, shipping, total: subtotal + shipping };
  }

  function cartProblems() {
    return cart.filter(item => {
      const p = getProduct(item.id);
      return !p || !p.available || blockedIds.has(item.id);
    });
  }

  function updateCart() {
    const itemCount = cart.reduce((sum, item) => sum + item.qty, 0);
    const totals = getCartTotals();

    $("cartCount").textContent = itemCount;
    $("subtotal").textContent = money(totals.subtotal);
    $("shipping").textContent = money(totals.shipping);
    $("total").textContent = money(totals.total);

    const problems = menuLoaded ? cartProblems() : [];
    checkoutBtn.disabled = cart.length > 0 && problems.length > 0;
    $("cartNote").textContent = problems.length
      ? "Retira o ajusta los productos marcados para continuar."
      : "Al finalizar, se mostrará un resumen de tu pedido.";

    if (cart.length === 0) {
      cartBody.innerHTML = `
        <div class="empty-cart">
          <div>
            <div style="font-size: 3rem; margin-bottom: 10px;">🛒</div>
            <strong>Tu carrito está vacío</strong>
            <p>Agrega algo delicioso desde nuestro menú.</p>
          </div>
        </div>`;
      return;
    }

    cartBody.innerHTML = cart.map(item => {
      const product = getProduct(item.id);
      if (!product) {
        if (!menuLoaded) return "";
        return `
          <div class="cart-item sin-stock">
            <div></div>
            <div class="cart-item-info"><h3>Producto no disponible</h3>
              <p class="cart-warning">Ya no está en el menú. Retíralo para continuar.</p></div>
            <button class="remove-item" data-remove="${item.id}" aria-label="Eliminar">🗑</button>
          </div>`;
      }
      const warn = !product.available
        ? "Agotado: no hay insumos para prepararlo."
        : blockedIds.has(item.id) ? "No hay insumos para esta cantidad. Reduce la cantidad." : "";
      return `
        <div class="cart-item ${warn ? "sin-stock" : ""}">
          <img src="${esc(product.image || "")}" alt="${esc(product.name)}">
          <div class="cart-item-info">
            <h3>${esc(product.name)}</h3>
            <p>${money(product.price)} c/u</p>
            ${warn ? `<p class="cart-warning">${warn}</p>` : ""}
            <div class="qty-controls">
              <button class="qty-btn" data-minus="${product.id}" aria-label="Disminuir cantidad">−</button>
              <span class="qty-value">${item.qty}</span>
              <button class="qty-btn" data-plus="${product.id}" aria-label="Aumentar cantidad">+</button>
            </div>
          </div>
          <button class="remove-item" data-remove="${product.id}" aria-label="Eliminar ${esc(product.name)}">🗑</button>
        </div>`;
    }).join("");
  }

  function openCart() {
    cartDrawer.classList.add("open");
    cartOverlay.classList.add("show");
    document.body.classList.add("cart-open");
    loadMenu(); // refresca disponibilidad al abrir el carrito
  }
  function closeCart() {
    cartDrawer.classList.remove("open");
    cartOverlay.classList.remove("show");
    document.body.classList.remove("cart-open");
  }

  menuGrid.addEventListener("click", async event => {
    const add = event.target.closest("[data-add]");
    if (add) { addToCart(Number(add.dataset.add)); return; }
    const fav = event.target.closest("[data-favorite]");
    if (fav) { event.preventDefault(); await toggleFavorite(Number(fav.dataset.favorite)); }
  });

  cartBody.addEventListener("click", event => {
    const minus = event.target.closest("[data-minus]");
    const plus = event.target.closest("[data-plus]");
    const remove = event.target.closest("[data-remove]");
    if (minus) changeQuantity(Number(minus.dataset.minus), -1);
    if (plus) changeQuantity(Number(plus.dataset.plus), 1);
    if (remove) removeFromCart(Number(remove.dataset.remove));
  });

  $("openCart").addEventListener("click", openCart);
  $("closeCart").addEventListener("click", closeCart);
  cartOverlay.addEventListener("click", closeCart);

  $("heroOrderBtn").addEventListener("click", () => {
    $("menu").scrollIntoView({ behavior: "smooth" });
  });

  // ---------------------------------------------------------------
  // Checkout: verificar inventario → datos → crear pedido → resumen
  // ---------------------------------------------------------------
  function itemsPayload() {
    return cart.map(item => ({ product_id: item.id, quantity: item.qty }));
  }

  checkoutBtn.addEventListener("click", async () => {
    if (cart.length === 0) { showToast("Agrega al menos un producto antes de finalizar."); return; }
    if (!db) { showToast("El sitio aún no está conectado a Supabase."); return; }

    checkoutBtn.disabled = true;
    checkoutBtn.textContent = "Verificando inventario...";
    const { data, error } = await db.rpc("verificar_carrito", { p_items: itemsPayload() });
    checkoutBtn.textContent = "🛍 Finalizar Pedido";
    checkoutBtn.disabled = false;

    if (error) { showToast(CA.errorMsg(error)); return; }
    if (!data.ok) {
      data.no_disponibles.forEach(x => blockedIds.add(Number(x.producto_id)));
      await loadMenu();
      showToast("Sin insumos suficientes para: " + data.no_disponibles.map(x => x.nombre).join(", ") + ".");
      return;
    }
    openCheckout();
  });

  function openCheckout() {
    const totals = getCartTotals();
    $("checkoutLines").innerHTML = cart.map(item => {
      const p = getProduct(item.id);
      return p ? `<div><span>${item.qty}× ${esc(p.name)}</span><span>${money(p.price * item.qty)}</span></div>` : "";
    }).join("") + `<div><span>Envío</span><span>${money(totals.shipping)}</span></div>`;
    $("checkoutTotal").textContent = money(totals.total);
    $("checkoutMsg").textContent = "";

    // Prellenar datos: perfil del cliente con sesión o los últimos datos usados en este dispositivo
    const f = checkoutForm.elements;
    const saved = readJSON("cafeAromaCliente", {});
    if (currentProfile) {
      f.name.value = currentProfile.nombre || f.name.value;
      f.phone.value = currentProfile.telefono || f.phone.value;
      f.email.value = currentUser?.email || f.email.value;
    } else {
      if (!f.name.value) f.name.value = saved.nombre || "";
      if (!f.phone.value) f.phone.value = saved.telefono || "";
      if (!f.email.value) f.email.value = saved.email || "";
    }
    checkoutModal.classList.add("open");
    checkoutModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("cart-open");
  }

  function closeCheckout() {
    checkoutModal.classList.remove("open");
    checkoutModal.setAttribute("aria-hidden", "true");
  }
  $("closeCheckout").addEventListener("click", closeCheckout);
  $("checkoutBackdrop").addEventListener("click", closeCheckout);

  checkoutForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = checkoutForm.querySelector("button[type=submit]");
    const msg = $("checkoutMsg");
    const f = checkoutForm.elements;
    const paymentCode = f.payment_method.value;

    submit.disabled = true;
    submit.textContent = "Registrando pedido...";
    msg.textContent = "";
    msg.className = "form-msg";

    const snapshot = cart.map(item => {
      const p = getProduct(item.id);
      return { name: p ? p.name : "Producto", qty: item.qty, price: p ? p.price : 0 };
    });

    try {
      const { data, error } = await db.rpc("crear_pedido", {
        p_nombre: f.name.value.trim(),
        p_telefono: f.phone.value.trim(),
        p_email: f.email.value.trim() || null,
        p_notas: f.notes.value.trim() || null,
        p_metodo_pago: paymentCode,
        p_items: itemsPayload(),
        p_cupon: f.coupon.value.trim() || null
      });
      if (error) throw error;

      if (!data.ok) {
        msg.textContent = data.mensaje || "No se pudo registrar el pedido.";
        if (data.error === "sin_inventario") {
          (data.no_disponibles || []).forEach(x => blockedIds.add(Number(x.producto_id)));
          await loadMenu();
        }
        return;
      }

      saveRecentOrder(data.codigo, data.total);
      writeJSON("cafeAromaCliente", { nombre: f.name.value.trim(), telefono: f.phone.value.trim(), email: f.email.value.trim() });
      cart = [];
      blockedIds.clear();
      saveCart();
      updateCart();
      f.notes.value = "";
      f.coupon.value = "";
      closeCheckout();
      closeCart();
      const method = paymentMethods.find(m => m.codigo === paymentCode);
      showSummary(data, snapshot, method ? method.nombre : paymentCode);
      loadMenu();
      if (currentUser) loadProfile();
    } catch (error) {
      console.error(error);
      msg.textContent = CA.errorMsg(error);
    } finally {
      submit.disabled = false;
      submit.textContent = "☕ Confirmar pedido";
    }
  });

  function showSummary(order, items, paymentName) {
    $("summaryCode").textContent = order.codigo;
    $("summaryBody").innerHTML = `
      <p><b>Pedido #${order.pedido_id}</b> · ${CA.estadoBadge(order.estado)}</p>
      <ul class="order-items">
        ${items.map(i => `<li><span>${i.qty}× ${esc(i.name)}</span><span>${money(i.price * i.qty)}</span></li>`).join("")}
      </ul>
      <div class="checkout-lines">
        <div><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
        ${Number(order.descuento) > 0 ? `<div><span>Descuento</span><span>− ${money(order.descuento)}</span></div>` : ""}
        <div><span>Envío</span><span>${money(order.envio)}</span></div>
        <div><span>Método de pago</span><span>${esc(paymentName)}</span></div>
        <div class="total"><span>Total</span><span>${money(order.total)}</span></div>
      </div>`;
    $("summaryTrack").onclick = () => { closeModal("summaryModal"); openTrack(order.codigo); };
    openModal("summaryModal");
  }

  $("copyCode").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("summaryCode").textContent);
      showToast("Código copiado.");
    } catch {
      showToast("Anota tu código: " + $("summaryCode").textContent);
    }
  });

  // ---------------------------------------------------------------
  // Seguimiento del pedido
  // ---------------------------------------------------------------
  function saveRecentOrder(code, total) {
    const list = readJSON("cafeAromaPedidos", []).filter(x => x.codigo !== code);
    list.unshift({ codigo: code, total, fecha: new Date().toISOString() });
    writeJSON("cafeAromaPedidos", list.slice(0, 10));
  }

  function renderRecent() {
    const list = readJSON("cafeAromaPedidos", []);
    $("recentOrders").innerHTML = list.length
      ? `<p class="muted-small">Pedidos hechos en este dispositivo:</p>
         <div class="recent-codes">${list.map(x => `<button type="button" data-code="${esc(x.codigo)}">${esc(x.codigo)} · ${new Date(x.fecha).toLocaleDateString("es-MX")}</button>`).join("")}</div>`
      : "";
  }

  function openTrack(code) {
    renderRecent();
    $("trackResult").innerHTML = "";
    openModal("trackModal");
    if (code) {
      $("trackForm").elements.code.value = code;
      consultOrder(code);
    }
  }

  $("trackBtn").addEventListener("click", () => openTrack());
  $("recentOrders").addEventListener("click", e => {
    const b = e.target.closest("[data-code]");
    if (!b) return;
    $("trackForm").elements.code.value = b.dataset.code;
    consultOrder(b.dataset.code);
  });
  $("trackForm").addEventListener("submit", e => {
    e.preventDefault();
    consultOrder(e.currentTarget.elements.code.value);
  });

  function stopTrackRefresh() {
    clearInterval(trackTimer);
    trackTimer = null;
  }

  async function consultOrder(code, silent) {
    code = String(code || "").trim().toUpperCase();
    if (!code) return;
    if (!db) { $("trackResult").innerHTML = '<p class="form-msg">El sitio no está conectado a Supabase.</p>'; return; }
    trackCode = code;
    if (!silent) $("trackResult").innerHTML = '<p class="muted-small">Consultando...</p>';
    const { data, error } = await db.rpc("consultar_pedido", { p_codigo: code });
    if (error) { $("trackResult").innerHTML = `<p class="form-msg">${esc(CA.errorMsg(error))}</p>`; return; }
    if (!data) { $("trackResult").innerHTML = '<p class="form-msg">No encontramos un pedido con ese código. Revísalo e intenta de nuevo.</p>'; stopTrackRefresh(); return; }
    renderTrack(data);

    // Actualización automática mientras el pedido siga en curso
    stopTrackRefresh();
    if (!["entregado", "cancelado"].includes(data.estado)) {
      trackTimer = setInterval(() => {
        if ($("trackModal").classList.contains("open")) consultOrder(trackCode, true);
        else stopTrackRefresh();
      }, 15000);
    }
  }

  function renderTrack(o) {
    const reached = {};
    (o.historial || []).forEach(h => { reached[h.estado] = h.fecha; });
    const currentIdx = CA.FLUJO.indexOf(o.estado);
    const cancelled = o.estado === "cancelado";

    const steps = CA.FLUJO.map((code, i) => {
      const done = cancelled ? Boolean(reached[code]) : i <= currentIdx;
      const e = CA.ESTADOS[code];
      return `<li class="${done ? "done" : ""} ${i === currentIdx ? "current" : ""}">
        <span class="dot">${done ? "✓" : e.icono}</span><span>${e.nombre}</span>
        <time>${reached[code] ? CA.hora(reached[code]) : ""}</time></li>`;
    }).join("");

    $("trackResult").innerHTML = `
      <div class="order-code"><div><span>Pedido #${o.id}</span><br><b>${esc(o.codigo)}</b></div>${CA.estadoBadge(o.estado)}</div>
      ${cancelled ? `<div class="cancel-banner">Este pedido fue cancelado (${CA.fecha(o.estado_actualizado_en)}).</div>` : `<ol class="timeline">${steps}</ol>`}
      <ul class="order-items">
        ${o.items.map(i => `<li><span>${i.cantidad}× ${esc(i.nombre)}</span><span>${money(i.subtotal)}</span></li>`).join("")}
      </ul>
      <div class="checkout-lines">
        ${Number(o.descuento) > 0 ? `<div><span>Descuento</span><span>− ${money(o.descuento)}</span></div>` : ""}
        <div><span>Envío</span><span>${money(o.envio)}</span></div>
        <div><span>Pago</span><span>${esc(o.metodo_pago)}</span></div>
        <div class="total"><span>Total</span><span>${money(o.total)}</span></div>
      </div>
      <p class="muted-small" style="margin-top:10px">Pedido realizado: ${CA.fecha(o.creado_en)} · Se actualiza automáticamente.</p>
      ${o.puede_cancelar ? '<div class="modal-actions"><button class="btn-danger" id="cancelMyOrder" type="button">Cancelar pedido</button></div>' : ""}`;

    const cancelBtn = $("cancelMyOrder");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", async () => {
        if (!cancelBtn.dataset.confirm) {
          cancelBtn.dataset.confirm = "1";
          cancelBtn.textContent = "¿Seguro? Toca otra vez para cancelar";
          return;
        }
        cancelBtn.disabled = true;
        const { data, error } = await db.rpc("cancelar_mi_pedido", { p_codigo: o.codigo });
        showToast(error ? CA.errorMsg(error) : data.mensaje);
        consultOrder(o.codigo, true);
        loadMenu();
      });
    }
  }

  // ---------------------------------------------------------------
  // Contacto
  // ---------------------------------------------------------------
  $("contactForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    if (!db) { showToast("No se pudo enviar: el sitio aún no está conectado."); return; }
    const { error } = await db.from("mensajes_contacto").insert({
      nombre: name,
      email: form.elements.email.value.trim(),
      mensaje: form.elements.message.value.trim()
    });
    if (error) { console.error(error); showToast("No se pudo enviar el mensaje. Inténtalo de nuevo."); return; }
    showToast(`¡Gracias ${name || "por escribirnos"}! Tu mensaje fue enviado.`);
    form.reset();
  });

  // ---------------------------------------------------------------
  // Navegación (menú móvil y enlace activo) — igual que la V2
  // ---------------------------------------------------------------
  const menuToggle = $("menuToggle");
  const navLinks = $("navLinks");
  menuToggle.addEventListener("click", () => navLinks.classList.toggle("open"));
  navLinks.addEventListener("click", event => {
    if (event.target.tagName === "A") navLinks.classList.remove("open");
  });
  const navAnchors = document.querySelectorAll(".nav-links a");
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      navAnchors.forEach(link => link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`));
    });
  }, { rootMargin: "-35% 0px -55% 0px" });
  document.querySelectorAll("main section[id]").forEach(section => observer.observe(section));

  // ---------------------------------------------------------------
  // Cuenta del cliente (V2): perfil, pedidos, favoritos, promos, avisos
  // ---------------------------------------------------------------
  const accountModal = $("accountModal");
  function openAccount() {
    accountModal.classList.add("open");
    accountModal.setAttribute("aria-hidden", "false");
    if (currentUser) showAccountUser(); else showAccountGuest("login");
  }
  function closeAccount() {
    accountModal.classList.remove("open");
    accountModal.setAttribute("aria-hidden", "true");
  }
  $("accountBtn").addEventListener("click", openAccount);
  $("closeAccount").addEventListener("click", closeAccount);
  $("accountBackdrop").addEventListener("click", closeAccount);

  function showAccountGuest(mode = "login") {
    $("accountGuest").classList.remove("hidden");
    $("accountUser").classList.add("hidden");
    document.querySelectorAll(".account-mode").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    document.querySelector('#accountForm [name="name"]').required = mode === "signup";
    document.querySelector('#accountForm [name="name"]').closest("label").style.display = mode === "signup" ? "block" : "none";
    $("accountPhoneLabel").style.display = mode === "signup" ? "block" : "none";
    $("accountSubmit").textContent = mode === "signup" ? "Crear cuenta" : "Entrar";
    $("accountMessage").textContent = "";
  }
  document.querySelectorAll(".account-mode").forEach(b => b.addEventListener("click", () => showAccountGuest(b.dataset.mode)));

  function showAccountUser() {
    $("accountGuest").classList.add("hidden");
    $("accountUser").classList.remove("hidden");
    loadProfile();
  }

  async function toggleFavorite(id) {
    const wasFav = favoriteIds.has(id);
    if (currentUser && db) {
      const { error } = wasFav
        ? await db.from("favoritos").delete().eq("user_id", currentUser.id).eq("producto_id", id)
        : await db.from("favoritos").insert({ user_id: currentUser.id, producto_id: id });
      if (error) { showToast(CA.errorMsg(error)); return; }
    }
    wasFav ? favoriteIds.delete(id) : favoriteIds.add(id);
    writeJSON("cafeAromaFavorites", [...favoriteIds]);
    renderMenu();
    showToast(wasFav ? "Eliminado de favoritos" : "Agregado a favoritos ❤️");
  }

  async function refreshFavoritesFromCloud() {
    if (!db || !currentUser) return;
    const { data } = await db.from("favoritos").select("producto_id").eq("user_id", currentUser.id);
    if (data) favoriteIds = new Set(data.map(x => Number(x.producto_id)));
    writeJSON("cafeAromaFavorites", [...favoriteIds]);
    renderMenu();
  }

  async function loadProfile() {
    if (!db || !currentUser) return;
    const { data: profile } = await db.from("perfiles").select("*").eq("user_id", currentUser.id).maybeSingle();
    if (!profile) {
      const fallbackName = currentUser.user_metadata?.nombre || currentUser.email.split("@")[0];
      await db.from("perfiles").upsert({ user_id: currentUser.id, nombre: fallbackName, telefono: currentUser.user_metadata?.telefono || "" });
      currentProfile = { nombre: fallbackName, telefono: "", direccion: "" };
    } else {
      currentProfile = profile;
    }
    $("profileName").textContent = currentProfile.nombre || currentUser.email.split("@")[0];
    $("profileEmail").textContent = currentUser.email || "";
    $("profileAvatar").textContent = (currentProfile.nombre || "C").charAt(0).toUpperCase();
    const pf = $("profileForm").elements;
    pf.name.value = currentProfile.nombre || "";
    pf.phone.value = currentProfile.telefono || "";
    pf.address.value = currentProfile.direccion || "";

    const { data: orders } = await db.from("pedidos")
      .select("id,codigo_seguimiento,total,estado,creado_en")
      .eq("user_id", currentUser.id).order("creado_en", { ascending: false }).limit(50);
    const valid = (orders || []).filter(o => o.estado !== "cancelado");
    $("profileOrders").textContent = valid.length;
    $("profileSpent").textContent = money(valid.reduce((s, o) => s + Number(o.total || 0), 0));
    const { data: loyalty } = await db.from("puntos_cliente").select("puntos").eq("user_id", currentUser.id).maybeSingle();
    $("profilePoints").textContent = loyalty?.puntos || 0;

    await Promise.all([loadMyOrders(orders || []), loadMyFavorites(), loadMyPromos(), loadMyNotifications()]);
  }

  async function loadMyOrders(orders) {
    const box = $("myOrders");
    if (!orders.length) { box.innerHTML = '<div class="empty-profile">Todavía no tienes pedidos.</div>'; return; }
    const { data: details } = await db.from("detalle_pedidos").select("pedido_id,producto_nombre,cantidad").in("pedido_id", orders.map(o => o.id));
    box.innerHTML = orders.map(o => {
      const items = (details || []).filter(d => d.pedido_id === o.id).map(d => `${d.cantidad}× ${esc(d.producto_nombre)}`).join(", ");
      return `<div class="profile-row">
        <div><b>Pedido #${o.id}</b> <span class="small">${esc(o.codigo_seguimiento)}</span><br>
          <span class="small">${CA.fecha(o.creado_en)} · ${items}</span></div>
        <div class="row-actions">${CA.estadoBadge(o.estado)}<b>${money(o.total)}</b>
          <button class="link" data-track="${esc(o.codigo_seguimiento)}">Ver estado</button></div>
      </div>`;
    }).join("");
    box.querySelectorAll("[data-track]").forEach(b => b.onclick = () => { closeAccount(); openTrack(b.dataset.track); });
  }

  async function loadMyFavorites() {
    const box = $("myFavorites");
    const favProducts = products.filter(p => favoriteIds.has(p.id));
    if (!favProducts.length) { box.innerHTML = '<div class="empty-profile">Aún no tienes favoritos. Usa ♡ en el menú.</div>'; return; }
    box.innerHTML = favProducts.map(p => `<div class="profile-row">
      <div><b>${esc(p.name)}</b><br><span class="small">${esc(p.description)}</span></div>
      <div class="row-actions"><b>${money(p.price)}</b>
        ${p.available ? `<button data-reorder="${p.id}">Agregar</button>` : '<span class="status-badge cancelado">Agotado</span>'}</div>
    </div>`).join("");
    box.querySelectorAll("[data-reorder]").forEach(b => b.onclick = () => addToCart(Number(b.dataset.reorder)));
  }

  async function loadMyPromos() {
    const box = $("myPromos");
    const { data } = await db.from("cupones").select("*").eq("activo", true).order("creado_en", { ascending: false });
    box.innerHTML = (data || []).length
      ? data.map(c => `<div class="profile-row"><div><b>${esc(c.codigo)}</b><br><span class="small">${esc(c.descripcion || "Promoción especial")} · Escríbelo al finalizar tu pedido.</span></div><div><span class="badge">${Number(c.descuento)}% OFF</span></div></div>`).join("")
      : '<div class="empty-profile">No hay promociones disponibles.</div>';
  }

  async function loadMyNotifications() {
    const box = $("myNotifications");
    const { data } = await db.from("notificaciones").select("*").eq("user_id", currentUser.id).order("creado_en", { ascending: false }).limit(20);
    box.innerHTML = (data || []).length
      ? data.map(n => `<div class="profile-row"><div><b>${esc(n.titulo)}</b><br><span class="small">${esc(n.mensaje)}</span></div><span class="small">${CA.fecha(n.creado_en)}</span></div>`).join("")
      : '<div class="empty-profile">No tienes avisos.</div>';
    if (data?.some(n => !n.leida)) await db.from("notificaciones").update({ leida: true }).eq("user_id", currentUser.id).eq("leida", false);
  }

  $("accountForm").addEventListener("submit", async e => {
    e.preventDefault();
    const msg = $("accountMessage");
    if (!db) { msg.textContent = "Configura Supabase primero."; return; }
    const f = e.currentTarget;
    const mode = document.querySelector(".account-mode.active").dataset.mode;
    const email = f.elements.email.value.trim();
    const password = f.elements.password.value;
    msg.textContent = "Procesando...";
    try {
      if (mode === "signup") {
        const { data, error } = await db.auth.signUp({
          email, password,
          options: { data: { nombre: f.elements.name.value.trim(), telefono: f.elements.phone.value.trim() } }
        });
        if (error) throw error;
        msg.textContent = data.session ? "Cuenta creada correctamente." : "Cuenta creada. Revisa tu correo si la confirmación está activada.";
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        closeAccount();
      }
    } catch (err) {
      msg.textContent = CA.errorMsg(err);
    }
  });

  $("profileForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.currentTarget;
    const { error } = await db.from("perfiles").update({
      nombre: f.elements.name.value.trim(),
      telefono: f.elements.phone.value.trim(),
      direccion: f.elements.address.value.trim()
    }).eq("user_id", currentUser.id);
    showToast(error ? "No se pudieron guardar los cambios" : "Perfil actualizado ✓");
    if (!error) loadProfile();
  });

  document.querySelectorAll(".profile-tab").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".profile-tab").forEach(x => x.classList.toggle("active", x === b));
    document.querySelectorAll(".profile-section").forEach(x => x.classList.add("hidden"));
    const tab = b.dataset.profileTab;
    $("profile" + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.remove("hidden");
  }));

  $("accountLogout").addEventListener("click", async () => {
    if (db) await db.auth.signOut();
    closeAccount();
  });

  // Tiempo real: el cliente con sesión recibe los cambios de estado de sus pedidos
  function subscribeUserOrders() {
    if (!db || !currentUser || userChannel) return;
    userChannel = db.channel("mis-pedidos-" + currentUser.id)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "pedidos", filter: `user_id=eq.${currentUser.id}` },
        payload => {
          const p = payload.new;
          if (!payload.old || payload.old.estado !== p.estado) {
            showToast(`Tu pedido #${p.id} ahora está: ${(CA.ESTADOS[p.estado] || {}).nombre || p.estado}`);
          }
          if (trackCode && trackCode === p.codigo_seguimiento) consultOrder(trackCode, true);
          if (accountModal.classList.contains("open")) loadProfile();
        })
      .subscribe();
  }

  function onSession(session) {
    const before = currentUser?.id;
    currentUser = session?.user || null;
    $("accountLabel").textContent = currentUser ? "Mi perfil" : "Mi cuenta";
    if (currentUser && before !== currentUser.id) {
      loadProfile();
      refreshFavoritesFromCloud();
      subscribeUserOrders();
    }
    if (!currentUser) {
      currentProfile = null;
      if (userChannel) { db.removeChannel(userChannel); userChannel = null; }
    }
  }

  // ---------------------------------------------------------------
  // Inicio
  // ---------------------------------------------------------------
  updateCart();
  if (!db) {
    $("configBanner").classList.remove("hidden");
    $("menuStatus").textContent = "";
    menuGrid.innerHTML = '<div class="menu-empty">⚙️ Conecta Supabase en <b>config.js</b> para mostrar el menú real y recibir pedidos.</div>';
  } else {
    loadMenu();
    setInterval(loadMenu, 60000);                          // disponibilidad al día
    window.addEventListener("focus", () => loadMenu());
    db.auth.getSession().then(({ data }) => onSession(data.session));
    db.auth.onAuthStateChange((_event, session) => onSession(session));
  }
})();
