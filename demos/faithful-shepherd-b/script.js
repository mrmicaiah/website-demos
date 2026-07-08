/* =============================================================
   The Faithful Shepherd — Concept 2 (Editorial / Lookbook)
   Same catalog + mock cart as Concept A, editorial product layout.
   Vanilla JS, in-memory cart. No backend, no build step.
   ============================================================= */
(function () {
  "use strict";

  /* ---------- Product catalog (identical to Concept A) ---------- */
  var PRODUCTS = [
    {
      id: "p1",
      name: "The Shepherd Tee",
      price: 34,
      art: "shepherd-tee",
      blurb: "Heavyweight cotton tee bearing the mountain-and-shepherd lockup.",
    },
    {
      id: "p2",
      name: "Psalm 23 Hoodie",
      price: 62,
      art: "hoodie",
      blurb: 'Premium heavyweight fleece embroidered "He Restores My Soul."',
    },
    {
      id: "p3",
      name: "Still Waters Long Sleeve",
      price: 42,
      art: "longsleeve",
      blurb: "Vintage-washed long sleeve with an understated crook emblem.",
    },
    {
      id: "p4",
      name: "Green Pastures Crewneck",
      price: 56,
      art: "crewneck",
      blurb: "Sueded fleece crewneck for cool mornings and long roads.",
    },
    {
      id: "p5",
      name: "The Rod & Staff Cap",
      price: 28,
      art: "cap",
      blurb: "Structured cap with an embroidered shepherd's crook.",
    },
    {
      id: "p6",
      name: "Faith Family Freedom Tee",
      price: 34,
      art: "fff-tee",
      blurb: "Flag-and-faith graphic tee honoring what we stand for.",
    },
  ];

  var byId = {};
  PRODUCTS.forEach(function (p) {
    byId[p.id] = p;
  });

  /* ---------- Cart state (in-memory) ---------- */
  var cart = []; // { id, qty }

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var list = $("#productList");
  var overlay = $("#overlay");
  var drawer = $("#cartDrawer");
  var cartOpenBtn = $("#cartOpen");
  var cartCloseBtn = $("#cartClose");
  var cartCountEl = $("#cartCount");
  var cartItemsEl = $("#cartItems");
  var cartEmptyEl = $("#cartEmpty");
  var subtotalEl = $("#cartSubtotal");
  var checkoutBtn = $("#checkoutBtn");
  var checkoutNote = $("#checkoutNote");
  var lastFocused = null;

  function money(n) {
    return "$" + n;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  /* ---------- Render editorial product rows ---------- */
  function renderProducts() {
    list.innerHTML = PRODUCTS.map(function (p, i) {
      return (
        '<article class="feature">' +
        '<div class="feature__media product-media" data-art="' +
        p.art +
        '" role="img" aria-label="' +
        escapeHtml(p.name) +
        ' — stylized product mockup">' +
        '<span class="product-media__name">' +
        escapeHtml(p.name) +
        "</span>" +
        "</div>" +
        '<div class="feature__info">' +
        '<span class="feature__index">' +
        pad2(i + 1) +
        " / " +
        pad2(PRODUCTS.length) +
        "</span>" +
        '<h3 class="feature__name">' +
        escapeHtml(p.name) +
        "</h3>" +
        '<p class="feature__blurb">' +
        escapeHtml(p.blurb) +
        "</p>" +
        '<div class="feature__buy">' +
        '<span class="price">' +
        money(p.price) +
        "</span>" +
        '<button class="btn btn--dark" data-add="' +
        p.id +
        '" aria-label="Add ' +
        escapeHtml(p.name) +
        ' to cart">Add to Cart</button>' +
        "</div>" +
        "</div>" +
        "</article>"
      );
    }).join("");
  }

  /* ---------- Cart operations ---------- */
  function addToCart(id) {
    if (!byId[id]) return;
    var line = null;
    for (var i = 0; i < cart.length; i++) {
      if (cart[i].id === id) {
        line = cart[i];
        break;
      }
    }
    if (line) {
      line.qty += 1;
    } else {
      cart.push({ id: id, qty: 1 });
    }
    renderCart();
    bumpCount();
    openCart();
  }

  function changeQty(id, delta) {
    for (var i = 0; i < cart.length; i++) {
      if (cart[i].id === id) {
        cart[i].qty += delta;
        if (cart[i].qty <= 0) {
          cart.splice(i, 1);
        }
        break;
      }
    }
    renderCart();
  }

  function removeLine(id) {
    cart = cart.filter(function (l) {
      return l.id !== id;
    });
    renderCart();
  }

  function totalCount() {
    return cart.reduce(function (sum, l) {
      return sum + l.qty;
    }, 0);
  }

  function subtotal() {
    return cart.reduce(function (sum, l) {
      return sum + byId[l.id].price * l.qty;
    }, 0);
  }

  /* ---------- Render cart UI ---------- */
  function renderCart() {
    var count = totalCount();
    cartCountEl.textContent = count;
    cartCountEl.classList.toggle("is-visible", count > 0);

    if (cart.length === 0) {
      cartItemsEl.innerHTML = "";
      cartEmptyEl.hidden = false;
    } else {
      cartEmptyEl.hidden = true;
      cartItemsEl.innerHTML = cart
        .map(function (l) {
          var p = byId[l.id];
          return (
            '<div class="cart-item">' +
            '<div class="cart-item__thumb" data-art="' +
            p.art +
            '" aria-hidden="true"></div>' +
            '<div class="cart-item__info">' +
            '<div class="cart-item__name">' +
            escapeHtml(p.name) +
            "</div>" +
            '<div class="cart-item__price">' +
            money(p.price) +
            "</div>" +
            '<div class="qty">' +
            '<button data-dec="' +
            p.id +
            '" aria-label="Decrease quantity of ' +
            escapeHtml(p.name) +
            '">&minus;</button>' +
            "<span>" +
            l.qty +
            "</span>" +
            '<button data-inc="' +
            p.id +
            '" aria-label="Increase quantity of ' +
            escapeHtml(p.name) +
            '">+</button>' +
            "</div>" +
            "</div>" +
            '<button class="cart-item__remove" data-remove="' +
            p.id +
            '" aria-label="Remove ' +
            escapeHtml(p.name) +
            ' from cart">Remove</button>' +
            "</div>"
          );
        })
        .join("");
    }

    subtotalEl.textContent = money(subtotal());
  }

  function bumpCount() {
    cartCountEl.classList.remove("bump");
    void cartCountEl.offsetWidth;
    cartCountEl.classList.add("bump");
  }

  /* ---------- Drawer open/close ---------- */
  function openCart() {
    lastFocused = document.activeElement;
    overlay.hidden = false;
    requestAnimationFrame(function () {
      overlay.classList.add("is-open");
      drawer.classList.add("is-open");
    });
    drawer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    cartCloseBtn.focus();
    document.addEventListener("keydown", onKeydown);
  }

  function closeCart() {
    overlay.classList.remove("is-open");
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    checkoutNote.hidden = true;
    document.removeEventListener("keydown", onKeydown);
    var hide = function () {
      overlay.hidden = true;
      overlay.removeEventListener("transitionend", hide);
    };
    overlay.addEventListener("transitionend", hide);
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      closeCart();
    }
  }

  /* ---------- Event wiring (delegation) ---------- */
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-add],[data-inc],[data-dec],[data-remove]");
    if (!t) return;
    if (t.hasAttribute("data-add")) {
      addToCart(t.getAttribute("data-add"));
    } else if (t.hasAttribute("data-inc")) {
      changeQty(t.getAttribute("data-inc"), 1);
    } else if (t.hasAttribute("data-dec")) {
      changeQty(t.getAttribute("data-dec"), -1);
    } else if (t.hasAttribute("data-remove")) {
      removeLine(t.getAttribute("data-remove"));
    }
  });

  cartOpenBtn.addEventListener("click", openCart);
  cartCloseBtn.addEventListener("click", closeCart);
  overlay.addEventListener("click", closeCart);

  checkoutBtn.addEventListener("click", function () {
    if (cart.length === 0) return;
    checkoutNote.hidden = false;
  });

  /* ---------- Smooth-scroll for in-page anchors ---------- */
  document.querySelectorAll("[data-scroll]").forEach(function (link) {
    link.addEventListener("click", function (e) {
      var id = this.getAttribute("href");
      if (id && id.charAt(0) === "#") {
        var target = document.querySelector(id);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    });
  });

  /* ---------- Email capture (mock) ---------- */
  var joinForm = $("#joinForm");
  var joinThanks = $("#joinThanks");
  if (joinForm) {
    joinForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = $("#joinEmail");
      if (!input.value || !input.checkValidity()) {
        input.focus();
        return;
      }
      joinForm.hidden = true;
      joinThanks.hidden = false;
    });
  }

  /* ---------- Init ---------- */
  renderProducts();
  renderCart();
})();
