/* Kiosco Scan — app web (PWA) que lee códigos de barra y guarda en Google Sheets. */
'use strict';

/* ================================================================== */
/* Utilidades                                                          */
/* ================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const fmtPesos = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtNum = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 });
const pesos = (n) => fmtPesos.format(Number(n) || 0);
const cant = (n, unidad) => unidad === 'kg' ? fmtKg(n) : fmtNum.format(n);
function fmtKg(kg) {
  kg = Number(kg) || 0;
  return Math.abs(kg) < 1 ? fmtNum.format(Math.round(kg * 1000)) + ' g' : fmtNum.format(kg) + ' kg';
}
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
function num(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim().replace(/\s|\$/g, '');
  if (!s) return NaN;
  // "1.500,50" -> 1500.50 ; "1500.5" -> 1500.5 ; "0,25" -> 0.25
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // "9.500" = 9500 (punto de miles)
  return Number(s);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function leer(k, def) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; }
}
function guardar(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ }
}

let toastTimer;
function toast(msg, tipo = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + tipo;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), tipo === 'error' ? 4500 : 2200);
}

let audioCtx;
function beep(ok = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 1500 : 320;
    g.gain.value = 0.08;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + (ok ? 0.08 : 0.25));
  } catch { /* sin audio */ }
  if (navigator.vibrate) navigator.vibrate(ok ? 40 : [60, 40, 60]);
}

/* ================================================================== */
/* Estado                                                              */
/* ================================================================== */

const K = { cfg: 'ks_cfg', prods: 'ks_prods', cola: 'ks_cola', carrito: 'ks_carrito', demo: 'ks_demo' };

const S = {
  cfg: leer(K.cfg, { api: '', clave: '', local: '', demo: false, balanza: false, balanzaTipo: 'importe' }),
  productos: leer(K.prods, []),
  cola: leer(K.cola, []),
  carrito: leer(K.carrito, []),
  vista: 'vender',
  filtro: 'todos',
  sincronizando: false,
  ultimoError: '',
  online: null,
};

const configurado = () => S.cfg.demo || !!S.cfg.api;
const guardarCfg = () => guardar(K.cfg, S.cfg);
const guardarProds = () => guardar(K.prods, S.productos);
const guardarCola = () => guardar(K.cola, S.cola);
const guardarCarrito = () => guardar(K.carrito, S.carrito);

const porCodigo = (c) => S.productos.find((p) => p.codigo === String(c));

function buscarProductos(q, limite = 8) {
  q = normalizar(q).trim();
  if (!q) return [];
  const palabras = q.split(/\s+/);
  return S.productos
    .filter((p) => {
      const t = normalizar(p.nombre + ' ' + p.codigo);
      return palabras.every((w) => t.includes(w));
    })
    .slice(0, limite);
}

/* ================================================================== */
/* Operaciones sobre la lista de productos (cliente y demo)            */
/* ================================================================== */

function aplicarOp(op, lista) {
  const buscar = (c) => lista.find((p) => p.codigo === String(c));
  const d = op.data;
  if (op.action === 'venta') {
    d.items.forEach((it) => { const p = it.codigo && buscar(it.codigo); if (p) p.stock = r3(p.stock - it.cantidad); });
  } else if (op.action === 'entrada') {
    d.items.forEach((it) => {
      const p = buscar(it.codigo);
      if (!p) return;
      p.stock = r3(p.stock + it.cantidad);
      if (it.costo != null && it.costo !== '') p.costo = it.costo;
      if (it.precio != null && it.precio !== '') p.precio = it.precio;
    });
  } else if (op.action === 'ajuste') {
    const p = buscar(d.codigo);
    if (p) p.stock = r3(d.stock);
  } else if (op.action === 'producto') {
    const n = d.producto;
    const p = buscar(n.codigo);
    if (p) Object.assign(p, { nombre: n.nombre, unidad: n.unidad, precio: n.precio, costo: n.costo, stockMinimo: n.stockMinimo });
    else lista.push({ codigo: n.codigo, nombre: n.nombre, unidad: n.unidad, precio: n.precio, costo: n.costo, stock: n.stock || 0, stockMinimo: n.stockMinimo });
  }
}

/* ================================================================== */
/* Backend: Apps Script o demo local                                   */
/* ================================================================== */

class ErrorRed extends Error {}

async function llamar(action, payload = {}) {
  if (S.cfg.demo) return demo(action, payload);
  if (!S.cfg.api) throw new ErrorRed('Sin planilla configurada');
  let res;
  try {
    res = await fetch(S.cfg.api, {
      method: 'POST',
      // text/plain evita el "preflight" CORS que Apps Script no responde
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, clave: S.cfg.clave, ...payload }),
    });
  } catch (e) {
    throw new ErrorRed('Sin conexión');
  }
  if (!res.ok) throw new ErrorRed('Error ' + res.status);
  try {
    return await res.json();
  } catch {
    throw new ErrorRed('Respuesta inválida. ¿La URL es la de /exec y el acceso es "Cualquier persona"?');
  }
}

const PRODUCTOS_DEMO = [
  { codigo: '7790895000997', nombre: 'Coca-Cola 500 ml', unidad: 'u', precio: 1800, costo: 1200, stock: 24, stockMinimo: 6 },
  { codigo: '7790580119300', nombre: 'Alfajor triple chocolate', unidad: 'u', precio: 1200, costo: 750, stock: 30, stockMinimo: 10 },
  { codigo: '7790040139009', nombre: 'Galletitas de agua 200 g', unidad: 'u', precio: 950, costo: 600, stock: 4, stockMinimo: 5 },
  { codigo: '7790070012345', nombre: 'Yerba mate 1 kg', unidad: 'u', precio: 4500, costo: 3300, stock: 12, stockMinimo: 4 },
  { codigo: '7798062540016', nombre: 'Agua mineral 1,5 L', unidad: 'u', precio: 1300, costo: 800, stock: 18, stockMinimo: 6 },
  { codigo: '101', nombre: 'Jamón cocido', unidad: 'kg', precio: 14000, costo: 9500, stock: 4.5, stockMinimo: 1 },
  { codigo: '102', nombre: 'Queso de máquina', unidad: 'kg', precio: 12500, costo: 8800, stock: 3.2, stockMinimo: 1 },
  { codigo: '103', nombre: 'Salame milán', unidad: 'kg', precio: 19000, costo: 13000, stock: 0.8, stockMinimo: 1 },
  { codigo: 'M-PAN', nombre: 'Pan francés', unidad: 'kg', precio: 3200, costo: 2000, stock: 10, stockMinimo: 2 },
];

function demo(action, p) {
  const db = leer(K.demo, null) || { productos: structuredClone(PRODUCTOS_DEMO), ventas: [] };
  const fin = (r) => { guardar(K.demo, db); return Promise.resolve(r); };
  switch (action) {
    case 'ping': return fin({ ok: true, local: 'Local de prueba' });
    case 'productos': return fin({ ok: true, local: 'Local de prueba', productos: structuredClone(db.productos) });
    case 'resumen': {
      const hoy = new Date().toDateString();
      const v = db.ventas.filter((x) => new Date(x.fecha).toDateString() === hoy);
      return fin({ ok: true, ventas: v.length, total: r2(v.reduce((a, x) => a + x.total, 0)) });
    }
    case 'venta': {
      if (db.ventas.some((x) => x.id === p.id)) return fin({ ok: true, duplicado: true });
      aplicarOp({ action, data: p }, db.productos);
      const total = r2(p.items.reduce((a, it) => a + subtotalItem(it), 0));
      db.ventas.push({ id: p.id, fecha: p.fecha, total });
      return fin({ ok: true, total });
    }
    case 'entrada': case 'ajuste': case 'producto':
      aplicarOp({ action, data: p }, db.productos);
      return fin({ ok: true });
  }
  return fin({ ok: false, error: 'Acción desconocida' });
}

/* ================================================================== */
/* Cola de sincronización (funciona sin internet)                       */
/* ================================================================== */

function encolar(action, data) {
  const op = { id: uid(), action, data, fecha: new Date().toISOString() };
  if (action === 'venta') data.id = op.id;
  aplicarOp(op, S.productos);
  S.cola.push(op);
  guardarProds();
  guardarCola();
  renderTodo();
  sincronizar();
  return op;
}

async function sincronizar(forzarRefresco = false) {
  if (S.sincronizando || !configurado()) { renderSync(); return; }
  S.sincronizando = true;
  renderSync();
  let huboCambios = false;
  try {
    while (S.cola.length) {
      const op = S.cola[0];
      let r;
      try {
        r = await llamar(op.action, { ...op.data, fecha: op.fecha });
      } catch (e) {
        S.online = false;
        S.ultimoError = e.message;
        break; // sin conexión: queda en la cola
      }
      S.online = true;
      if (!r.ok && r.auth) { S.ultimoError = 'Clave incorrecta'; toast('Clave incorrecta: revisala en Más', 'error'); break; }
      if (!r.ok) toast('No se pudo guardar (' + op.action + '): ' + r.error, 'error');
      S.cola.shift();
      guardarCola();
      huboCambios = true;
    }
    if (!S.cola.length && (huboCambios || forzarRefresco)) await refrescarProductos();
  } finally {
    S.sincronizando = false;
    renderSync();
  }
}

async function refrescarProductos() {
  try {
    const r = await llamar('productos');
    if (!r.ok) {
      S.ultimoError = r.error;
      if (r.auth) toast('Clave incorrecta: revisala en Más', 'error');
      return false;
    }
    S.online = true;
    S.ultimoError = '';
    S.productos = r.productos;
    S.cola.forEach((op) => aplicarOp(op, S.productos)); // lo pendiente sigue aplicado
    if (r.local) S.cfg.local = r.local;
    guardarProds();
    guardarCfg();
    renderTodo();
    return true;
  } catch (e) {
    S.online = false;
    S.ultimoError = e.message;
    renderSync();
    return false;
  }
}

/* ================================================================== */
/* Escáner                                                             */
/* ================================================================== */

const LIB_LECTOR = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.3/dist/iife/ponyfill.js';
const FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];

function cargarScript(src) {
  return new Promise((ok, mal) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => mal(new Error('No se pudo descargar el lector. Revisá la conexión.'));
    document.head.appendChild(s);
  });
}

/**
 * Lector de códigos: cámara en alta resolución + enfoque continuo.
 * Usa el detector nativo del celular (Android/Chrome) y si no existe,
 * el motor ZXing-C++ en WebAssembly (iPhone, otros navegadores).
 */
const Lector = {
  activo: false,
  abriendo: false,
  stream: null,
  track: null,
  detector: null,
  canvas: null,
  ultimo: '',
  ultimoT: 0,
  candidato: '',
  onCodigo: null,
  zoomNiveles: [],
  zoomIdx: 0,
  linterna: false,

  async crearDetector() {
    if (this.detector) return this.detector;
    if ('BarcodeDetector' in window) {
      try {
        const soportados = await window.BarcodeDetector.getSupportedFormats();
        if (soportados.includes('ean_13')) {
          this.detector = new window.BarcodeDetector({ formats: FORMATOS.filter((f) => soportados.includes(f)) });
          return this.detector;
        }
      } catch { /* usamos el de respaldo */ }
    }
    if (!window.BarcodeDetectionAPI) await cargarScript(LIB_LECTOR);
    this.detector = new window.BarcodeDetectionAPI.BarcodeDetector({ formats: FORMATOS });
    return this.detector;
  },

  async abrir(onCodigo) {
    this.onCodigo = onCodigo;
    if (this.activo || this.abriendo) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return toast(window.isSecureContext ? 'Este navegador no permite usar la cámara' : 'La cámara sólo funciona con https', 'error');
    }
    this.abriendo = true;
    $('#lectorWrap').hidden = false;
    $('#lectorEstado').textContent = 'Abriendo cámara…';
    $$('[data-cam]').forEach((b) => b.classList.add('activo'));
    try {
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [{ focusMode: 'continuous' }],
          },
        }),
        this.crearDetector(),
      ]);
      if (!this.abriendo) { stream.getTracks().forEach((t) => t.stop()); return; } // se cerró mientras abría
      this.stream = stream;
      this.track = stream.getVideoTracks()[0];
      const v = $('#lectorVideo');
      v.srcObject = stream;
      await v.play().catch(() => {});
      await this.configurarCamara();
      this.activo = true;
      $('#lectorEstado').textContent = 'Poné el código dentro del recuadro, a unos 15 cm';
      setTimeout(() => { if (this.activo) $('#lectorEstado').textContent = ''; }, 3500);
      this.bucle();
    } catch (e) {
      this.cerrar();
      const msg = String((e && (e.message || e.name)) || e);
      if (/permission|notallowed|denied/i.test(msg)) toast('Permití el acceso a la cámara para escanear', 'error');
      else toast('No se pudo abrir la cámara: ' + msg, 'error');
    } finally {
      this.abriendo = false;
    }
  },

  async configurarCamara() {
    const t = this.track;
    const cap = (t.getCapabilities && t.getCapabilities()) || {};
    const avanzado = {};
    if (cap.focusMode && cap.focusMode.includes('continuous')) avanzado.focusMode = 'continuous';
    if (cap.exposureMode && cap.exposureMode.includes('continuous')) avanzado.exposureMode = 'continuous';
    if (Object.keys(avanzado).length) { try { await t.applyConstraints({ advanced: [avanzado] }); } catch { /* opcional */ } }

    // Zoom: ayuda mucho con celulares que no enfocan de cerca
    this.zoomNiveles = [];
    if (cap.zoom && cap.zoom.max > 1) {
      const min = cap.zoom.min || 1;
      this.zoomNiveles = [min, 1.5, 2, 3].filter((z) => z >= min && z <= cap.zoom.max);
      if (this.zoomNiveles.length < 2) this.zoomNiveles = [];
    }
    const bz = $('#btnZoom');
    bz.hidden = !this.zoomNiveles.length;
    if (this.zoomNiveles.length) {
      // Arranca en 1,5× si se puede: así el código se acerca sin acercar el celular
      this.zoomIdx = Math.max(0, this.zoomNiveles.indexOf(1.5));
      await this.aplicarZoom();
    }

    const bl = $('#btnLinterna');
    bl.hidden = !cap.torch;
    this.linterna = false;
    bl.classList.remove('on');
  },

  async aplicarZoom() {
    const z = this.zoomNiveles[this.zoomIdx];
    try { await this.track.applyConstraints({ advanced: [{ zoom: z }] }); } catch { /* opcional */ }
    $('#btnZoom').textContent = fmtNum.format(z) + '×';
  },

  async cambiarZoom() {
    if (!this.zoomNiveles.length) return;
    this.zoomIdx = (this.zoomIdx + 1) % this.zoomNiveles.length;
    await this.aplicarZoom();
  },

  async cambiarLinterna() {
    this.linterna = !this.linterna;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: this.linterna }] });
      $('#btnLinterna').classList.toggle('on', this.linterna);
    } catch {
      this.linterna = false;
      toast('Este celular no permite prender la luz desde el navegador', 'error');
    }
  },

  /** Recorta la zona del recuadro y busca códigos, ~10 veces por segundo */
  async bucle() {
    const v = $('#lectorVideo');
    this.canvas = this.canvas || document.createElement('canvas');
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    let vuelta = 0;
    while (this.activo) {
      const inicio = performance.now();
      if (v.readyState >= 2 && v.videoWidth) {
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        // Una de cada 4 vueltas mira el cuadro entero (por si el código quedó fuera del recuadro)
        const entero = vuelta++ % 4 === 3;
        const sw = entero ? vw : Math.round(vw * 0.9);
        const sh = entero ? vh : Math.round(vh * 0.6);
        const sx = Math.round((vw - sw) / 2);
        const sy = Math.round((vh - sh) / 2);
        const escala = Math.min(1, 1600 / sw);
        this.canvas.width = Math.round(sw * escala);
        this.canvas.height = Math.round(sh * escala);
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, this.canvas.width, this.canvas.height);
        try {
          const res = await this.detector.detect(this.canvas);
          if (res && res.length) this.encontrado(res[0]);
        } catch { /* cuadro sin código */ }
      }
      const espera = Math.max(30, 100 - (performance.now() - inicio));
      await new Promise((r) => setTimeout(r, espera));
    }
  },

  encontrado(r) {
    const txt = String(r.rawValue || '').trim();
    if (!txt) return;
    // Code 39 / ITF no tienen dígito verificador fuerte: pedimos dos lecturas iguales
    if (r.format === 'code_39' || r.format === 'itf') {
      if (this.candidato !== txt) { this.candidato = txt; return; }
    }
    this.candidato = '';
    this.leido(txt);
  },

  leido(txt) {
    const ahora = Date.now();
    if (!$('#modal').hidden) return;
    // Mismo código todavía frente a la cámara: no se vuelve a sumar.
    // Para sumar otra unidad hay que sacarlo del cuadro (1,2 s) o tocar "+".
    if (txt === this.ultimo && ahora - this.ultimoT < 1200) { this.ultimoT = ahora; return; }
    this.ultimo = txt;
    this.ultimoT = ahora;
    const w = $('#lectorWrap');
    w.classList.add('flash');
    setTimeout(() => w.classList.remove('flash'), 250);
    $('#lectorUltimo').textContent = txt;
    if (this.onCodigo) this.onCodigo(txt);
  },

  cerrar() {
    this.activo = false;
    this.abriendo = false;
    $('#lectorWrap').hidden = true;
    $$('[data-cam]').forEach((b) => b.classList.remove('activo'));
    $('#lectorUltimo').textContent = '';
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    const v = $('#lectorVideo');
    if (v) v.srcObject = null;
  },
};

/** Interpreta un código: producto, etiqueta de balanza o desconocido */
function interpretarCodigo(codigo) {
  codigo = String(codigo).trim();
  const p = porCodigo(codigo);
  if (p) return { tipo: 'producto', p };
  // EAN-13 de balanza: 2 + dígito + PLU(5) + valor(5) + verificador
  if (S.cfg.balanza && /^2\d{12}$/.test(codigo)) {
    const plu = codigo.slice(2, 7);
    const valor = Number(codigo.slice(7, 12));
    const pb = S.productos.find((x) => x.codigo === plu || (/^\d+$/.test(x.codigo) && Number(x.codigo) === Number(plu)));
    return { tipo: 'balanza', p: pb, plu, valor };
  }
  return { tipo: 'desconocido', codigo };
}

/* ================================================================== */
/* VENDER                                                              */
/* ================================================================== */

const subtotalItem = (it) => (it.subtotal != null ? Number(it.subtotal) : r2(it.cantidad * it.precio));

function agregarAlCarrito(item) {
  // Productos por unidad se suman en la misma línea
  const igual = item.unidad === 'u' && item.codigo && item.subtotal == null && S.carrito.find((x) => x.codigo === item.codigo && x.unidad === 'u' && x.subtotal == null);
  if (igual) {
    igual.cantidad += item.cantidad;
    igual._nuevo = true;
  } else {
    item.key = uid();
    item._nuevo = true;
    S.carrito.unshift(item);
  }
  guardarCarrito();
  renderCarrito();
}

function agregarProducto(p, cantidad = 1) {
  if (p.unidad === 'kg') return modalPeso(p);
  agregarAlCarrito({ codigo: p.codigo, nombre: p.nombre, unidad: 'u', precio: p.precio, cantidad });
  beep();
}

function codigoEnVenta(codigo) {
  const r = interpretarCodigo(codigo);
  if (r.tipo === 'producto') return agregarProducto(r.p);
  if (r.tipo === 'balanza') {
    if (!r.p) {
      beep(false);
      if (S.cfg.balanzaTipo === 'importe') return modalLibre(r.valor, 'Balanza PLU ' + r.plu);
      return toast('PLU ' + r.plu + ' no está cargado en Productos', 'error');
    }
    beep();
    if (S.cfg.balanzaTipo === 'importe') {
      const kg = r.p.precio ? r3(r.valor / r.p.precio) : 0;
      return agregarAlCarrito({ codigo: r.p.codigo, nombre: r.p.nombre, unidad: 'kg', precio: r.p.precio, cantidad: kg, subtotal: r.valor });
    }
    return agregarAlCarrito({ codigo: r.p.codigo, nombre: r.p.nombre, unidad: 'kg', precio: r.p.precio, cantidad: r3(r.valor / 1000) });
  }
  beep(false);
  modalDesconocido(codigo);
}

function modalDesconocido(codigo) {
  abrirModal('Producto no cargado', `
    <p>El código <b>${esc(codigo)}</b> no está en la lista de productos.</p>
    <div style="display:grid;gap:8px">
      <button class="btn-pri" id="mdAlta" type="button">Cargarlo ahora</button>
      <button class="btn-sec" id="mdLibre" type="button">Venderlo como ítem libre</button>
    </div>`);
  $('#mdAlta').onclick = () => modalProducto({ codigo }, (p) => agregarProducto(p));
  $('#mdLibre').onclick = () => modalLibre('', '');
}

function modalPeso(p, itemExistente) {
  let modo = itemExistente && itemExistente.subtotal != null ? 'importe' : 'peso';
  abrirModal(p.nombre, `
    <p class="ayuda">${pesos(p.precio)} el kilo · stock ${fmtKg(p.stock)}</p>
    <div class="segmento" id="mpModo">
      <button type="button" data-m="peso">Por peso</button>
      <button type="button" data-m="importe">Por importe $</button>
    </div>
    <label id="mpLbl">Gramos
      <input id="mpValor" class="campo" inputmode="decimal" autocomplete="off">
    </label>
    <div class="rapidos" id="mpRapidos"></div>
    <div class="calculo" id="mpCalc"></div>
    <button class="btn-pri ancho" id="mpOk" type="button">${itemExistente ? 'Actualizar' : 'Agregar'}</button>`);

  const inp = $('#mpValor');
  const calcular = () => {
    const v = num(inp.value);
    if (!(v > 0) || !p.precio) return null;
    return modo === 'peso'
      ? { cantidad: r3(v / 1000), subtotal: null, total: r2((v / 1000) * p.precio) }
      : { cantidad: r3(v / p.precio), subtotal: r2(v), total: r2(v) };
  };
  const pintar = () => {
    $$('#mpModo button').forEach((b) => b.classList.toggle('activo', b.dataset.m === modo));
    $('#mpLbl').firstChild.textContent = modo === 'peso' ? 'Gramos' : 'Importe en pesos';
    const rapidos = modo === 'peso' ? [100, 150, 200, 250, 500, 1000] : [1000, 2000, 3000, 5000, 10000];
    $('#mpRapidos').innerHTML = rapidos.map((v) => `<button type="button" data-v="${v}">${modo === 'peso' ? fmtKg(v / 1000) : '$' + fmtNum.format(v)}</button>`).join('');
    $$('#mpRapidos button').forEach((b) => (b.onclick = () => { inp.value = b.dataset.v; actualizar(); }));
    actualizar();
  };
  const actualizar = () => {
    const c = calcular();
    $('#mpCalc').innerHTML = c ? `${fmtKg(c.cantidad)} → <b>${pesos(c.total)}</b>` : (p.precio ? 'Ingresá ' + (modo === 'peso' ? 'los gramos' : 'el importe') : 'Este producto no tiene precio. Editalo en Productos.');
    $('#mpOk').disabled = !c;
  };
  $$('#mpModo button').forEach((b) => (b.onclick = () => { modo = b.dataset.m; inp.value = ''; pintar(); inp.focus(); }));
  inp.oninput = actualizar;
  if (itemExistente) inp.value = modo === 'peso' ? Math.round(itemExistente.cantidad * 1000) : itemExistente.subtotal;
  pintar();
  setTimeout(() => inp.focus(), 50);

  const ok = () => {
    const c = calcular();
    if (!c) return;
    if (itemExistente) {
      Object.assign(itemExistente, { cantidad: c.cantidad, subtotal: c.subtotal ?? undefined, _nuevo: true });
      if (c.subtotal == null) delete itemExistente.subtotal;
      guardarCarrito();
      renderCarrito();
    } else {
      const it = { codigo: p.codigo, nombre: p.nombre, unidad: 'kg', precio: p.precio, cantidad: c.cantidad };
      if (c.subtotal != null) it.subtotal = c.subtotal;
      agregarAlCarrito(it);
    }
    cerrarModal();
  };
  $('#mpOk').onclick = ok;
  inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
}

function modalLibre(importe = '', desc = '') {
  abrirModal('Ítem libre', `
    <p class="ayuda">Para cobrar algo que no está cargado. No descuenta stock.</p>
    <label>Descripción (opcional)
      <input id="mlDesc" class="campo" autocomplete="off" placeholder="Varios" value="${esc(desc)}">
    </label>
    <label>Importe
      <input id="mlImp" class="campo" inputmode="decimal" autocomplete="off" value="${esc(importe)}">
    </label>
    <button class="btn-pri ancho" id="mlOk" type="button">Agregar</button>`);
  const ok = () => {
    const v = num($('#mlImp').value);
    if (!(v > 0)) return toast('Ingresá un importe', 'error');
    agregarAlCarrito({ codigo: '', nombre: $('#mlDesc').value.trim() || 'Varios', unidad: 'u', precio: r2(v), cantidad: 1, libre: true });
    cerrarModal();
  };
  $('#mlOk').onclick = ok;
  $('#mlImp').onkeydown = (e) => { if (e.key === 'Enter') ok(); };
  setTimeout(() => $('#mlImp').focus(), 50);
}

function modalPorPeso() {
  abrirModal('Por peso / sin código', `
    <div class="buscador solo"><input id="mppBuscar" type="search" autocomplete="off" placeholder="Buscar (jamón, queso, pan…)"></div>
    <ul class="lista" id="mppLista"></ul>
    <button class="btn-link" id="mppNuevo" type="button">＋ Crear producto nuevo sin código</button>`);
  const pintar = () => {
    const q = $('#mppBuscar').value;
    let lista = q ? buscarProductos(q, 40) : S.productos.filter((p) => p.unidad === 'kg' || !/^\d{6,}$/.test(p.codigo));
    lista = [...lista].sort((a, b) => (a.unidad === b.unidad ? a.nombre.localeCompare(b.nombre) : a.unidad === 'kg' ? -1 : 1));
    $('#mppLista').innerHTML = lista.length
      ? lista.map((p) => `<li><button type="button" data-c="${esc(p.codigo)}">
          <span>${esc(p.nombre)} ${p.unidad === 'kg' ? '<span class="badge kg">kg</span>' : ''}<small>stock ${cant(p.stock, p.unidad)}</small></span>
          <span class="der"><b>${pesos(p.precio)}</b><small>${p.unidad === 'kg' ? 'el kilo' : 'c/u'}</small></span></button></li>`).join('')
      : '<li class="vacio-li">No hay productos. Crealos con el botón de abajo.</li>';
    $$('#mppLista button').forEach((b) => (b.onclick = () => {
      const p = porCodigo(b.dataset.c);
      if (p.unidad === 'kg') modalPeso(p);
      else { agregarProducto(p); cerrarModal(); }
    }));
  };
  $('#mppBuscar').oninput = pintar;
  $('#mppNuevo').onclick = () => modalProducto({ unidad: 'kg' }, (p) => agregarProducto(p));
  pintar();
}

function modalCobrar() {
  const total = totalCarrito();
  abrirModal('Cobrar', `
    <div class="calculo" style="text-align:center"><span class="ayuda">Total</span><br><b style="font-size:34px">${pesos(total)}</b></div>
    <label>Paga con (opcional, para calcular el vuelto)
      <input id="mcPaga" class="campo" inputmode="decimal" autocomplete="off">
    </label>
    <div class="rapidos" id="mcRapidos"></div>
    <div class="calculo" id="mcVuelto" hidden></div>
    <button class="btn-pri ancho" id="mcOk" type="button">Confirmar venta</button>`);
  const billetes = [1000, 2000, 5000, 10000, 20000].filter((b) => b >= total).slice(0, 4);
  $('#mcRapidos').innerHTML = billetes.map((b) => `<button type="button" data-v="${b}">$${fmtNum.format(b)}</button>`).join('');
  const vuelto = () => {
    const v = num($('#mcPaga').value);
    const el = $('#mcVuelto');
    if (!(v > 0)) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = v >= total ? `Vuelto: <b>${pesos(r2(v - total))}</b>` : `Faltan <b>${pesos(r2(total - v))}</b>`;
  };
  $$('#mcRapidos button').forEach((b) => (b.onclick = () => { $('#mcPaga').value = b.dataset.v; vuelto(); }));
  $('#mcPaga').oninput = vuelto;
  $('#mcOk').onclick = confirmarVenta;
}

function confirmarVenta() {
  if (!S.carrito.length) return;
  const items = S.carrito.map((it) => {
    const x = { codigo: it.codigo || '', nombre: it.nombre, unidad: it.unidad, cantidad: it.cantidad, precio: it.precio };
    if (it.subtotal != null) x.subtotal = it.subtotal;
    return x;
  });
  const total = totalCarrito();
  encolar('venta', { items });
  S.carrito = [];
  guardarCarrito();
  cerrarModal();
  renderCarrito();
  toast('Venta guardada · ' + pesos(total));
}

const totalCarrito = () => r2(S.carrito.reduce((a, it) => a + subtotalItem(it), 0));

function renderCarrito() {
  const ul = $('#carrito');
  ul.innerHTML = S.carrito.map((it) => {
    const p = it.codigo && porCodigo(it.codigo);
    let ctrl;
    if (it.unidad === 'kg') ctrl = `<button class="btn-peso" data-peso="${it.key}" type="button">${fmtKg(it.cantidad)}</button>`;
    else if (it.libre) ctrl = '';
    else ctrl = `<div class="stepper"><button type="button" data-menos="${it.key}">−</button><span>${it.cantidad}</span><button type="button" data-mas="${it.key}">+</button></div>`;
    const det = it.libre ? 'Ítem libre' : it.unidad === 'kg' ? pesos(it.precio) + ' /kg' + (it.subtotal != null ? ' · por importe' : '') : pesos(it.precio) + ' c/u';
    const aviso = p && p.stock < 0 ? ' · <span style="color:var(--rojo)">stock negativo</span>' : '';
    return `<li class="item ${it._nuevo ? 'nuevo' : ''}">
      <div><div class="item-nom">${esc(it.nombre)}</div><div class="item-det">${det}${aviso}</div></div>
      <div class="item-sub">${pesos(subtotalItem(it))}</div>
      <div></div>
      <div class="item-ctrl">${ctrl}<button class="btn-quitar" data-quitar="${it.key}" type="button" aria-label="Quitar">✕</button></div>
    </li>`;
  }).join('');
  S.carrito.forEach((it) => delete it._nuevo);
  const n = S.carrito.length;
  $('#carritoVacio').hidden = n > 0;
  $('#total').textContent = pesos(totalCarrito());
  const unidades = S.carrito.reduce((a, it) => a + (it.unidad === 'u' ? it.cantidad : 1), 0);
  $('#cantItems').textContent = unidades === 1 ? '1 producto' : unidades + ' productos';
  $('#btnCobrar').disabled = !n;
}

function clickCarrito(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const buscar = (k) => S.carrito.find((x) => x.key === k);
  if (b.dataset.mas) buscar(b.dataset.mas).cantidad++;
  else if (b.dataset.menos) {
    const it = buscar(b.dataset.menos);
    if (it.cantidad > 1) it.cantidad--;
    else S.carrito = S.carrito.filter((x) => x !== it);
  } else if (b.dataset.quitar) S.carrito = S.carrito.filter((x) => x.key !== b.dataset.quitar);
  else if (b.dataset.peso) {
    const it = buscar(b.dataset.peso);
    const p = porCodigo(it.codigo) || { nombre: it.nombre, precio: it.precio, stock: 0, codigo: it.codigo };
    return modalPeso(p, it);
  } else return;
  guardarCarrito();
  renderCarrito();
}

/* ================================================================== */
/* CARGAR (entrada de mercadería)                                      */
/* ================================================================== */

const logCarga = [];

function codigoEnCarga(codigo) {
  const r = interpretarCodigo(codigo);
  if (r.tipo === 'producto' || (r.tipo === 'balanza' && r.p)) { beep(); return panelEntrada(r.p); }
  beep(false);
  modalProducto({ codigo: r.tipo === 'balanza' ? r.plu : codigo }, (p) => panelEntrada(p));
}

function panelEntrada(p) {
  const el = $('#panelEntrada');
  const u = p.unidad === 'kg';
  el.innerHTML = `<div class="prod-card">
    <div class="nom">${esc(p.nombre)}</div>
    <div class="meta">Código ${esc(p.codigo)} · stock actual <b>${cant(p.stock, p.unidad)}</b> · precio ${pesos(p.precio)}${u ? '/kg' : ''}</div>
    <label>Cantidad que entra ${u ? '(en kilos, ej: 2,5)' : '(unidades)'}
      <input id="peCant" class="campo" inputmode="decimal" autocomplete="off">
    </label>
    <div class="grid2">
      <label>Nuevo costo (opcional)<input id="peCosto" class="campo" inputmode="decimal" autocomplete="off" placeholder="${p.costo ? fmtNum.format(p.costo) : ''}"></label>
      <label>Nuevo precio (opcional)<input id="pePrecio" class="campo" inputmode="decimal" autocomplete="off" placeholder="${p.precio ? fmtNum.format(p.precio) : ''}"></label>
    </div>
    <div class="botones">
      <button class="btn-sec" id="peEditar" type="button">Editar</button>
      <button class="btn-pri" id="peOk" type="button">Sumar al stock</button>
    </div>
  </div>`;
  const ok = () => {
    const c = num($('#peCant').value);
    if (!(c > 0)) return toast('Ingresá la cantidad', 'error');
    const it = { codigo: p.codigo, cantidad: u ? r3(c) : Math.round(c) };
    const costo = num($('#peCosto').value);
    const precio = num($('#pePrecio').value);
    if (costo > 0) it.costo = costo;
    if (precio > 0) it.precio = precio;
    encolar('entrada', { items: [it] });
    logCarga.unshift({ nombre: p.nombre, txt: '+' + cant(it.cantidad, p.unidad), stock: cant(porCodigo(p.codigo).stock, p.unidad) });
    renderLogCarga();
    el.innerHTML = '';
    toast(p.nombre + ': +' + cant(it.cantidad, p.unidad));
  };
  $('#peOk').onclick = ok;
  $('#peCant').onkeydown = (e) => { if (e.key === 'Enter') ok(); };
  $('#peEditar').onclick = () => modalProducto(p, (np) => panelEntrada(np));
  setTimeout(() => $('#peCant').focus(), 50);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderLogCarga() {
  $('#logCarga').innerHTML = logCarga.length
    ? logCarga.slice(0, 30).map((l) => `<li class="fila"><span>${esc(l.nombre)}<small>stock ahora ${l.stock}</small></span><span class="der"><b>${l.txt}</b></span></li>`).join('')
    : '<li class="vacio-li">Todavía nada.</li>';
}

/* ================================================================== */
/* Alta / edición de producto                                          */
/* ================================================================== */

function modalProducto(base, despues) {
  const existe = base.codigo && porCodigo(base.codigo);
  const p = existe ? { ...existe } : { codigo: base.codigo || '', nombre: '', unidad: base.unidad || 'u', precio: '', costo: '', stock: '', stockMinimo: '' };
  let unidad = p.unidad;
  abrirModal(existe ? 'Editar producto' : 'Producto nuevo', `
    <label>Código ${existe ? '' : '(vacío = se genera uno)'}
      <input id="mpCod" class="campo" autocomplete="off" value="${esc(p.codigo)}" ${existe ? 'readonly' : ''} placeholder="Sin código de barras">
    </label>
    <label>Nombre
      <input id="mpNom" class="campo" autocomplete="off" value="${esc(p.nombre)}" placeholder="Ej: Jamón cocido">
    </label>
    <div class="ayuda" style="margin-bottom:4px">Se vende por</div>
    <div class="segmento" id="mpUni">
      <button type="button" data-u="u">Unidad</button>
      <button type="button" data-u="kg">Kilo (peso)</button>
    </div>
    <div class="grid2">
      <label><span id="mpPrecioLbl">Precio</span><input id="mpPre" class="campo" inputmode="decimal" autocomplete="off" value="${p.precio !== '' ? esc(p.precio) : ''}"></label>
      <label>Costo (opcional)<input id="mpCos" class="campo" inputmode="decimal" autocomplete="off" value="${p.costo ? esc(p.costo) : ''}"></label>
    </div>
    <div class="grid2">
      ${existe ? `<label>Stock (conteo)<input id="mpSto" class="campo" inputmode="decimal" autocomplete="off" value="${esc(p.stock)}"></label>`
               : `<label>Stock inicial<input id="mpSto" class="campo" inputmode="decimal" autocomplete="off" placeholder="0"></label>`}
      <label>Avisar con stock ≤<input id="mpMin" class="campo" inputmode="decimal" autocomplete="off" value="${p.stockMinimo ? esc(p.stockMinimo) : ''}"></label>
    </div>
    <button class="btn-pri ancho" id="mpGuardar" type="button">Guardar</button>`);

  const pintarUni = () => {
    $$('#mpUni button').forEach((b) => b.classList.toggle('activo', b.dataset.u === unidad));
    $('#mpPrecioLbl').textContent = unidad === 'kg' ? 'Precio por kilo' : 'Precio';
  };
  $$('#mpUni button').forEach((b) => (b.onclick = () => { unidad = b.dataset.u; pintarUni(); }));
  pintarUni();
  setTimeout(() => (p.codigo && !existe ? $('#mpNom') : existe ? $('#mpPre') : $('#mpCod')).focus(), 50);

  $('#mpGuardar').onclick = () => {
    const nombre = $('#mpNom').value.trim();
    if (!nombre) return toast('Poné el nombre del producto', 'error');
    let codigo = $('#mpCod').value.trim();
    if (!codigo) codigo = 'M-' + Date.now().toString(36).toUpperCase().slice(-6);
    if (!existe && porCodigo(codigo)) return toast('Ya existe un producto con ese código', 'error');
    const precio = num($('#mpPre').value);
    const stockVal = num($('#mpSto').value);
    const nuevo = {
      codigo, nombre, unidad,
      precio: precio > 0 ? precio : 0,
      costo: num($('#mpCos').value) > 0 ? num($('#mpCos').value) : 0,
      stockMinimo: num($('#mpMin').value) > 0 ? num($('#mpMin').value) : 0,
    };
    if (!existe) nuevo.stock = stockVal > 0 ? stockVal : 0;
    encolar('producto', { producto: nuevo });
    if (existe && !isNaN(stockVal) && r3(stockVal) !== r3(existe.stock)) encolar('ajuste', { codigo, stock: stockVal });
    cerrarModal();
    toast(existe ? 'Producto actualizado' : 'Producto creado');
    if (despues) despues(porCodigo(codigo));
  };
}

/* ================================================================== */
/* PRODUCTOS                                                           */
/* ================================================================== */

function renderProductos() {
  const q = $('#buscarProductos').value;
  let lista = q ? buscarProductos(q, 500) : [...S.productos];
  if (S.filtro === 'bajo') lista = lista.filter((p) => p.stock <= (p.stockMinimo || 0));
  if (S.filtro === 'kg') lista = lista.filter((p) => p.unidad === 'kg');
  lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
  const bajos = S.productos.filter((p) => p.stock <= (p.stockMinimo || 0)).length;
  $('[data-f="bajo"]').textContent = 'Stock bajo' + (bajos ? ` (${bajos})` : '');
  $('#listaProductos').innerHTML = lista.length
    ? lista.map((p) => {
        const bajo = p.stock <= (p.stockMinimo || 0);
        return `<li><button type="button" data-c="${esc(p.codigo)}">
          <span>${esc(p.nombre)}<small>${esc(p.codigo)}</small></span>
          <span class="der"><b>${pesos(p.precio)}</b>${p.unidad === 'kg' ? '<small>el kilo</small>' : ''}
          <span class="badge ${bajo ? 'bajo' : p.unidad === 'kg' ? 'kg' : ''}">${cant(p.stock, p.unidad)}</span></span>
        </button></li>`;
      }).join('')
    : `<li class="vacio-li">${S.productos.length ? 'Nada coincide con la búsqueda.' : 'Todavía no hay productos. Cargalos desde la pestaña Cargar.'}</li>`;
}

/* ================================================================== */
/* MÁS (resumen, conexión, configuración)                              */
/* ================================================================== */

async function cargarResumen() {
  if (!configurado()) return;
  $('#resNota').textContent = 'Consultando…';
  const pend = S.cola.filter((o) => o.action === 'venta' && new Date(o.fecha).toDateString() === new Date().toDateString());
  const pendTotal = r2(pend.reduce((a, o) => a + o.data.items.reduce((b, it) => b + subtotalItem(it), 0), 0));
  try {
    const r = await llamar('resumen');
    if (!r.ok) throw new Error(r.error);
    $('#resVentas').textContent = r.ventas + pend.length;
    $('#resTotal').textContent = pesos(r.total + pendTotal);
    $('#resNota').textContent = pend.length ? `Incluye ${pend.length} venta(s) sin sincronizar.` : 'Datos de la planilla.';
  } catch (e) {
    $('#resVentas').textContent = pend.length || '–';
    $('#resTotal').textContent = pend.length ? pesos(pendTotal) : '–';
    $('#resNota').textContent = 'Sin conexión con la planilla. ' + (pend.length ? 'Se muestran sólo las ventas pendientes.' : '');
  }
}

async function guardarConexion() {
  const api = $('#cfgApi').value.trim();
  const clave = $('#cfgClave').value.trim();
  if (api && !/^https:\/\/script\.google(usercontent)?\.com\//.test(api)) return toast('La URL tiene que ser la de Apps Script (script.google.com)', 'error');
  S.cfg.api = api;
  S.cfg.clave = clave;
  if (api) S.cfg.demo = false;
  guardarCfg();
  renderMas();
  if (!api) return;
  toast('Probando conexión…');
  try {
    const r = await llamar('ping');
    if (!r.ok) return toast(r.error, 'error');
    S.cfg.local = r.local;
    guardarCfg();
    await sincronizar(true);
    toast('Conectado a ' + (r.local || 'la planilla'));
    renderTodo();
  } catch (e) {
    toast('No se pudo conectar: ' + e.message, 'error');
  }
}

function linkConfig() {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('api', S.cfg.api);
  u.searchParams.set('clave', S.cfg.clave);
  return u.toString();
}

function renderMas() {
  $('#bienvenida').hidden = configurado();
  $('#cfgApi').value = S.cfg.api;
  $('#cfgClave').value = S.cfg.clave;
  $('#cfgDemo').checked = !!S.cfg.demo;
  $('#cfgBalanza').checked = !!S.cfg.balanza;
  $('#cfgBalanzaTipo').value = S.cfg.balanzaTipo || 'importe';
  $('#btnCompartir').hidden = !S.cfg.api;
  renderSync();
}

function renderSync() {
  const b = $('#btnSync');
  const n = S.cola.length;
  b.className = 'sync';
  let txt, estado;
  if (!configurado()) { txt = 'Sin configurar'; estado = 'Conectá la planilla abajo o probá el modo demo.'; }
  else if (S.sincronizando) { b.classList.add('pend', 'girando'); txt = 'Guardando'; estado = 'Sincronizando…'; }
  else if (n) { b.classList.add(S.online === false ? 'err' : 'pend'); txt = n + ' pend.'; estado = `${n} operación(es) esperando conexión. Se guardan solas cuando vuelve internet.` + (S.ultimoError ? ` (${S.ultimoError})` : ''); }
  else if (S.online === false) { b.classList.add('err'); txt = 'Sin conexión'; estado = 'Sin conexión: podés seguir vendiendo, se sincroniza después.'; }
  else { b.classList.add('ok'); txt = S.cfg.demo ? 'Demo' : 'Al día'; estado = S.cfg.demo ? 'Modo demo: los datos quedan sólo en este celular.' : 'Todo guardado en la planilla.'; }
  $('#syncTxt').textContent = txt;
  $('#estadoSync').textContent = estado;
  $('#nombreLocal').textContent = S.cfg.demo ? 'Local de prueba' : S.cfg.local || '';
}

/* ================================================================== */
/* Navegación, modal y render general                                  */
/* ================================================================== */

function irA(vista) {
  S.vista = vista;
  $$('.vista').forEach((v) => (v.hidden = v.id !== 'v-' + vista));
  $$('.nav button').forEach((b) => b.classList.toggle('activo', b.dataset.vista === vista));
  if (vista !== 'vender' && vista !== 'cargar') Lector.cerrar();
  else if (Lector.activo) Lector.onCodigo = vista === 'vender' ? codigoEnVenta : codigoEnCarga;
  if (vista === 'productos') renderProductos();
  if (vista === 'mas') { renderMas(); cargarResumen(); }
  window.scrollTo(0, 0);
}

function abrirModal(titulo, html) {
  $('#modalTit').textContent = titulo;
  $('#modalCuerpo').innerHTML = html;
  $('#modal').hidden = false;
}
function cerrarModal() {
  $('#modal').hidden = true;
  $('#modalCuerpo').innerHTML = '';
}

function renderTodo() {
  renderCarrito();
  renderSync();
  if (S.vista === 'productos') renderProductos();
}

/** Buscador con sugerencias: Enter = código exacto, o elegir de la lista */
function conectarBuscador(input, sug, onCodigo, onProducto) {
  const cerrar = () => { sug.hidden = true; sug.innerHTML = ''; };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    const res = q.length >= 2 ? buscarProductos(q) : [];
    if (!res.length) return cerrar();
    sug.innerHTML = res.map((p) => `<button class="sug" type="button" data-c="${esc(p.codigo)}">
      <span>${esc(p.nombre)}<small>${esc(p.codigo)}</small></span>
      <span class="der">${pesos(p.precio)}${p.unidad === 'kg' ? '/kg' : ''}<small>stock ${cant(p.stock, p.unidad)}</small></span></button>`).join('');
    sug.hidden = false;
  });
  sug.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    onProducto(porCodigo(b.dataset.c));
    input.value = '';
    cerrar();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const res = buscarProductos(q);
    // Lector USB / código tipeado: se interpreta como código. Si no, primer resultado.
    if (/^[\dA-Z-]{3,}$/i.test(q) && (porCodigo(q) || /^\d{6,}$/.test(q) || !res.length)) onCodigo(q);
    else if (res.length) onProducto(res[0]);
    input.value = '';
    cerrar();
  });
  input.addEventListener('blur', () => setTimeout(cerrar, 200));
}

function leerParametrosURL() {
  const u = new URL(location.href);
  const api = u.searchParams.get('api');
  if (!api) return;
  S.cfg.api = api;
  S.cfg.clave = u.searchParams.get('clave') || '';
  S.cfg.demo = false;
  guardarCfg();
  history.replaceState(null, '', u.pathname); // no dejar la clave en la barra
  toast('Configuración cargada');
}

function init() {
  leerParametrosURL();

  $$('.nav button').forEach((b) => (b.onclick = () => irA(b.dataset.vista)));
  $$('[data-cam]').forEach((b) => (b.onclick = () => {
    if (Lector.activo) return Lector.cerrar();
    Lector.abrir(S.vista === 'cargar' ? codigoEnCarga : codigoEnVenta);
  }));
  $('#btnCerrarLector').onclick = () => Lector.cerrar();
  $('#btnZoom').onclick = () => Lector.cambiarZoom();
  $('#btnLinterna').onclick = () => Lector.cambiarLinterna();

  // Vender
  conectarBuscador($('#buscarVender'), $('#sugVender'), codigoEnVenta, (p) => agregarProducto(p));
  $('#carrito').addEventListener('click', clickCarrito);
  $('#btnPorPeso').onclick = modalPorPeso;
  $('#btnLibre').onclick = () => modalLibre();
  $('#btnCobrar').onclick = modalCobrar;

  // Cargar
  conectarBuscador($('#buscarCargar'), $('#sugCargar'), codigoEnCarga, (p) => panelEntrada(p));
  $('#btnNuevoSinCodigo').onclick = () => modalProducto({ unidad: 'kg' }, (p) => panelEntrada(p));

  // Productos
  $('#buscarProductos').oninput = renderProductos;
  $$('#filtros .chip').forEach((c) => (c.onclick = () => {
    S.filtro = c.dataset.f;
    $$('#filtros .chip').forEach((x) => x.classList.toggle('activo', x === c));
    renderProductos();
  }));
  $('#listaProductos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (b) modalProducto(porCodigo(b.dataset.c), () => renderProductos());
  });

  // Más
  $('#btnGuardarCfg').onclick = guardarConexion;
  $('#btnResumen').onclick = cargarResumen;
  $('#btnSyncAhora').onclick = () => sincronizar(true);
  $('#btnSync').onclick = () => irA('mas');
  $('#btnDemo').onclick = () => { $('#cfgDemo').checked = true; $('#cfgDemo').onchange(); };
  $('#cfgDemo').onchange = async () => {
    S.cfg.demo = $('#cfgDemo').checked;
    guardarCfg();
    S.cola = [];
    guardarCola();
    S.productos = [];
    S.online = null;
    if (S.cfg.demo || S.cfg.api) await refrescarProductos();
    else { guardarProds(); renderTodo(); }
    renderMas();
    if (S.cfg.demo) { toast('Modo demo activado'); cargarResumen(); }
  };
  $('#cfgBalanza').onchange = () => { S.cfg.balanza = $('#cfgBalanza').checked; guardarCfg(); };
  $('#cfgBalanzaTipo').onchange = () => { S.cfg.balanzaTipo = $('#cfgBalanzaTipo').value; guardarCfg(); };
  $('#btnCompartir').onclick = async () => {
    const link = linkConfig();
    try { await navigator.clipboard.writeText(link); toast('Link copiado. Abrilo en el otro celular.'); }
    catch { prompt('Copiá este link:', link); }
  };

  // Modal
  $('#modalCerrar').onclick = cerrarModal;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') cerrarModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) cerrarModal(); });

  window.addEventListener('online', () => sincronizar(true));
  setInterval(() => { if (S.cola.length) sincronizar(); }, 30000);

  renderTodo();
  if (!configurado()) irA('mas');
  else sincronizar(true);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
