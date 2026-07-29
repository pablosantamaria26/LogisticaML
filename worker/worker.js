/**
 * Flota ML 2.0 — Cloudflare Worker
 * D1 (datos) + KV (fotos, migrable a R2) + Gemini (OCR fiscal) + Brevo (emails) + Web Push
 *
 * Principio: el chofer solo saca 2 fotos. El servidor procesa, valida matemáticamente
 * y guarda el comprobante fiscal completo + las fotos como respaldo. Nadie edita datos
 * salvo el admin (con auditoría). "La verdad procesada".
 *
 * SECRETS (wrangler secret put):
 *   GEMINI_API_KEY, SENDGRID_API_KEY (Brevo), VAPID_PRIVATE_KEY,
 *   OWNER_EMAIL, FLEET_EMAIL, AUTH_PEPPER
 * VARS (wrangler.toml): CONTADOR_EMAIL, FROM_EMAIL, VAPID_PUBLIC_KEY
 * BINDINGS: DB (D1), FLOTA_KV (KV; fotos con prefijo foto:), FOTOS (R2 opcional futuro)
 */

const TZ = 'America/Argentina/Buenos_Aires';
const FROM_NAME = 'Flota ML';
const VAPID_SUBJECT = 'mailto:santamariapablodaniel@gmail.com';
const SESSION_DAYS = 180;
const GEMINI_MODEL = 'gemini-2.5-flash';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      // ── API v2 ──
      if (p === '/api/health') return json({ ok: true, v: 2, ts: new Date().toISOString() });
      if (p === '/api/login' && request.method === 'POST') return handleLogin(request, env);
      if (p === '/api/logout' && request.method === 'POST') return handleLogout(request, env);
      if (p === '/api/me') return handleMe(request, env);
      if (p === '/api/cargas' && request.method === 'POST') return handleNuevaCarga(request, env, ctx);
      if (p === '/api/cargas' && request.method === 'GET') return handleGetCargas(request, env);
      if (p === '/api/servicios' && request.method === 'POST') return handleNuevoServicio(request, env);
      if (p === '/api/servicios' && request.method === 'GET') return handleGetServicios(request, env);
      if (p === '/api/servicios/foto' && request.method === 'POST') return handleServicioFoto(request, env, ctx);
      const mServFoto = p.match(/^\/api\/servicios\/([\w.-]+)\/foto$/);
      if (mServFoto) return handleServicioFotoGet(request, env, mServFoto[1]);
      if (p === '/api/export.csv') return handleExportCSV(request, env);
      if (p === '/api/push/register' && request.method === 'POST') return handlePushRegister(request, env);
      if (p === '/api/push/broadcast' && request.method === 'POST') return handlePushBroadcast(request, env);
      if (p === '/api/diag' && request.method === 'POST') return handleDiag(request, env, ctx);
      if (p === '/api/admin/usuarios') return handleAdminUsuarios(request, env);
      if (p === '/api/admin/asignar' && request.method === 'POST') return handleAdminAsignar(request, env);
      if (p === '/api/admin/vehiculos' && request.method === 'POST') return handleAdminCrearVehiculo(request, env);
      const mSetKm = p.match(/^\/api\/admin\/vehiculos\/([\w.-]+)\/km$/);
      if (mSetKm && request.method === 'POST') return handleAdminSetKm(request, env, mSetKm[1]);
      const mEditVeh = p.match(/^\/api\/admin\/vehiculos\/([\w.-]+)\/editar$/);
      if (mEditVeh && request.method === 'POST') return handleAdminEditarVehiculo(request, env, mEditVeh[1]);
      if (p === '/api/admin/reset-pin' && request.method === 'POST') return handleAdminResetPin(request, env);
      if (p === '/api/admin/corregir' && request.method === 'POST') return handleAdminCorregir(request, env);
      if (p === '/api/admin/reprocesar' && request.method === 'POST') return handleAdminReprocesar(request, env, ctx);
      if (p === '/api/admin/revision') return handleRevision(request, env);
      const mDelCarga = p.match(/^\/api\/admin\/cargas\/([\w.-]+)$/);
      if (mDelCarga && request.method === 'DELETE') return handleAdminEliminarCarga(request, env, mDelCarga[1]);
      if (p === '/api/admin/contador-ahora' && request.method === 'POST') return handleContadorAhora(request, env);
      if (p === '/api/admin/weekly-ahora' && request.method === 'POST') return handleWeeklyAhora(request, env);
      if (p === '/api/admin/analisis-vehiculo' && request.method === 'POST') return handleAnalisisVehiculo(request, env);
      if (p === '/api/admin/solicitar-foto' && request.method === 'POST') return handleAdminSolicitarFoto(request, env);
      if (p === '/api/cargas/pendientes-foto') return handlePendientesFoto(request, env);
      // Fotos: /api/cargas/{id}/foto/{ticket|tablero}?t=token  ó  /api/fotolink/{id}/{tipo}?k=firma
      const mFoto = p.match(/^\/api\/cargas\/([\w.-]+)\/foto\/(ticket|tablero)$/);
      if (mFoto) return handleFoto(request, env, mFoto[1], mFoto[2], false);
      const mLink = p.match(/^\/api\/fotolink\/([\w.-]+)\/(ticket|tablero)$/);
      if (mLink) return handleFoto(request, env, mLink[1], mLink[2], true);
      // Subir foto puntual faltante (sin duplicar la carga): /api/cargas/{id}/foto
      const mFotoUp = p.match(/^\/api\/cargas\/([\w.-]+)\/foto$/);
      if (mFotoUp && request.method === 'POST') return handleSubirFotoFaltante(request, env, ctx, mFotoUp[1]);

      // ── LEGACY (apps viejas instaladas, hasta que actualicen) ──
      if (p === '/api/process-ticket' && request.method === 'POST') return legacyProcessTicket(request, env);
      if (p === '/api/process-odometer' && request.method === 'POST') return legacyProcessOdometer(request, env);
      if (p === '/api/sync-record' && request.method === 'POST') return legacySyncRecord(request, env);
      if (p === '/api/get-records') return legacyGetRecords(request, env);
      if (p === '/api/assignments') return legacyAssignments(request, env);
      if (p === '/api/register-push' && request.method === 'POST') return legacyRegisterPush(request, env);
      if (p === '/api/push-check') return legacyPushCheck(request, env);
      if (p === '/api/push-notify' && request.method === 'POST') return legacyPushNotify(request, env);
      if (p === '/api/send-confirmation' && request.method === 'POST') return json({ success: true, legacy: true });
      if (p === '/api/maintenance-alert' && request.method === 'POST') return legacyMaintAlert(request, env);

      return json({ error: 'Not Found' }, 404);
    } catch (err) {
      console.error('Worker:', err.stack || err);
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Solo 2 triggers (límite de 5 crons por cuenta free) — se ramifica por fecha AR
    const ar = arNow();
    const dia = ar.getDate(), diaSem = ar.getDay(); // 0=dom ... 5=vie 6=sab
    switch (event.cron) {
      case '0 11 * * *': // 08:00 AR
        if (diaSem >= 1 && diaSem <= 5) ctx.waitUntil(pushDailyCheck(env));
        if (diaSem === 5) ctx.waitUntil(pushFridayClean(env));
        if (dia === 1) { ctx.waitUntil(sendOwnerReport(env)); ctx.waitUntil(pushDocs(env)); }
        break;
      case '0 12 * * *': // 09:00 AR
        if (dia === 15) ctx.waitUntil(pushTires(env));
        if (dia === 20) ctx.waitUntil(pushSpare(env));
        if (dia === 25) ctx.waitUntil(sendContadorReport(env));
        if (diaSem === 6) ctx.waitUntil(sendWeeklyReport(env)); // sábado: semana completa
        break;
    }
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS BASE
// ══════════════════════════════════════════════════════════════════════════════
function arNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: TZ })); }
function hoyAR() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function fmt$(n) { return '$' + (n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtN(n) { return (n || 0).toLocaleString('es-AR'); }
function uuid() { return crypto.randomUUID(); }

async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function hashPin(username, pin, env) {
  return sha256hex(`${username}:${pin}:${env.AUTH_PEPPER || ''}`);
}
function cuitValido(c) {
  const d = (c || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s = 0; for (let i = 0; i < 10; i++) s += +d[i] * mult[i];
  let v = 11 - (s % 11); if (v === 11) v = 0;
  return v !== 10 && v === +d[10];
}
function te(s) { return new TextEncoder().encode(s); }
function cat(...a) { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; }
function b64url(i) { const b = i instanceof Uint8Array ? i : new Uint8Array(i); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); }
function b64ToBytes(s) { const p = '='.repeat((4 - s.length % 4) % 4); const b = (s + p).replace(/-/g, '+').replace(/_/g, '/'); return new Uint8Array([...atob(b)].map(c => c.charCodeAt(0))); }
function bytesToB64(bytes) { let s = ''; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }

// ── Fotos: R2 si existe el binding, sino KV ──────────────────────────────────
async function fotoPut(env, key, bytes) {
  if (env.FOTOS) return env.FOTOS.put(key, bytes);
  return env.FLOTA_KV.put('foto:' + key, bytes);
}
async function fotoGet(env, key) {
  if (env.FOTOS) { const o = await env.FOTOS.get(key); return o ? await o.arrayBuffer() : null; }
  return env.FLOTA_KV.get('foto:' + key, 'arrayBuffer');
}
async function fotoDelete(env, key) {
  if (!key) return;
  if (env.FOTOS) return env.FOTOS.delete(key).catch(() => { });
  return env.FLOTA_KV.delete('foto:' + key).catch(() => { });
}
async function fotoFirma(env, id, tipo) {
  return (await sha256hex(`fotolink:${id}:${tipo}:${env.AUTH_PEPPER || ''}`)).slice(0, 24);
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════════
async function getAuthUser(request, env) {
  const url = new URL(request.url);
  let token = url.searchParams.get('t') || '';
  const h = request.headers.get('Authorization') || '';
  if (h.startsWith('Bearer ')) token = h.slice(7);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.*, s.token FROM sesiones s JOIN usuarios u ON u.id=s.usuario_id
     WHERE s.token=? AND s.expira > datetime('now')`
  ).bind(token).first();
  return row || null;
}
const noAuth = () => json({ error: 'No autorizado' }, 401);

async function handleLogin(request, env) {
  const { username, pin } = await request.json().catch(() => ({}));
  const u = (username || '').trim().toLowerCase();
  if (!u || !/^\d{4,6}$/.test(pin || '')) return json({ error: 'Usuario y PIN de 4 dígitos requeridos' }, 400);
  const user = await env.DB.prepare('SELECT * FROM usuarios WHERE username=?').bind(u).first();
  if (!user) return json({ error: 'Usuario no encontrado' }, 404);
  if (user.bloqueado_hasta && new Date(user.bloqueado_hasta) > new Date())
    return json({ error: 'Cuenta bloqueada por intentos fallidos. Probá en 15 minutos.' }, 429);

  const hash = await hashPin(u, pin, env);
  let primerPin = false;
  if (!user.pin_hash) {
    // Primer ingreso: este PIN queda registrado
    await env.DB.prepare('UPDATE usuarios SET pin_hash=?, intentos_fallidos=0 WHERE id=?').bind(hash, user.id).run();
    primerPin = true;
  } else if (user.pin_hash !== hash) {
    const intentos = (user.intentos_fallidos || 0) + 1;
    const bloqueo = intentos >= 8 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
    await env.DB.prepare('UPDATE usuarios SET intentos_fallidos=?, bloqueado_hasta=? WHERE id=?')
      .bind(intentos, bloqueo, user.id).run();
    return json({ error: 'PIN incorrecto' }, 401);
  }
  await env.DB.prepare('UPDATE usuarios SET intentos_fallidos=0, bloqueado_hasta=NULL WHERE id=?').bind(user.id).run();

  const token = uuid() + uuid().replace(/-/g, '');
  const expira = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.prepare('INSERT INTO sesiones (token,usuario_id,expira) VALUES (?,?,?)').bind(token, user.id, expira).run();
  await env.DB.prepare("DELETE FROM sesiones WHERE expira < datetime('now')").run();
  const veh = user.vehiculo_id
    ? await env.DB.prepare('SELECT * FROM vehiculos WHERE id=?').bind(user.vehiculo_id).first() : null;
  return json({
    ok: true, token, primerPin,
    user: { username: user.username, nombre: user.nombre, rol: user.rol, email: user.email },
    vehiculo: veh,
  });
}
async function handleLogout(request, env) {
  const user = await getAuthUser(request, env);
  if (user) await env.DB.prepare('DELETE FROM sesiones WHERE token=?').bind(user.token).run();
  return json({ ok: true });
}
async function handleMe(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  const veh = user.vehiculo_id
    ? await env.DB.prepare('SELECT * FROM vehiculos WHERE id=?').bind(user.vehiculo_id).first() : null;
  const maint = veh ? await estadoMantenimiento(env, veh) : null;
  const vehiculos = await env.DB.prepare('SELECT * FROM vehiculos').all();
  return json({
    ok: true,
    user: { username: user.username, nombre: user.nombre, rol: user.rol, email: user.email },
    vehiculo: veh, mantenimiento: maint,
    vehiculos: user.rol === 'admin' ? vehiculos.results : undefined,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// GEMINI — extracción fiscal completa
// ══════════════════════════════════════════════════════════════════════════════
const TICKET_SCHEMA = `{
"tipo_comprobante":"TIQUE FACTURA A","codigo_comprobante":"081",
"punto_venta":"00011","numero_comprobante":"00033244",
"fecha":"YYYY-MM-DD","hora":"HH:MM:SS",
"emisor":{"razon_social":"","cuit":"XX-XXXXXXXX-X","domicilio":"","localidad":"","iibb":"","condicion_iva":""},
"receptor":{"nombre":"","cuit":""},
"items":[{"descripcion":"","litros":0.0,"precio_unitario":0.0,"importe":0.0}],
"montos":{"neto_gravado":0.0,"iva_alicuota":21.0,"iva":0.0,"otros_tributos":0.0,"percepciones":0.0,"exento":0.0,"no_gravado":0.0,"total":0.0},
"condicion_pago":"CONTADO",
"confianza":95,
"advertencias":[]
}`;

async function geminiTicket(b64, env) {
  const prompt = `Extraé TODOS los datos fiscales de esta foto de un ticket de combustible argentino (tique factura de controlador fiscal).

GUÍA DE LECTURA del ticket:
- ENCABEZADO: razón social del emisor (estación de servicio), "C.U.I.T. Nro", "Ing. Brutos" (IIBB), domicilio/localidad, "Inicio de Actividades", condición IVA del emisor.
- TIPO: línea tipo 'TIQUE FACTURA "A" (Cód.081)' → tipo_comprobante="TIQUE FACTURA A", codigo_comprobante="081".
- NÚMERO: formato "N° 00011-00033244" → punto_venta="00011", numero_comprobante="00033244". A veces aparece como "Nº PPPPP-NNNNNNNN" cerca de Fecha/Hora.
- RECEPTOR (cliente): nombre y "C.U.I.T. Nro" del cliente, condición IVA.
- DETALLE: producto (SUPER, INFINIA DIESEL, ULTRA DIESEL, etc.), litros y precio: puede venir como "21,40 LS A $ 2336,000" o "1,0000 u x 20821,8100 / SUPER / 9 $ 2075 C: 14.457".
- MONTOS: "SUBTOT. IMP. NETO GRAVADO"=neto_gravado; "ALICUOTA 21,00%" o "IMPORTE TOTAL IVA"=iva (iva_alicuota=21.0); "Impuesto interno a nivel item"/"IMPORTE TOTAL OTROS TRIBUTOS" (ITC/IDC/ICL/TCNG)=otros_tributos; "Percepción" IIBB si existe=percepciones; "TOTAL"=total.
- PAGO: "CONDICION:CONTADO", "Efectivo", "RECIBI/MOS", tarjeta, etc.

REGLAS:
- Números argentinos: coma decimal, punto de miles → 20821,81 = 20821.81. En litros "21,40" = 21.40.
- Si un campo no aparece o no es legible: null (no inventes).
- Verificá: neto_gravado + iva + otros_tributos + percepciones ≈ total. Si no cierra, revisá tu lectura y anotalo en advertencias.
- confianza: 0-100 global según nitidez.
- advertencias: lista de strings con cualquier duda.

Devolvé SOLO este JSON:
${TICKET_SCHEMA}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'Sos un contador argentino experto en comprobantes fiscales de estaciones de servicio. Extraés datos con máxima precisión para el Libro IVA Compras (ARCA). Respondés SOLO JSON válido.' }] },
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
    });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error('Gemini ticket: ' + (e.error?.message || res.status)); }
  const data = await res.json();
  return JSON.parse(data.candidates[0].content.parts[0].text.trim());
}

async function geminiOdometro(b64, env) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'Sos experto en lectura de tableros de vehículos. Respondés SOLO JSON válido.' }] },
        contents: [{ role: 'user', parts: [
          { text: 'Leé el ODÓMETRO (kilometraje total del vehículo) en esta foto de tablero. Es el número más grande de dígitos (5-6 cifras), NO el trip parcial (que tiene decimales), NO el reloj, NO las RPM. Devolvé SOLO JSON: {"km":123456,"confianza":95}. Si no es legible: {"km":null,"confianza":0}.' },
          { inlineData: { mimeType: 'image/jpeg', data: b64 } },
        ] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
    });
  if (!res.ok) throw new Error('Gemini odómetro: ' + res.status);
  const data = await res.json();
  return JSON.parse(data.candidates[0].content.parts[0].text.trim());
}

// ══════════════════════════════════════════════════════════════════════════════
// VALIDACIÓN — compartida entre carga nueva, reprocesar y retake de una sola foto
// ══════════════════════════════════════════════════════════════════════════════
const KM_WARN_KEYS = ['ocr_km_fallo', 'km_confianza_baja', 'km_menor_al_anterior', 'salto_km_grande'];

function calcularWarningsTicket(t, veh) {
  const w = [];
  if (!t) { w.push('ocr_ticket_fallo'); return w; }
  const m = t.montos || {};
  const it = (t.items && t.items[0]) || {};
  const partes = (m.neto_gravado || 0) + (m.iva || 0) + (m.otros_tributos || 0) + (m.percepciones || 0) + (m.exento || 0) + (m.no_gravado || 0);
  if (m.total > 0 && partes > 0 && Math.abs(partes - m.total) > 1) w.push('montos_no_cierran');
  if (it.litros > 0 && it.precio_unitario > 0 && m.neto_gravado > 0 &&
    Math.abs(it.litros * it.precio_unitario - m.neto_gravado) / m.neto_gravado > 0.03) w.push('litros_x_precio_no_coincide');
  if (t.emisor?.cuit && !cuitValido(t.emisor.cuit)) w.push('cuit_emisor_invalido');
  if (t.receptor?.cuit && !cuitValido(t.receptor.cuit)) w.push('cuit_receptor_invalido');
  if (!t.numero_comprobante) w.push('sin_numero_comprobante');
  if (!m.total) w.push('sin_total');
  if ((t.confianza ?? 0) < 70) w.push('confianza_baja');
  if (it.litros > veh.tanque_litros) w.push('litros_superan_tanque');
  if (t.fecha) {
    const dif = (new Date(hoyAR()) - new Date(t.fecha)) / 86400000;
    if (dif > 7 || dif < -1) w.push('fecha_fuera_de_rango');
  } else w.push('sin_fecha');
  return w;
}
async function comprobanteDuplicado(env, t, idExcluir) {
  if (!t?.numero_comprobante || !t.emisor?.cuit) return false;
  const ya = await env.DB.prepare(
    'SELECT id FROM cargas WHERE numero_comprobante=? AND emisor_cuit=? AND punto_venta IS ? AND id!=?'
  ).bind(t.numero_comprobante, t.emisor.cuit, t.punto_venta ?? null, idExcluir || '').first();
  return !!ya;
}
function calcularWarningsKm(km, kmData, seFotografio, veh) {
  const w = [];
  if (seFotografio && !km) w.push('ocr_km_fallo');
  if (km) {
    if ((kmData.confianza ?? 0) < 70) w.push('km_confianza_baja');
    if (veh.km_actual > 0 && km < veh.km_actual) w.push('km_menor_al_anterior');
    if (veh.km_actual > 0 && km - veh.km_actual > 3000) w.push('salto_km_grande');
  }
  return w;
}

// ══════════════════════════════════════════════════════════════════════════════
// CARGAS — pipeline principal
// ══════════════════════════════════════════════════════════════════════════════
async function handleNuevaCarga(request, env, ctx) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  const body = await request.json().catch(() => null);
  if (!body?.id || !body?.fotoTicket) return json({ error: 'Faltan id o fotoTicket' }, 400);

  const vehiculoId = user.rol === 'admin' ? (body.vehiculoId || user.vehiculo_id) : user.vehiculo_id;
  if (!vehiculoId) return json({ error: 'Sin vehículo asignado' }, 400);
  const veh = await env.DB.prepare('SELECT * FROM vehiculos WHERE id=?').bind(vehiculoId).first();
  if (!veh) return json({ error: 'Vehículo inexistente' }, 400);

  // Idempotencia: si ya existe esta carga (reintento offline), devolverla
  const dup = await env.DB.prepare('SELECT * FROM cargas WHERE id=?').bind(body.id).first();
  if (dup) return json({ ok: true, duplicada: true, carga: publicCarga(dup) });

  const stripB64 = s => (s || '').includes(',') ? s.split(',')[1] : (s || '');
  const tB64 = stripB64(body.fotoTicket);
  const kB64 = stripB64(body.fotoTablero);

  // 1. Guardar fotos PRIMERO (la foto es la fuente de verdad; nunca se pierde)
  const fotoTicketKey = `${body.id}/ticket.jpg`;
  const fotoTableroKey = kB64 ? `${body.id}/tablero.jpg` : null;
  await fotoPut(env, fotoTicketKey, b64ToBytes(tB64));
  if (fotoTableroKey) await fotoPut(env, fotoTableroKey, b64ToBytes(kB64));

  // 2. OCR en paralelo
  let t = null, kmData = null, ocrErr = null;
  const [tRes, kRes] = await Promise.allSettled([
    geminiTicket(tB64, env),
    kB64 ? geminiOdometro(kB64, env) : Promise.resolve(null),
  ]);
  if (tRes.status === 'fulfilled') t = tRes.value; else ocrErr = tRes.reason?.message;
  if (kRes.status === 'fulfilled') kmData = kRes.value;

  // 3. Validaciones (server-side, el chofer no toca nada)
  const m = t?.montos || {};
  const it = (t?.items && t.items[0]) || {};
  const km = kmData?.km > 0 ? Math.round(kmData.km) : null;

  const w = calcularWarningsTicket(t, veh);
  if (t && await comprobanteDuplicado(env, t, body.id)) w.push('comprobante_duplicado');
  w.push(...calcularWarningsKm(km, kmData, !!kB64, veh));
  // Notas informativas de la IA: se guardan pero NO fuerzan revisión
  const notas = [];
  if (t && Array.isArray(t.advertencias)) t.advertencias.forEach(a => a && notas.push(String(a).slice(0, 120)));
  const validacion = w.length ? 'revisar' : 'ok';
  const fecha = t?.fecha || hoyAR();

  // 4. Insertar
  await env.DB.prepare(`INSERT INTO cargas
    (id,vehiculo_id,usuario_id,usuario_nombre,fecha,hora,tipo_comprobante,codigo_comprobante,punto_venta,numero_comprobante,
     emisor_razon_social,emisor_cuit,emisor_domicilio,emisor_localidad,emisor_iibb,emisor_condicion_iva,
     receptor_nombre,receptor_cuit,producto,litros,precio_unitario,neto_gravado,iva_alicuota,iva,
     otros_tributos,percepciones,exento,no_gravado,total,condicion_pago,km,km_confianza,confianza,
     validacion,validacion_detalle,foto_ticket,foto_tablero,original_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      body.id, vehiculoId, user.id, user.nombre, fecha, t?.hora?.slice(0, 8) ?? null,
      t?.tipo_comprobante ?? null, t?.codigo_comprobante ?? null, t?.punto_venta ?? null, t?.numero_comprobante ?? null,
      t?.emisor?.razon_social ?? null, t?.emisor?.cuit ?? null, t?.emisor?.domicilio ?? null,
      t?.emisor?.localidad ?? null, t?.emisor?.iibb ?? null, t?.emisor?.condicion_iva ?? null,
      t?.receptor?.nombre ?? null, t?.receptor?.cuit ?? null,
      it.descripcion ?? null, it.litros ?? null, it.precio_unitario ?? null,
      m.neto_gravado ?? null, m.iva_alicuota ?? null, m.iva ?? null,
      m.otros_tributos ?? null, m.percepciones ?? null, m.exento ?? null, m.no_gravado ?? null,
      m.total ?? null, t?.condicion_pago ?? null, km, kmData?.confianza ?? null, t?.confianza ?? null,
      validacion, JSON.stringify({ warnings: w, notas, ocrErr }), fotoTicketKey, fotoTableroKey,
      t ? JSON.stringify(t) : null,
    ).run();

  // 5. Actualizar KM del vehículo (solo si avanza)
  if (km && km > (veh.km_actual || 0)) {
    await env.DB.prepare('UPDATE vehiculos SET km_actual=? WHERE id=?').bind(km, vehiculoId).run();
    veh.km_actual = km;
  }

  const carga = await env.DB.prepare('SELECT * FROM cargas WHERE id=?').bind(body.id).first();

  // 6. Notificaciones en background
  ctx.waitUntil((async () => {
    try { await emailConfirmacion(env, carga, veh, user); } catch (e) { console.error('email conf:', e.message); }
    try { await checkMantenimiento(env, veh); } catch (e) { console.error('maint:', e.message); }
    if (validacion === 'revisar') {
      try {
        await pushToAdmins(env, {
          title: '🔍 Carga para revisar', tag: 'revision',
          body: `${veh.emoji} ${veh.nombre} — ${user.nombre}. Motivos: ${w.slice(0, 3).join(', ')}`,
        });
      } catch (e) { }
    }
  })());

  return json({ ok: true, carga: publicCarga(carga) });
}

function publicCarga(c) {
  const { original_json, ...rest } = c;
  try { rest.warnings = JSON.parse(c.validacion_detalle || '{}').warnings || []; } catch (e) { rest.warnings = []; }
  return rest;
}

async function handleGetCargas(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  const url = new URL(request.url);
  const month = url.searchParams.get('month');
  const dias = parseInt(url.searchParams.get('dias') || '0');
  let vehiculo = url.searchParams.get('vehiculo') || '';
  if (user.rol !== 'admin') vehiculo = user.vehiculo_id || '__ninguno__';

  let where = [], binds = [];
  if (month) { where.push("substr(fecha,1,7)=?"); binds.push(month); }
  else if (dias > 0) { where.push("fecha >= date('now', ?)"); binds.push(`-${dias} days`); }
  if (vehiculo) { where.push('vehiculo_id=?'); binds.push(vehiculo); }
  const sql = `SELECT * FROM cargas ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY fecha DESC, hora DESC LIMIT 500`;
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return json({ ok: true, cargas: rows.results.map(publicCarga) });
}

async function handleFoto(request, env, id, tipo, firmada) {
  const url = new URL(request.url);
  if (firmada) {
    const k = url.searchParams.get('k') || '';
    if (k !== await fotoFirma(env, id, tipo)) return json({ error: 'Firma inválida' }, 403);
  } else {
    const user = await getAuthUser(request, env);
    if (!user) return noAuth();
  }
  const carga = await env.DB.prepare('SELECT foto_ticket,foto_tablero FROM cargas WHERE id=?').bind(id).first();
  const key = tipo === 'ticket' ? carga?.foto_ticket : carga?.foto_tablero;
  if (!key) return json({ error: 'Sin foto' }, 404);
  const bytes = await fotoGet(env, key);
  if (!bytes) return json({ error: 'Foto no encontrada' }, 404);
  return new Response(bytes, { headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORT CSV — Libro IVA Compras (ARCA)
// ══════════════════════════════════════════════════════════════════════════════
async function cargasDelMes(env, month) {
  const r = await env.DB.prepare(
    "SELECT * FROM cargas WHERE substr(fecha,1,7)=? ORDER BY fecha, hora").bind(month).all();
  return r.results;
}
const csvNum = n => n === null || n === undefined ? '' : String(n).replace('.', ',');
async function buildCSV(env, rows, origin) {
  const header = ['Fecha', 'Hora', 'Vehiculo', 'Chofer', 'Tipo Comprobante', 'Cod AFIP', 'Punto Venta', 'Numero',
    'CUIT Emisor', 'Razon Social Emisor', 'Domicilio Emisor', 'CUIT Receptor', 'Producto', 'Litros', 'Precio Unitario',
    'Neto Gravado', 'Alicuota IVA', 'IVA', 'Otros Tributos (ITC/IDC)', 'Percepciones', 'Exento', 'No Gravado', 'Total',
    'Condicion Pago', 'KM', 'Estado', 'Foto Ticket'];
  const lines = [header.join(';')];
  for (const c of rows) {
    const foto = c.foto_ticket ? `${origin}/api/fotolink/${c.id}/ticket?k=${await fotoFirma(env, c.id, 'ticket')}` : '';
    lines.push([
      c.fecha, c.hora || '', c.vehiculo_id, (c.usuario_nombre || '').replace(/;/g, ','),
      c.tipo_comprobante || '', c.codigo_comprobante || '', c.punto_venta || '', c.numero_comprobante || '',
      c.emisor_cuit || '', (c.emisor_razon_social || '').replace(/;/g, ','), (c.emisor_domicilio || '').replace(/;/g, ','),
      c.receptor_cuit || '', (c.producto || '').replace(/;/g, ','), csvNum(c.litros), csvNum(c.precio_unitario),
      csvNum(c.neto_gravado), csvNum(c.iva_alicuota), csvNum(c.iva), csvNum(c.otros_tributos), csvNum(c.percepciones),
      csvNum(c.exento), csvNum(c.no_gravado), csvNum(c.total), c.condicion_pago || '', c.km ?? '', c.validacion, foto,
    ].join(';'));
  }
  return '﻿' + lines.join('\r\n');
}
async function handleExportCSV(request, env) {
  const user = await getAuthUser(request, env);
  if (!user || user.rol !== 'admin') return noAuth();
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || hoyAR().slice(0, 7);
  const rows = await cargasDelMes(env, month);
  const csv = await buildCSV(env, rows, url.origin);
  return new Response(csv, {
    headers: {
      ...CORS, 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="flota-ml-${month}.csv"`,
    },
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVICIOS (mantenimiento)
// ══════════════════════════════════════════════════════════════════════════════
async function handleNuevoServicio(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  const b = await request.json().catch(() => ({}));
  const vehiculoId = user.rol === 'admin' ? (b.vehiculoId || user.vehiculo_id) : user.vehiculo_id;
  if (!vehiculoId || !b.tipo || !b.fecha || !b.km) return json({ error: 'Faltan datos (tipo, fecha, km)' }, 400);
  const proximoCadaKm = Math.round(b.proximoCadaKm || 10000);
  if (proximoCadaKm < 500 || proximoCadaKm > 50000)
    return json({ error: 'El intervalo del próximo service debe ser un número entre 500 y 50.000 km (¿pusiste el KM absoluto del próximo cambio en vez del intervalo?)' }, 400);
  const id = uuid();
  await env.DB.prepare(`INSERT INTO servicios (id,vehiculo_id,usuario_id,tipo,fecha,km,proximo_cada_km,taller,notas)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, vehiculoId, user.id, b.tipo, b.fecha, Math.round(b.km), proximoCadaKm,
      b.taller || null, b.notas || null).run();
  await env.DB.prepare('UPDATE vehiculos SET km_actual=MAX(km_actual,?) WHERE id=?').bind(Math.round(b.km), vehiculoId).run();
  await env.DB.prepare("DELETE FROM alertas_enviadas WHERE clave LIKE ?").bind(`maint:${vehiculoId}:%`).run();
  return json({ ok: true, id });
}

// ── OCR de tarjeta de servicio — layout varía según el taller ────────────────
async function geminiServicio(b64, env) {
  const prompt = `Extraé los datos de esta foto de una tarjeta/etiqueta de servicio de taller (cambio de aceite, service, etc). El diseño VARÍA mucho según el taller — puede ser una tarjeta impresa con casilleros, una etiqueta autoadhesiva, o un ticket. Buscá estos conceptos sin importar cómo estén rotulados exactamente:

- fecha del service (puede estar en 3 casilleros separados día/mes/año, o junto).
- km: el kilometraje del vehículo EN EL MOMENTO de este service (no el próximo).
- proximo_km_absoluto: si la tarjeta indica el kilometraje ABSOLUTO del próximo cambio (ej: "PRÓXIMO CAMBIO KM: 92295", "Next service at: 145000"), poné ese número tal cual.
- proximo_intervalo: si en cambio la tarjeta indica un INTERVALO (ej: "cada 10.000 km", "next 5000 km"), poné ese número. Si hay AMBOS o ninguno, dejá el que corresponda en null.
- taller: nombre del comercio/taller (suele estar en el logo o encabezado).
- items: array corto de strings con lo que se hizo (ej: "Aceite Shell 5W40", "Filtro de aceite", "Filtro de aire", "Filtro de combustible", "Filtro de habitáculo", "Engrase", "Aditivos", "Caja", "Diferencial") — incluí solo los que la tarjeta marca como hechos (tildados, "SI", o con datos escritos); ignorá los casilleros vacíos o tachados.
- confianza: 0-100 según nitidez y qué tan seguro estás de la lectura.

Devolvé SOLO este JSON:
{"fecha":"YYYY-MM-DD","km":82295,"proximo_km_absoluto":92295,"proximo_intervalo":null,"taller":"Lube Stop","items":["Aceite Shell 5W40","Filtro de aceite"],"confianza":90}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'Sos experto en leer tarjetas de service de talleres mecánicos argentinos, con diseños muy variables entre talleres. Respondés SOLO JSON válido.' }] },
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
    });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error('Gemini servicio: ' + (e.error?.message || res.status)); }
  const data = await res.json();
  return JSON.parse(data.candidates[0].content.parts[0].text.trim());
}

async function handleServicioFoto(request, env, ctx) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  const b = await request.json().catch(() => ({}));
  const vehiculoId = user.rol === 'admin' ? (b.vehiculoId || user.vehiculo_id) : user.vehiculo_id;
  if (!vehiculoId || !b.foto) return json({ error: 'Faltan datos (vehículo o foto)' }, 400);
  const veh = await env.DB.prepare('SELECT * FROM vehiculos WHERE id=?').bind(vehiculoId).first();
  if (!veh) return json({ error: 'Vehículo inexistente' }, 400);

  const b64 = b.foto.includes(',') ? b.foto.split(',')[1] : b.foto;
  const id = uuid();
  const fotoKey = `servicio/${id}.jpg`;
  await fotoPut(env, fotoKey, b64ToBytes(b64));

  let t = null, ocrErr = null;
  try { t = await geminiServicio(b64, env); } catch (err) { ocrErr = err.message; }

  const w = [];
  if (!t) w.push('ocr_servicio_fallo');
  let km = null, proximoCadaKm = null, tipo = 'oil-change', taller = null, notas = null, confianza = null;
  if (t) {
    km = Number.isFinite(t.km) ? Math.round(t.km) : null;
    if (!km) w.push('sin_km');
    else if (veh.km_actual > 0 && km < veh.km_actual - 500) w.push('km_menor_al_actual');
    taller = t.taller || null;
    notas = Array.isArray(t.items) && t.items.length ? t.items.join(', ') : null;
    confianza = Number.isFinite(t.confianza) ? Math.round(t.confianza) : null;
    if ((confianza ?? 0) < 70) w.push('confianza_baja');

    if (Number.isFinite(t.proximo_km_absoluto) && km) proximoCadaKm = Math.round(t.proximo_km_absoluto) - km;
    else if (Number.isFinite(t.proximo_intervalo)) proximoCadaKm = Math.round(t.proximo_intervalo);
    if (proximoCadaKm !== null && (proximoCadaKm < 500 || proximoCadaKm > 50000)) {
      w.push('intervalo_fuera_de_rango');
      proximoCadaKm = 10000; // fallback razonable, queda marcado para revisar
    }
    if (proximoCadaKm === null) { w.push('sin_intervalo_service'); proximoCadaKm = 10000; }
  }
  const fecha = t?.fecha || hoyAR();
  const validacion = w.length ? 'revisar' : 'ok';

  await env.DB.prepare(`INSERT INTO servicios (id,vehiculo_id,usuario_id,tipo,fecha,km,proximo_cada_km,taller,notas,foto,confianza,validacion,validacion_detalle)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, vehiculoId, user.id, tipo, fecha, km, proximoCadaKm, taller, notas, fotoKey, confianza,
      validacion, JSON.stringify({ warnings: w, ocrErr })).run();
  if (km && km > (veh.km_actual || 0)) {
    await env.DB.prepare('UPDATE vehiculos SET km_actual=? WHERE id=?').bind(km, vehiculoId).run();
    veh.km_actual = km;
  }
  await env.DB.prepare("DELETE FROM alertas_enviadas WHERE clave LIKE ?").bind(`maint:${vehiculoId}:%`).run();

  if (validacion === 'revisar') {
    ctx.waitUntil(pushToAdmins(env, {
      title: '🔍 Service para revisar', tag: 'revision-servicio',
      body: `${veh.emoji} ${veh.nombre} — ${user.nombre}. Motivos: ${w.slice(0, 3).join(', ')}`,
    }).catch(() => { }));
  }

  const registro = await env.DB.prepare('SELECT * FROM servicios WHERE id=?').bind(id).first();
  const { validacion_detalle, ...rest } = registro;
  rest.warnings = w;
  return json({ ok: true, servicio: rest });
}
async function handleServicioFotoGet(request, env, id) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  const s = await env.DB.prepare('SELECT foto FROM servicios WHERE id=?').bind(id).first();
  if (!s?.foto) return json({ error: 'Sin foto' }, 404);
  const bytes = await fotoGet(env, s.foto);
  if (!bytes) return json({ error: 'Foto no encontrada' }, 404);
  return new Response(bytes, { headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
}
async function handleGetServicios(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  const url = new URL(request.url);
  let vehiculo = url.searchParams.get('vehiculo') || user.vehiculo_id;
  if (user.rol !== 'admin') vehiculo = user.vehiculo_id;
  const rows = vehiculo
    ? await env.DB.prepare('SELECT * FROM servicios WHERE vehiculo_id=? ORDER BY fecha DESC LIMIT 100').bind(vehiculo).all()
    : await env.DB.prepare('SELECT * FROM servicios ORDER BY fecha DESC LIMIT 100').all();
  const servicios = rows.results.map(s => {
    const { validacion_detalle, ...rest } = s;
    try { rest.warnings = JSON.parse(validacion_detalle || '{}').warnings || []; } catch (e) { rest.warnings = []; }
    return rest;
  });
  return json({ ok: true, servicios });
}

async function estadoMantenimiento(env, veh) {
  const last = await env.DB.prepare(
    'SELECT * FROM servicios WHERE vehiculo_id=? ORDER BY km DESC LIMIT 1').bind(veh.id).first();
  if (!last || !veh.km_actual) return null;
  const proximoKm = last.km + (last.proximo_cada_km || 10000);
  return {
    ultimoKm: last.km, proximoKm, kmRestantes: proximoKm - veh.km_actual,
    intervalo: last.proximo_cada_km || 10000,
    pct: Math.max(0, Math.min(100, Math.round((veh.km_actual - last.km) / (last.proximo_cada_km || 10000) * 100))),
  };
}
async function checkMantenimiento(env, veh) {
  const st = await estadoMantenimiento(env, veh);
  if (!st) return;
  const marcar = async clave => {
    const ya = await env.DB.prepare('SELECT 1 FROM alertas_enviadas WHERE clave=?').bind(clave).first();
    if (ya) return false;
    await env.DB.prepare('INSERT OR IGNORE INTO alertas_enviadas (clave) VALUES (?)').bind(clave).run();
    return true;
  };

  // Tier 1 — 1000km antes: aviso anticipado por email (fleet/admin, para coordinar taller con tiempo)
  if (st.kmRestantes <= 1000 && st.kmRestantes > 500 && env.SENDGRID_API_KEY) {
    if (await marcar(`maint:${veh.id}:${st.proximoKm}:1000`)) {
      const to = [env.FLEET_EMAIL || env.OWNER_EMAIL || env.FROM_EMAIL];
      await sendViaBrevo({
        to, subject: `🔧 Servicio próximo — ${veh.emoji} ${veh.nombre} (faltan ${fmtN(st.kmRestantes)} km)`,
        html: buildMaintEmail(veh, st, false),
      }, env);
    }
  }
  // Tier 2 — 500km antes: push al chofer + admin (pushToVehicle ya incluye admins)
  if (st.kmRestantes <= 500 && st.kmRestantes > 0) {
    if (await marcar(`maint:${veh.id}:${st.proximoKm}:500`)) {
      await pushToVehicle(env, veh.id, {
        title: `🔧 Servicio próximo — ${veh.nombre}`,
        body: `Faltan ${fmtN(st.kmRestantes)} km para el cambio de aceite.`,
        tag: 'maint-' + veh.id,
      });
    }
  }
  // Tier 3 — llegó o pasó el km objetivo: URGENTE. Push a chofer+admin, email al administrador.
  if (st.kmRestantes <= 0) {
    if (await marcar(`maint:${veh.id}:${st.proximoKm}:vencido`)) {
      await pushToVehicle(env, veh.id, {
        title: `🛑 ¡Es hora del cambio de aceite! — ${veh.nombre}`,
        body: `Llegaste a los ${fmtN(st.proximoKm)} km previstos. Coordiná el taller cuanto antes.`,
        tag: 'maint-venc-' + veh.id,
      });
      if (env.SENDGRID_API_KEY) {
        const to = [env.OWNER_EMAIL || env.FLEET_EMAIL || env.FROM_EMAIL];
        await sendViaBrevo({
          to, subject: `🛑 ¡Service vencido! — ${veh.emoji} ${veh.nombre}`,
          html: buildMaintEmail(veh, st, true),
        }, env);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════════
async function reqAdmin(request, env) {
  const user = await getAuthUser(request, env);
  return user && user.rol === 'admin' ? user : null;
}
async function handleAdminUsuarios(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const rows = await env.DB.prepare(
    `SELECT u.id,u.username,u.nombre,u.rol,u.email,u.vehiculo_id,u.creado,
            (u.pin_hash IS NOT NULL) AS tiene_pin,
            (SELECT COUNT(*) FROM push_subs p WHERE p.usuario_id=u.id) AS push_activo
     FROM usuarios u ORDER BY u.rol DESC, u.username`).all();
  return json({ ok: true, usuarios: rows.results });
}
async function handleAdminAsignar(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const { username, vehiculoId } = await request.json().catch(() => ({}));
  if (!username) return json({ error: 'Faltan datos' }, 400);
  const r = await env.DB.prepare('UPDATE usuarios SET vehiculo_id=? WHERE username=?')
    .bind(vehiculoId || null, username.toLowerCase()).run();
  if (!r.meta.changes) return json({ error: 'Usuario no encontrado' }, 404);
  return json({ ok: true });
}

async function handleAdminCrearVehiculo(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const b = await request.json().catch(() => ({}));
  const nombre = (b.nombre || '').trim();
  if (!nombre) return json({ error: 'Falta el nombre' }, 400);
  let base = nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || ('vehiculo-' + Date.now());
  let id = base, i = 2;
  while (await env.DB.prepare('SELECT 1 FROM vehiculos WHERE id=?').bind(id).first()) id = `${base}-${i++}`;
  await env.DB.prepare(`INSERT INTO vehiculos (id,nombre,emoji,descripcion,tanque_litros,km_actual,service_cada_km)
    VALUES (?,?,?,?,?,?,?)`).bind(
    id, nombre, (b.emoji || '🚗').slice(0, 4), b.descripcion || '',
    Math.round(b.tanqueLitros) || 60, Math.round(b.kmActual) || 0, Math.round(b.serviceCadaKm) || 10000,
  ).run();
  return json({ ok: true, id });
}
async function handleAdminEditarVehiculo(request, env, vehiculoId) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const b = await request.json().catch(() => ({}));
  const nombre = (b.nombre || '').trim();
  if (!nombre) return json({ error: 'Falta el nombre' }, 400);
  const r = await env.DB.prepare(`UPDATE vehiculos SET nombre=?, emoji=?, descripcion=?, tanque_litros=?, service_cada_km=? WHERE id=?`)
    .bind(nombre, (b.emoji || '🚗').slice(0, 4), b.descripcion || '',
      Math.round(b.tanqueLitros) || 60, Math.round(b.serviceCadaKm) || 10000, vehiculoId).run();
  if (!r.meta.changes) return json({ error: 'Vehículo no encontrado' }, 404);
  // El intervalo de service pudo cambiar — limpiar avisos de mantenimiento ya
  // enviados para que se recalculen contra el nuevo umbral en vez de quedar
  // silenciados por avisos viejos basados en el intervalo anterior.
  await env.DB.prepare("DELETE FROM alertas_enviadas WHERE clave LIKE ?").bind(`maint:${vehiculoId}:%`).run();
  return json({ ok: true });
}
async function handleAdminSetKm(request, env, vehiculoId) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const { km } = await request.json().catch(() => ({}));
  if (!Number.isFinite(km) || km < 0) return json({ error: 'KM inválido' }, 400);
  const r = await env.DB.prepare('UPDATE vehiculos SET km_actual=? WHERE id=?').bind(Math.round(km), vehiculoId).run();
  if (!r.meta.changes) return json({ error: 'Vehículo no encontrado' }, 404);
  await env.DB.prepare("DELETE FROM alertas_enviadas WHERE clave LIKE ?").bind(`maint:${vehiculoId}:%`).run();
  return json({ ok: true });
}
async function handleAdminResetPin(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const { username } = await request.json().catch(() => ({}));
  const u = await env.DB.prepare('SELECT id FROM usuarios WHERE username=?').bind((username || '').toLowerCase()).first();
  if (!u) return json({ error: 'Usuario no encontrado' }, 404);
  await env.DB.prepare('UPDATE usuarios SET pin_hash=NULL, intentos_fallidos=0, bloqueado_hasta=NULL WHERE id=?').bind(u.id).run();
  await env.DB.prepare('DELETE FROM sesiones WHERE usuario_id=?').bind(u.id).run();
  return json({ ok: true, msg: 'El próximo PIN que ingrese quedará registrado' });
}

const CAMPOS_CORREGIBLES = ['fecha', 'hora', 'tipo_comprobante', 'codigo_comprobante', 'punto_venta', 'numero_comprobante',
  'emisor_razon_social', 'emisor_cuit', 'emisor_domicilio', 'emisor_localidad', 'emisor_iibb', 'emisor_condicion_iva',
  'receptor_nombre', 'receptor_cuit', 'producto', 'litros', 'precio_unitario', 'neto_gravado', 'iva_alicuota', 'iva',
  'otros_tributos', 'percepciones', 'exento', 'no_gravado', 'total', 'condicion_pago', 'km'];

async function handleAdminCorregir(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const { id, campos, marcarOk } = await request.json().catch(() => ({}));
  const carga = await env.DB.prepare('SELECT * FROM cargas WHERE id=?').bind(id).first();
  if (!carga) return json({ error: 'Carga no encontrada' }, 404);
  const sets = [], binds = [];
  for (const [k, v] of Object.entries(campos || {})) {
    if (!CAMPOS_CORREGIBLES.includes(k)) continue;
    sets.push(`${k}=?`); binds.push(v === '' ? null : v);
  }
  if (marcarOk) { sets.push("validacion='ok'"); }
  if (!sets.length) return json({ error: 'Nada para corregir' }, 400);
  sets.push('corregido_por=?', "corregido_en=datetime('now')");
  binds.push(admin.username, id);
  await env.DB.prepare(`UPDATE cargas SET ${sets.join(',')} WHERE id=?`).bind(...binds).run();
  if (campos?.km) await env.DB.prepare('UPDATE vehiculos SET km_actual=MAX(km_actual,?) WHERE id=?')
    .bind(Math.round(campos.km), carga.vehiculo_id).run();
  const updated = await env.DB.prepare('SELECT * FROM cargas WHERE id=?').bind(id).first();
  return json({ ok: true, carga: publicCarga(updated) });
}

async function handleAdminReprocesar(request, env, ctx) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const { id } = await request.json().catch(() => ({}));
  const carga = await env.DB.prepare('SELECT * FROM cargas WHERE id=?').bind(id).first();
  if (!carga?.foto_ticket) return json({ error: 'Carga sin foto para reprocesar' }, 404);
  const veh = await env.DB.prepare('SELECT * FROM vehiculos WHERE id=?').bind(carga.vehiculo_id).first();
  const bytes = await fotoGet(env, carga.foto_ticket);
  if (!bytes) return json({ error: 'Foto no encontrada en storage' }, 404);
  const b64 = bytesToB64(bytes);
  const t = await geminiTicket(b64, env);
  const m = t.montos || {}, it = (t.items && t.items[0]) || {};

  // Recalcular warnings: los de ticket se rehacen, los de km se conservan tal cual estaban
  let warnings = [], notas = [];
  try { const d = JSON.parse(carga.validacion_detalle || '{}'); warnings = d.warnings || []; notas = d.notas || []; } catch (e) { }
  const kmWarnsPrevios = warnings.filter(w => KM_WARN_KEYS.includes(w));
  const ticketWarns = calcularWarningsTicket(t, veh);
  if (await comprobanteDuplicado(env, t, id)) ticketWarns.push('comprobante_duplicado');
  notas = []; if (Array.isArray(t.advertencias)) t.advertencias.forEach(a => a && notas.push(String(a).slice(0, 120)));
  const nuevosWarnings = [...kmWarnsPrevios, ...ticketWarns];
  const validacion = nuevosWarnings.length ? 'revisar' : 'ok';

  await env.DB.prepare(`UPDATE cargas SET
    fecha=COALESCE(?,fecha),hora=?,tipo_comprobante=?,codigo_comprobante=?,punto_venta=?,numero_comprobante=?,
    emisor_razon_social=?,emisor_cuit=?,emisor_domicilio=?,emisor_localidad=?,emisor_iibb=?,emisor_condicion_iva=?,
    receptor_nombre=?,receptor_cuit=?,producto=?,litros=?,precio_unitario=?,neto_gravado=?,iva_alicuota=?,iva=?,
    otros_tributos=?,percepciones=?,exento=?,no_gravado=?,total=?,condicion_pago=?,confianza=?,
    validacion=?,validacion_detalle=?,original_json=?,corregido_por=?,corregido_en=datetime('now')
    WHERE id=?`).bind(
    t.fecha ?? null, t.hora?.slice(0, 8) ?? null, t.tipo_comprobante ?? null, t.codigo_comprobante ?? null,
    t.punto_venta ?? null, t.numero_comprobante ?? null,
    t.emisor?.razon_social ?? null, t.emisor?.cuit ?? null, t.emisor?.domicilio ?? null, t.emisor?.localidad ?? null,
    t.emisor?.iibb ?? null, t.emisor?.condicion_iva ?? null, t.receptor?.nombre ?? null, t.receptor?.cuit ?? null,
    it.descripcion ?? null, it.litros ?? null, it.precio_unitario ?? null, m.neto_gravado ?? null,
    m.iva_alicuota ?? null, m.iva ?? null, m.otros_tributos ?? null, m.percepciones ?? null, m.exento ?? null,
    m.no_gravado ?? null, m.total ?? null, t.condicion_pago ?? null, t.confianza ?? null,
    validacion, JSON.stringify({ warnings: nuevosWarnings, notas }), JSON.stringify(t), 'reproceso:' + admin.username, id,
  ).run();
  const updated = await env.DB.prepare('SELECT * FROM cargas WHERE id=?').bind(id).first();
  return json({ ok: true, carga: publicCarga(updated) });
}

// ── Pedir/recibir una foto puntual sin duplicar la carga ─────────────────────
async function handleAdminSolicitarFoto(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const { id, tipo } = await request.json().catch(() => ({}));
  if (!['ticket', 'tablero'].includes(tipo)) return json({ error: 'Tipo inválido' }, 400);
  const carga = await env.DB.prepare('SELECT * FROM cargas WHERE id=?').bind(id).first();
  if (!carga) return json({ error: 'Carga no encontrada' }, 404);
  await env.DB.prepare('UPDATE cargas SET foto_pendiente=? WHERE id=?').bind(tipo, id).run();
  let sent = 0;
  if (carga.usuario_id) {
    const rows = await env.DB.prepare('SELECT endpoint,subscription FROM push_subs WHERE usuario_id=?').bind(carga.usuario_id).all();
    sent = await pushSend(env, rows.results, {
      title: '📸 Falta una foto',
      body: `Reintentá la foto del ${tipo === 'tablero' ? 'tablero (odómetro)' : 'ticket'} de tu carga del ${carga.fecha}. Abrí Flota ML.`,
      tag: 'foto-pendiente-' + id,
    });
  }
  return json({ ok: true, sent });
}

async function handlePendientesFoto(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  if (user.rol === 'admin') return json({ ok: true, cargas: [] });
  const rows = await env.DB.prepare(
    `SELECT id,fecha,hora,vehiculo_id,foto_pendiente,total,litros FROM cargas
     WHERE usuario_id=? AND foto_pendiente IS NOT NULL ORDER BY creado DESC`).bind(user.id).all();
  return json({ ok: true, cargas: rows.results });
}

async function handleSubirFotoFaltante(request, env, ctx, id) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  const { tipo, foto } = await request.json().catch(() => ({}));
  if (!['ticket', 'tablero'].includes(tipo) || !foto) return json({ error: 'Faltan datos' }, 400);
  const carga = await env.DB.prepare('SELECT * FROM cargas WHERE id=?').bind(id).first();
  if (!carga) return json({ error: 'Carga no encontrada' }, 404);
  if (user.rol !== 'admin' && carga.usuario_id !== user.id) return json({ error: 'No autorizado' }, 403);
  if (carga.foto_pendiente !== tipo) return json({ error: 'No se pidió esta foto para esta carga' }, 400);
  let veh = await env.DB.prepare('SELECT * FROM vehiculos WHERE id=?').bind(carga.vehiculo_id).first();

  const b64 = foto.includes(',') ? foto.split(',')[1] : foto;
  const key = `${id}/${tipo}.jpg`;
  await fotoPut(env, key, b64ToBytes(b64));

  let warningsPrevios = [], notas = [];
  try { const d = JSON.parse(carga.validacion_detalle || '{}'); warningsPrevios = d.warnings || []; notas = d.notas || []; } catch (e) { }

  if (tipo === 'tablero') {
    const kmData = await geminiOdometro(b64, env).catch(err => { console.warn('retake km:', err.message); return null; });
    const km = kmData?.km > 0 ? Math.round(kmData.km) : null;
    const kmWarns = calcularWarningsKm(km, kmData, true, veh);
    const warnings = warningsPrevios.filter(w => !KM_WARN_KEYS.includes(w)).concat(kmWarns);
    const pendiente = km ? null : 'tablero'; // si sigue ilegible, queda pendiente para volver a pedir
    await env.DB.prepare(`UPDATE cargas SET km=?, km_confianza=?, foto_tablero=?, foto_pendiente=?,
      validacion=?, validacion_detalle=?, corregido_por=?, corregido_en=datetime('now') WHERE id=?`)
      .bind(km, kmData?.confianza ?? null, key, pendiente, warnings.length ? 'revisar' : 'ok',
        JSON.stringify({ warnings, notas }), 'foto-retake:' + user.username, id).run();
    if (km && km > (veh.km_actual || 0)) {
      await env.DB.prepare('UPDATE vehiculos SET km_actual=? WHERE id=?').bind(km, veh.id).run();
      veh = { ...veh, km_actual: km };
      ctx.waitUntil(checkMantenimiento(env, veh).catch(() => { }));
    }
  } else {
    const t = await geminiTicket(b64, env).catch(err => { console.warn('retake ticket:', err.message); return null; });
    if (!t) {
      const warnings = warningsPrevios.filter(w => KM_WARN_KEYS.includes(w)).concat(['ocr_ticket_fallo']);
      await env.DB.prepare(`UPDATE cargas SET foto_ticket=?, validacion='revisar', validacion_detalle=?,
        corregido_por=?, corregido_en=datetime('now') WHERE id=?`)
        .bind(key, JSON.stringify({ warnings, notas }), 'foto-retake:' + user.username, id).run();
    } else {
      const m = t.montos || {}, it = (t.items && t.items[0]) || {};
      const ticketWarns = calcularWarningsTicket(t, veh);
      if (await comprobanteDuplicado(env, t, id)) ticketWarns.push('comprobante_duplicado');
      notas = []; if (Array.isArray(t.advertencias)) t.advertencias.forEach(a => a && notas.push(String(a).slice(0, 120)));
      const warnings = warningsPrevios.filter(w => KM_WARN_KEYS.includes(w)).concat(ticketWarns);
      await env.DB.prepare(`UPDATE cargas SET
        fecha=COALESCE(?,fecha),hora=?,tipo_comprobante=?,codigo_comprobante=?,punto_venta=?,numero_comprobante=?,
        emisor_razon_social=?,emisor_cuit=?,emisor_domicilio=?,emisor_localidad=?,emisor_iibb=?,emisor_condicion_iva=?,
        receptor_nombre=?,receptor_cuit=?,producto=?,litros=?,precio_unitario=?,neto_gravado=?,iva_alicuota=?,iva=?,
        otros_tributos=?,percepciones=?,exento=?,no_gravado=?,total=?,condicion_pago=?,confianza=?,
        foto_ticket=?,foto_pendiente=NULL,validacion=?,validacion_detalle=?,original_json=?,
        corregido_por=?,corregido_en=datetime('now') WHERE id=?`).bind(
        t.fecha ?? null, t.hora?.slice(0, 8) ?? null, t.tipo_comprobante ?? null, t.codigo_comprobante ?? null,
        t.punto_venta ?? null, t.numero_comprobante ?? null,
        t.emisor?.razon_social ?? null, t.emisor?.cuit ?? null, t.emisor?.domicilio ?? null, t.emisor?.localidad ?? null,
        t.emisor?.iibb ?? null, t.emisor?.condicion_iva ?? null, t.receptor?.nombre ?? null, t.receptor?.cuit ?? null,
        it.descripcion ?? null, it.litros ?? null, it.precio_unitario ?? null, m.neto_gravado ?? null,
        m.iva_alicuota ?? null, m.iva ?? null, m.otros_tributos ?? null, m.percepciones ?? null, m.exento ?? null,
        m.no_gravado ?? null, m.total ?? null, t.condicion_pago ?? null, t.confianza ?? null,
        key, warnings.length ? 'revisar' : 'ok', JSON.stringify({ warnings, notas }),
        JSON.stringify(t), 'foto-retake:' + user.username, id,
      ).run();
    }
  }

  const updated = await env.DB.prepare('SELECT * FROM cargas WHERE id=?').bind(id).first();
  ctx.waitUntil(pushToAdmins(env, {
    title: updated.foto_pendiente ? '⚠️ Foto sigue poco clara' : '✅ Foto recibida',
    body: `${user.nombre} reenvió la foto del ${tipo} — ${updated.foto_pendiente ? 'sigue sin poder leerse' : 'carga actualizada'}.`,
    tag: 'foto-recibida-' + id,
  }).catch(() => { }));
  return json({ ok: true, carga: publicCarga(updated) });
}

async function handleRevision(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const rows = await env.DB.prepare(
    "SELECT * FROM cargas WHERE validacion='revisar' ORDER BY creado DESC LIMIT 50").all();
  return json({ ok: true, cargas: rows.results.map(publicCarga) });
}
async function handleAdminEliminarCarga(request, env, id) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const carga = await env.DB.prepare('SELECT * FROM cargas WHERE id=?').bind(id).first();
  if (!carga) return json({ error: 'Carga no encontrada' }, 404);
  await env.DB.prepare('DELETE FROM cargas WHERE id=?').bind(id).run();
  if (carga.foto_ticket) await fotoDelete(env, carga.foto_ticket);
  if (carga.foto_tablero) await fotoDelete(env, carga.foto_tablero);
  return json({ ok: true });
}
async function handleContadorAhora(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const { month } = await request.json().catch(() => ({}));
  await sendContadorReport(env, month);
  return json({ ok: true });
}
async function handleWeeklyAhora(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  await sendWeeklyReport(env);
  return json({ ok: true });
}

// ── ANÁLISIS IA POR VEHÍCULO — cacheado por mes, se "reinicia" solo al cambiar de ciclo ──
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function mesAnterior(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function statsVehiculoMes(cargasVeh) {
  const litros = cargasVeh.reduce((s, c) => s + (c.litros || 0), 0);
  const gasto = cargasVeh.reduce((s, c) => s + (c.total || 0), 0);
  const conKm = cargasVeh.filter(c => c.km > 0);
  const kms = conKm.map(c => c.km);
  const kmRecorridos = kms.length >= 2 ? Math.max(...kms) - Math.min(...kms) : 0;
  return {
    n: cargasVeh.length, litros, gasto, kmRecorridos, kmLecturas: kms.length,
    kml: (kmRecorridos > 0 && litros > 0) ? kmRecorridos / litros : null,
    cxkm: (kmRecorridos > 0 && gasto > 0) ? gasto / kmRecorridos : null,
    ppl: litros > 0 ? gasto / litros : null,
  };
}
async function handleAnalisisVehiculo(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const { vehiculoId, month, forzar } = await request.json().catch(() => ({}));
  if (!vehiculoId || !/^\d{4}-\d{2}$/.test(month || '')) return json({ error: 'Faltan datos' }, 400);
  const veh = await env.DB.prepare('SELECT * FROM vehiculos WHERE id=?').bind(vehiculoId).first();
  if (!veh) return json({ error: 'Vehículo inexistente' }, 400);

  if (!forzar) {
    const cached = await env.DB.prepare(
      'SELECT texto, generado_en FROM analisis_ia WHERE vehiculo_id=? AND mes=?').bind(vehiculoId, month).first();
    if (cached) return json({ ok: true, texto: cached.texto, generadoEn: cached.generado_en, cache: true });
  }
  if (!env.GEMINI_API_KEY) return json({ error: 'Sin GEMINI_API_KEY configurada' }, 500);

  const st = statsVehiculoMes((await cargasDelMes(env, month)).filter(c => c.vehiculo_id === vehiculoId));
  const prevSt = statsVehiculoMes((await cargasDelMes(env, mesAnterior(month))).filter(c => c.vehiculo_id === vehiculoId));

  const [y, m] = month.split('-').map(Number);
  const diasDelMes = new Date(y, m, 0).getDate();
  const hoy = hoyAR();
  const esMesActual = month === hoy.slice(0, 7);
  const diasTranscurridos = esMesActual ? new Date(hoy).getUTCDate() : diasDelMes;
  const proyeccionAnualKm = (st.kmRecorridos > 0 && diasTranscurridos > 0)
    ? Math.round(st.kmRecorridos / diasTranscurridos * 365) : null;
  const delta = (curr, prev) => (prev > 0 && curr !== null) ? Math.round((curr / prev - 1) * 100) : null;
  const fmtDelta = d => d === null ? 'sin datos del mes anterior' : (d > 0 ? '+' : '') + d + '%';
  const mesLabel = `${MESES_ES[m - 1]} de ${y}`;

  const kmConfiable = st.n === 0 || st.kmLecturas >= st.n - 1; // se tolera 1 carga sin KM (la más reciente puede estar recién cargada)

  const prompt = `Sos un asesor de flota para una empresa de reparto en Argentina. Analizá al vehículo "${veh.nombre}" durante ${mesLabel} y devolvé un consejo breve (3 a 4 oraciones, texto plano sin markdown, español rioplatense) sobre si el gasto de combustible parece razonable o exorbitante, la tendencia de eficiencia, y una recomendación concreta si corresponde. Interpretá los números, no los repitas tal cual.

Datos de ${mesLabel} (${st.n} carga${st.n === 1 ? '' : 's'}):
- Litros: ${st.litros.toFixed(1)} L
- Gasto: $${Math.round(st.gasto)}
- Precio promedio: ${st.ppl ? '$' + st.ppl.toFixed(2) + '/L' : 'sin datos'}
- Lecturas de KM del odómetro: ${st.kmLecturas} de ${st.n} cargas${kmConfiable ? '' : ' — OJO: bastantes cargas no tienen foto de odómetro legible, así que el KM recorrido y la eficiencia de abajo están calculados con MENOS litros de los reales y pueden verse artificialmente peores de lo que son en realidad'}
- KM recorridos (según las lecturas disponibles): ${st.kmRecorridos > 0 ? fmtN(st.kmRecorridos) + ' km' : 'sin datos suficientes (menos de 2 cargas con KM)'}
- Eficiencia: ${st.kml ? st.kml.toFixed(1) + ' km/L' : 'sin datos'}
- Costo por km: ${st.cxkm ? '$' + st.cxkm.toFixed(0) : 'sin datos'}
- Proyección anual de KM al ritmo de este mes: ${proyeccionAnualKm ? fmtN(proyeccionAnualKm) + ' km/año' : 'sin datos suficientes'}

${kmConfiable ? '' : 'IMPORTANTE: como faltan varias lecturas de KM, NO recomiendes revisión mecánica ni digas que el vehículo tiene un problema real basándote en la eficiencia — explicá que el dato de km/L no es confiable este mes por falta de fotos de odómetro y que conviene esperar a tener más lecturas antes de sacar conclusiones sobre el rendimiento del motor. Enfocate en el gasto total y litros en vez de la eficiencia.\n'}Comparado con el mes anterior (${prevSt.n} carga${prevSt.n === 1 ? '' : 's'}):
- Gasto: ${fmtDelta(delta(st.gasto, prevSt.gasto))}
- Eficiencia km/L: ${fmtDelta(delta(st.kml, prevSt.kml))}

Si hay muy pocos datos para opinar con criterio, decilo brevemente en vez de inventar conclusiones.`;

  let texto;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4 } }),
    });
    if (!res.ok) throw new Error('Gemini ' + res.status);
    const data = await res.json();
    texto = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!texto) throw new Error('Respuesta vacía');
  } catch (err) {
    return json({ error: 'Error generando análisis: ' + err.message }, 500);
  }

  const generadoEn = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO analisis_ia (vehiculo_id,mes,texto,generado_en) VALUES (?,?,?,?)
    ON CONFLICT(vehiculo_id,mes) DO UPDATE SET texto=excluded.texto, generado_en=excluded.generado_en`)
    .bind(vehiculoId, month, texto, generadoEn).run();

  return json({ ok: true, texto, generadoEn, cache: false });
}

// ══════════════════════════════════════════════════════════════════════════════
// PUSH (suscripciones en D1)
// ══════════════════════════════════════════════════════════════════════════════
async function handlePushRegister(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  const { subscription } = await request.json().catch(() => ({}));
  if (!subscription?.endpoint) return json({ error: 'Sin suscripción' }, 400);
  await env.DB.prepare(`INSERT INTO push_subs (endpoint,usuario_id,username,vehiculo_id,subscription)
    VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET usuario_id=excluded.usuario_id,
    username=excluded.username, vehiculo_id=excluded.vehiculo_id, subscription=excluded.subscription`)
    .bind(subscription.endpoint, user.id, user.username, user.vehiculo_id, JSON.stringify(subscription)).run();
  return json({ ok: true });
}
async function handlePushBroadcast(request, env) {
  const admin = await reqAdmin(request, env);
  if (!admin) return noAuth();
  const { mensaje, titulo } = await request.json().catch(() => ({}));
  if (!mensaje) return json({ error: 'Sin mensaje' }, 400);
  const sent = await pushToAll(env, { title: titulo || '📢 Mensaje de administración', body: mensaje, tag: 'broadcast' });
  return json({ ok: true, sent });
}

async function pushSend(env, subs, payload) {
  let sent = 0;
  for (const row of subs) {
    try {
      await sendWebPush(JSON.parse(row.subscription), payload, env);
      sent++;
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('410') || msg.includes('404'))
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(row.endpoint).run();
      else console.warn('push:', msg);
    }
  }
  return sent;
}
async function pushToAll(env, payload) {
  const rows = await env.DB.prepare('SELECT endpoint, subscription FROM push_subs').all();
  return pushSend(env, rows.results, payload);
}
async function pushToVehicle(env, vid, payload) {
  const rows = await env.DB.prepare(
    `SELECT p.endpoint, p.subscription FROM push_subs p LEFT JOIN usuarios u ON u.id=p.usuario_id
     WHERE p.vehiculo_id=? OR u.rol='admin'`).bind(vid).all();
  return pushSend(env, rows.results, payload);
}
async function pushToAdmins(env, payload) {
  const rows = await env.DB.prepare(
    `SELECT p.endpoint, p.subscription FROM push_subs p JOIN usuarios u ON u.id=p.usuario_id WHERE u.rol='admin'`).all();
  return pushSend(env, rows.results, payload);
}

// ── Diagnóstico remoto — el cliente avisa apenas algo falla, con detalle técnico,
// para no depender de que el chofer sepa describir el problema.
function resumirUA(ua) {
  if (!ua) return '';
  const marca = ua.match(/;\s*([A-Za-z0-9 _-]+)\s+Build\//)?.[1]?.trim();
  const chrome = ua.match(/Chrome\/(\d+)/)?.[1];
  const android = ua.match(/Android\s([\d.]+)/)?.[1];
  return [marca, android ? `Android ${android}` : null, chrome ? `Chrome ${chrome}` : null].filter(Boolean).join(' · ');
}
async function handleDiag(request, env, ctx) {
  const user = await getAuthUser(request, env);
  if (!user) return noAuth();
  const b = await request.json().catch(() => ({}));
  const evento = String(b.evento || 'evento').slice(0, 60);
  const detalle = String(b.detalle || '').slice(0, 300);
  const dispositivo = resumirUA(b.userAgent || '');
  console.log('DIAG', user.username, evento, detalle, dispositivo);
  ctx.waitUntil(pushToAdmins(env, {
    title: `⚠️ ${user.nombre} — ${evento}`,
    body: `${detalle}${dispositivo ? ' · ' + dispositivo : ''}`,
    tag: 'diag-' + evento,
  }).catch(() => { }));
  return json({ ok: true });
}

// ── Web Push RFC 8291 aes128gcm (probado en producción v1) ──────────────────
async function sendWebPush(subscription, payload, env) {
  if (!env.VAPID_PRIVATE_KEY) { console.warn('Sin VAPID_PRIVATE_KEY'); return; }
  const endpoint = subscription.endpoint;
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const pubRaw = b64ToBytes(env.VAPID_PUBLIC_KEY);
  const privJwk = {
    kty: 'EC', crv: 'P-256', ext: true, key_ops: ['sign'],
    d: b64url(b64ToBytes(env.VAPID_PRIVATE_KEY)), x: b64url(pubRaw.slice(1, 33)), y: b64url(pubRaw.slice(33, 65)),
  };
  const privKey = await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64url(te('{"typ":"JWT","alg":"ES256"}'));
  const claims = b64url(te(JSON.stringify({ aud: audience, exp: now + 43200, sub: VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, te(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(sig)}`;

  const authSecret = b64ToBytes(subscription.keys.auth);
  const receiverPub = b64ToBytes(subscription.keys.p256dh);
  const plaintext = te(JSON.stringify(payload));
  const ephPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephPair.publicKey));
  const rxKey = await crypto.subtle.importKey('raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: rxKey }, ephPair.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prkInfo = cat(te('WebPush: info'), new Uint8Array([0]), receiverPub, ephPubRaw);
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const prk = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: prkInfo }, ikmKey, 256));
  const prkKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);
  const cek = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: cat(te('Content-Encoding: aes128gcm'), new Uint8Array([0])) }, prkKey, 128));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: cat(te('Content-Encoding: nonce'), new Uint8Array([0])) }, prkKey, 96));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, cat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const body = cat(salt, rs, new Uint8Array([ephPubRaw.length]), ephPubRaw, ciphertext);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm',
      'TTL': '86400', 'Urgency': 'high',
    },
    body,
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`Push ${res.status}: ${await res.text().catch(() => '')}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// EMAILS (Brevo)
// ══════════════════════════════════════════════════════════════════════════════
async function sendViaBrevo(payload, env) {
  const body = {
    sender: { name: FROM_NAME, email: env.FROM_EMAIL || 'santamariapablodaniel@gmail.com' },
    to: payload.to.map(e => ({ email: e })),
    subject: payload.subject, htmlContent: payload.html,
  };
  if (payload.attachment) body.attachment = payload.attachment;
  return fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function emailConfirmacion(env, c, veh, user) {
  if (!env.SENDGRID_API_KEY) return;
  const to = [env.FLEET_EMAIL || env.FROM_EMAIL];
  if (user.email && user.email.includes('@') && !to.includes(user.email)) to.push(user.email);
  const estado = c.validacion === 'ok'
    ? '<span class="badge bg">✅ Verificada</span>'
    : '<span class="badge" style="background:#fffbeb;color:#92400e;border:1px solid #fde68a">🔍 En revisión</span>';
  const row = (l, v) => v ? `<div class="row"><span class="row-l">${l}</span><span class="row-v">${v}</span></div>` : '';
  const header = `<h1 class="h-title">⛽ Carga registrada</h1><p class="h-sub">${veh.emoji} ${veh.nombre} · ${c.fecha}${c.hora ? ' ' + c.hora : ''}</p>`;
  const body = `
    <div class="v-hero"><span class="v-emoji">${veh.emoji}</span><div class="v-name">${veh.nombre}</div>
    <div class="v-greet">Cargó <strong>${user.nombre}</strong> ${estado}</div></div>
    <p class="sec-title">🧾 Comprobante</p>
    ${row('📄 Tipo', c.tipo_comprobante ? `${c.tipo_comprobante} (Cód. ${c.codigo_comprobante || '—'})` : null)}
    ${row('🔢 Número', c.punto_venta && c.numero_comprobante ? `${c.punto_venta}-${c.numero_comprobante}` : c.numero_comprobante)}
    ${row('🏪 Estación', c.emisor_razon_social)}
    ${row('🏢 CUIT emisor', c.emisor_cuit)}
    ${row('📍 Domicilio', c.emisor_domicilio)}
    <p class="sec-title" style="margin-top:16px">💰 Montos</p>
    ${row('⛽ Producto', c.producto ? `${c.producto} — ${(c.litros || 0).toFixed(2)} L × ${fmt$(c.precio_unitario)}` : null)}
    ${row('Neto gravado', c.neto_gravado ? fmt$(c.neto_gravado) : null)}
    ${row('IVA ' + (c.iva_alicuota || 21) + '%', c.iva ? fmt$(c.iva) : null)}
    ${row('Otros tributos (ITC/IDC)', c.otros_tributos ? fmt$(c.otros_tributos) : null)}
    ${row('Percepciones', c.percepciones ? fmt$(c.percepciones) : null)}
    ${row('🛣️ Kilómetros', c.km ? fmtN(c.km) + ' km' : null)}
    <div class="total-box"><span class="total-l">💰 Total</span><span class="total-v">${fmt$(c.total)}</span></div>
    <div class="badges"><span class="badge bb">📊 Registrado en Flota ML</span>${c.validacion === 'ok' ? '<span class="badge bg">Apto crédito fiscal</span>' : ''}</div>`;
  await sendViaBrevo({ to, subject: `⛽ Carga — ${veh.emoji} ${veh.nombre} ${fmt$(c.total)}`, html: emailShell('Carga registrada', header, body) }, env);
}

function buildMaintEmail(veh, st, urgente) {
  if (urgente === undefined) urgente = st.kmRestantes <= 200; // compat con llamadas legacy
  const header = `<h1 class="h-title">${urgente ? '🛑 ¡Es hora del cambio de aceite!' : '🔧 Servicio próximo'}</h1><p class="h-sub">${veh.emoji} ${veh.nombre}</p>`;
  const body = `<div class="sgrid">
    <div class="sc"><span class="sv">${fmtN(veh.km_actual)}</span><span class="sl">KM actuales</span></div>
    <div class="sc"><span class="sv" ${urgente ? 'style="color:#dc2626"' : ''}>${st.kmRestantes > 0 ? fmtN(st.kmRestantes) : fmtN(Math.abs(st.kmRestantes))}</span><span class="sl">${st.kmRestantes > 0 ? 'KM restantes' : 'KM de exceso'}</span></div></div>
    <div class="alert ${urgente ? 'red' : ''}"><p>${urgente ? `⚠️ El vehículo llegó (o superó) los ${fmtN(st.proximoKm)} km previstos para el cambio de aceite. Coordiná el taller hoy.` : `Próximo service a los ${fmtN(st.proximoKm)} km.`}</p></div>`;
  return emailShell('Alerta de servicio', header, body);
}

// ── Reporte contador (día 25) — tabla fiscal completa + CSV adjunto ─────────
async function sendContadorReport(env, month) {
  const to = env.CONTADOR_EMAIL;
  if (!to || !env.SENDGRID_API_KEY) return;
  month = month || hoyAR().slice(0, 7);
  const rows = await cargasDelMes(env, month);
  if (!rows.length) return;
  const csv = await buildCSV(env, rows, 'https://logisticaml.santamariapablodaniel.workers.dev');
  const csvB64 = btoa(unescape(encodeURIComponent(csv)));
  const tot = k => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const [yMes, mMes] = month.split('-').map(Number);
  const mes = `${MESES_ES[mMes - 1]} de ${yMes}`;
  const trs = rows.map(c => `<tr>
    <td>${c.fecha}</td><td style="font-family:monospace;font-size:.72rem">${c.tipo_comprobante ? 'FA' : '—'} ${c.punto_venta || ''}-${c.numero_comprobante || '—'}</td>
    <td style="font-family:monospace;font-size:.72rem">${c.emisor_cuit || '—'}</td>
    <td>${(c.emisor_razon_social || c.emisor_localidad || '—').slice(0, 22)}</td>
    <td style="text-align:right">${csvNumHtml(c.neto_gravado)}</td>
    <td style="text-align:right;color:#15803d;font-weight:700">${csvNumHtml(c.iva)}</td>
    <td style="text-align:right">${csvNumHtml(c.otros_tributos)}</td>
    <td style="text-align:right;font-weight:700">${csvNumHtml(c.total)}</td>
    <td>${c.validacion === 'ok' ? '✅' : c.validacion === 'revisar' ? '🔍' : '·'}</td></tr>`).join('');
  const header = `<h1 class="h-title">🧾 Crédito Fiscal — Combustibles</h1><p class="h-sub">Período <strong>${mes}</strong> · CSV completo adjunto para importar</p>`;
  const body = `
    <div class="sgrid">
      <div class="sc"><span class="sv">${rows.length}</span><span class="sl">Comprobantes</span></div>
      <div class="sc"><span class="sv">${tot('litros').toFixed(1)} L</span><span class="sl">Litros</span></div>
      <div class="sc g"><span class="sv">${fmt$(tot('iva'))}</span><span class="sl">IVA crédito</span></div>
      <div class="sc"><span class="sv">${fmt$(tot('total'))}</span><span class="sl">Total</span></div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Fecha</th><th>Comprobante</th><th>CUIT</th><th>Emisor</th><th style="text-align:right">Neto</th><th style="text-align:right">IVA</th><th style="text-align:right">Otros trib.</th><th style="text-align:right">Total</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
      <tfoot><tr><td colspan="4"><strong>TOTALES</strong></td><td style="text-align:right">${fmt$(tot('neto_gravado'))}</td><td style="text-align:right">${fmt$(tot('iva'))}</td><td style="text-align:right">${fmt$(tot('otros_tributos'))}</td><td style="text-align:right">${fmt$(tot('total'))}</td><td></td></tr></tfoot>
    </table></div>
    <div class="alert" style="margin-top:16px"><p>📎 El CSV adjunto tiene <strong>todos los campos por comprobante</strong> (tipo, PV, número, CUIT y razón social del emisor, neto, IVA, ITC/IDC, percepciones, total) más el link a la foto de cada ticket. Filas con 🔍 están en revisión: verificar contra la foto antes de imputar.<br><br>💡 La mayoría de estos tickets (controlador fiscal de estación de servicio) <strong>no aparecen en el portal de Comprobantes Recibidos de ARCA</strong> porque la estación no los emite como factura electrónica — por eso este CSV incluye el listado completo para imputar directo en el Libro IVA Compras, sin depender de lo que muestre ARCA.</p></div>`;
  await sendViaBrevo({
    to: [to], subject: `🧾 Flota ML — Crédito Fiscal ${mes} (${rows.length} comprobantes)`,
    html: emailShell('Crédito fiscal', header, body),
    attachment: [{ name: `flota-ml-${month}.csv`, content: csvB64 }],
  }, env);
}
const csvNumHtml = n => n ? fmt$(n) : '—';

// ── Reporte dueño (día 1, mes anterior) ──────────────────────────────────────
async function sendOwnerReport(env) {
  const to = env.OWNER_EMAIL || env.FROM_EMAIL;
  if (!to || !env.SENDGRID_API_KEY) return;
  const prev = arNow(); prev.setMonth(prev.getMonth() - 1);
  const month = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const rows = await cargasDelMes(env, month);
  if (!rows.length) return;
  const vehs = (await env.DB.prepare('SELECT * FROM vehiculos').all()).results;
  const mes = prev.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  const byV = {};
  rows.forEach(c => { (byV[c.vehiculo_id] = byV[c.vehiculo_id] || []).push(c); });
  const cards = Object.entries(byV).map(([vid, cs]) => {
    const v = vehs.find(x => x.id === vid) || { nombre: vid, emoji: '🚛' };
    const amt = cs.reduce((s, c) => s + (c.total || 0), 0);
    const lit = cs.reduce((s, c) => s + (c.litros || 0), 0);
    const kms = cs.filter(c => c.km).map(c => c.km);
    const kmR = kms.length >= 2 ? Math.max(...kms) - Math.min(...kms) : 0;
    return `<div class="vc"><div class="vc-h"><div class="vc-n"><span class="vc-e">${v.emoji}</span><div>
      <div class="vc-t">${v.nombre}</div><div class="vc-s">${cs.length} cargas · ${lit.toFixed(1)} L</div></div></div>
      <div style="text-align:right"><div class="vc-a">${fmt$(amt)}</div></div></div>
      <div class="vc-stats"><div><div class="vc-sv">${kmR ? fmtN(kmR) + ' km' : '—'}</div><div class="vc-sl">Recorridos</div></div>
      <div><div class="vc-sv">${kmR && lit ? (kmR / lit).toFixed(1) : '—'}</div><div class="vc-sl">km/L</div></div>
      <div><div class="vc-sv">${kmR && amt ? '$' + (amt / kmR).toFixed(0) : '—'}</div><div class="vc-sl">$/km</div></div>
      <div><div class="vc-sv" style="color:#15803d">${fmt$(cs.reduce((s, c) => s + (c.iva || 0), 0))}</div><div class="vc-sl">IVA créd.</div></div></div></div>`;
  }).join('');
  const header = `<h1 class="h-title">📊 Reporte Mensual</h1><p class="h-sub">${mes}</p>`;
  const totalAmt = rows.reduce((s, c) => s + (c.total || 0), 0);
  const totalLit = rows.reduce((s, c) => s + (c.litros || 0), 0);
  const body = `<div class="sgrid">
    <div class="sc"><span class="sv">${rows.length}</span><span class="sl">Cargas</span></div>
    <div class="sc"><span class="sv">${totalLit.toFixed(1)} L</span><span class="sl">Litros</span></div>
    <div class="sc"><span class="sv">${fmt$(totalAmt)}</span><span class="sl">Gasto</span></div>
    <div class="sc"><span class="sv">$${totalLit ? (totalAmt / totalLit).toFixed(2) : '—'}</span><span class="sl">$/litro</span></div>
  </div><p class="sec-title">🚛 Por vehículo</p>${cards}`;
  await sendViaBrevo({ to: [to], subject: `📊 Flota ML — Reporte ${mes}`, html: emailShell('Reporte mensual', header, body) }, env);
}

// ── Reporte semanal (viernes) con análisis IA ────────────────────────────────
async function sendWeeklyReport(env) {
  const to = env.OWNER_EMAIL || env.FROM_EMAIL;
  if (!to || !env.SENDGRID_API_KEY) return;
  const rows = (await env.DB.prepare(
    "SELECT * FROM cargas WHERE fecha >= date('now','-7 days') ORDER BY fecha").all()).results;
  const vehs = (await env.DB.prepare('SELECT * FROM vehiculos').all()).results;
  if (!rows.length) return;
  const byV = {};
  rows.forEach(c => { (byV[c.vehiculo_id] = byV[c.vehiculo_id] || []).push(c); });
  const stats = Object.entries(byV).map(([vid, cs]) => {
    const v = vehs.find(x => x.id === vid) || { nombre: vid, emoji: '🚛' };
    const amt = cs.reduce((s, c) => s + (c.total || 0), 0);
    const lit = cs.reduce((s, c) => s + (c.litros || 0), 0);
    const kms = cs.filter(c => c.km).map(c => c.km);
    const kmR = kms.length >= 2 ? Math.max(...kms) - Math.min(...kms) : 0;
    return { nombre: v.nombre, emoji: v.emoji, cargas: cs.length, litros: lit, gasto: amt, km: kmR, kmL: kmR && lit ? kmR / lit : 0 };
  });
  let ia = '';
  if (env.GEMINI_API_KEY) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `Sos analista de flota de reparto en Argentina. Resumí en máx 3 párrafos (texto plano, español) la semana, anomalías y recomendaciones. Datos: ${JSON.stringify(stats)}` }] }],
          generationConfig: { temperature: 0.4 },
        }),
      });
      if (res.ok) { const d = await res.json(); ia = d.candidates?.[0]?.content?.parts?.[0]?.text || ''; }
    } catch (e) { }
  }
  const cards = stats.map(v => `<div class="vc"><div class="vc-h"><div class="vc-n"><span class="vc-e">${v.emoji}</span><div>
    <div class="vc-t">${v.nombre}</div><div class="vc-s">${v.cargas} cargas · ${v.litros.toFixed(1)} L</div></div></div>
    <div style="text-align:right"><div class="vc-a">${fmt$(v.gasto)}</div></div></div>
    <div class="vc-stats"><div><div class="vc-sv">${v.km ? fmtN(v.km) : '—'}</div><div class="vc-sl">KM</div></div>
    <div><div class="vc-sv">${v.kmL ? v.kmL.toFixed(1) : '—'}</div><div class="vc-sl">km/L</div></div>
    <div><div class="vc-sv">${v.km ? '$' + (v.gasto / v.km).toFixed(0) : '—'}</div><div class="vc-sl">$/km</div></div>
    <div><div class="vc-sv">${v.cargas}</div><div class="vc-sl">Cargas</div></div></div></div>`).join('');
  const header = `<h1 class="h-title">📊 Reporte Semanal</h1><p class="h-sub">Últimos 7 días</p>`;
  const body = `${cards}${ia ? `<div class="ai-box"><div style="font-weight:800;color:#1e40af;margin-bottom:10px">🤖 Análisis IA</div><div style="font-size:.84rem;line-height:1.75;white-space:pre-line">${ia}</div></div>` : ''}`;
  await sendViaBrevo({ to: [to], subject: '📊 Flota ML — Reporte Semanal', html: emailShell('Reporte semanal', header, body) }, env);
}

// ── Pushes programados ────────────────────────────────────────────────────────
const FLEET_TITLE = '🚛 MERCADO LIMPIO FLOTA';
async function pushDailyCheck(env) {
  await pushToAll(env, { title: FLEET_TITLE, tag: 'daily-check', body: '🔍 Revisión diaria antes de salir: agua refrigerante, aceite de motor y agua del limpiaparabrisas. ¡Buen día!' });
}
async function pushFridayClean(env) {
  const users = (await env.DB.prepare("SELECT * FROM usuarios WHERE rol='chofer' AND vehiculo_id IS NOT NULL").all()).results;
  for (const u of users) {
    await pushToVehicle(env, u.vehiculo_id, { title: FLEET_TITLE, tag: 'friday-' + u.vehiculo_id, body: `Hola ${u.nombre} — Es viernes: mantené el vehículo limpio por dentro y por fuera. ¡Es nuestra herramienta de trabajo!` });
  }
}
async function pushTires(env) {
  await pushToAll(env, { title: FLEET_TITLE, tag: 'tires', body: '🔵 Recordatorio mensual: calibrá las 4 ruedas. Evitá desgaste desigual y daños en el tren delantero.' });
}
async function pushSpare(env) {
  await pushToAll(env, { title: FLEET_TITLE, tag: 'spare', body: '🛞 Revisá el auxilio: neumático inflado, llave y gato.' });
}
async function pushDocs(env) {
  await pushToAll(env, { title: FLEET_TITLE, tag: 'docs', body: '📋 Mensual: VTV, registro, cédula y seguro vigentes. ¡Controlá que todo esté en orden!' });
}

// ══════════════════════════════════════════════════════════════════════════════
// LEGACY — compatibilidad con la app v1 instalada en los teléfonos
// ══════════════════════════════════════════════════════════════════════════════
async function legacyProcessTicket(request, env) {
  const { image } = await request.json();
  const b64 = image.includes(',') ? image.split(',')[1] : image;
  try {
    const t = await geminiTicket(b64, env);
    const it = (t.items && t.items[0]) || {};
    return json({
      ticket: {
        fecha: t.fecha, hora: t.hora,
        surtidor: { cuit: t.emisor?.cuit, razonSocial: t.emisor?.razon_social, localidad: t.emisor?.localidad, direccion: t.emisor?.domicilio },
        combustible: { tipo: it.descripcion, litros: it.litros, precioUnitario: it.precio_unitario },
        monto: { subtotal: t.montos?.neto_gravado, iva: t.montos?.iva, total: t.montos?.total },
        validaciones: { confidencia_ocr: t.confianza },
      },
    });
  } catch (err) { return json({ error: 'Error procesando imagen', details: err.message }, 500); }
}
async function legacyProcessOdometer(request, env) {
  const { image } = await request.json();
  const b64 = image.includes(',') ? image.split(',')[1] : image;
  try {
    const r = await geminiOdometro(b64, env);
    if (!r.km) return json({ error: 'No se pudo leer el odómetro' }, 422);
    return json({ km: r.km, confianza: r.confianza });
  } catch (err) { return json({ error: 'Error leyendo odómetro', details: err.message }, 500); }
}
async function legacySyncRecord(request, env) {
  try {
    const { userName, vehicleId, record } = await request.json();
    if (!record || !vehicleId) return json({ error: 'Faltan datos' }, 400);
    await env.DB.prepare(`INSERT OR IGNORE INTO cargas
      (id,vehiculo_id,usuario_nombre,fecha,hora,emisor_cuit,emisor_localidad,emisor_domicilio,litros,iva,total,km,validacion,creado)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'legacy',?)`)
      .bind(String(record.id), vehicleId, userName || null, record.date || hoyAR(), record.time || null,
        record.cuit || null, record.location || null, record.address || null,
        record.liters || null, record.iva || null, record.amount || null, record.km || null,
        record.createdAt || new Date().toISOString()).run();
    if (record.km > 0) {
      // La app vieja no valida nada — un solo KM mal leído acá "envenena" el contador
      // del vehículo para siempre (MAX nunca baja). Si el salto es absurdo, no lo tomamos.
      const veh = await env.DB.prepare('SELECT km_actual FROM vehiculos WHERE id=?').bind(vehicleId).first();
      if (!veh || veh.km_actual === 0 || Math.abs(record.km - veh.km_actual) <= 3000) {
        await env.DB.prepare('UPDATE vehiculos SET km_actual=MAX(km_actual,?) WHERE id=?').bind(record.km, vehicleId).run();
      }
    }
    return json({ ok: true, stored: true });
  } catch (err) { return json({ error: err.message }, 500); }
}
async function legacyGetRecords(request, env) {
  const url = new URL(request.url);
  const mp = url.searchParams.get('month');
  const rows = mp
    ? await env.DB.prepare("SELECT * FROM cargas WHERE substr(fecha,1,7)=? ORDER BY fecha").bind(mp).all()
    : await env.DB.prepare('SELECT * FROM cargas ORDER BY fecha').all();
  const vehs = {}; (await env.DB.prepare('SELECT * FROM vehiculos').all()).results.forEach(v => vehs[v.id] = v);
  const records = rows.results.map(c => ({
    userName: c.usuario_nombre, vehicleId: c.vehiculo_id,
    vehicleName: vehs[c.vehiculo_id]?.nombre, vehicleIcon: vehs[c.vehiculo_id]?.emoji,
    record: {
      id: c.id, date: c.fecha, time: c.hora, liters: c.litros || 0, amount: c.total || 0, iva: c.iva || 0,
      cuit: c.emisor_cuit, location: c.emisor_localidad, address: c.emisor_domicilio, km: c.km, createdAt: c.creado,
    },
  }));
  return json({ ok: true, records });
}
async function legacyAssignments(request, env) {
  const rows = (await env.DB.prepare("SELECT username, vehiculo_id FROM usuarios WHERE vehiculo_id IS NOT NULL").all()).results;
  const assignments = {};
  rows.forEach(r => assignments[r.username] = r.vehiculo_id);
  return json({ ok: true, assignments });
}
async function legacyRegisterPush(request, env) {
  try {
    const { subscription, username, vehicleId } = await request.json();
    if (!subscription?.endpoint) return json({ error: 'Sin suscripción' }, 400);
    const u = username ? await env.DB.prepare('SELECT id FROM usuarios WHERE username=?').bind(username.toLowerCase()).first() : null;
    await env.DB.prepare(`INSERT INTO push_subs (endpoint,usuario_id,username,vehiculo_id,subscription)
      VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET username=excluded.username,
      vehiculo_id=excluded.vehiculo_id, subscription=excluded.subscription`)
      .bind(subscription.endpoint, u?.id ?? null, username || null,
        vehicleId === '__admin__' ? null : vehicleId, JSON.stringify(subscription)).run();
    return json({ ok: true });
  } catch (err) { return json({ error: err.message }, 500); }
}
async function legacyPushCheck(request, env) {
  const url = new URL(request.url);
  const username = (url.searchParams.get('username') || '').toLowerCase();
  const row = await env.DB.prepare('SELECT 1 x FROM push_subs WHERE username=? LIMIT 1').bind(username).first();
  return json({ exists: !!row });
}
async function legacyPushNotify(request, env) {
  const { vehicleId, title, body, tag } = await request.json();
  const sent = await pushToVehicle(env, vehicleId, { title, body, tag: tag || 'fml' });
  return json({ ok: true, sent });
}
async function legacyMaintAlert(request, env) {
  if (!env.SENDGRID_API_KEY) return json({ error: 'Sin API key' }, 500);
  const { vehicleName, vehicleIcon, currentKm, nextServiceKm, kmLeft } = await request.json();
  const veh = { nombre: vehicleName, emoji: vehicleIcon, km_actual: currentKm };
  const st = { kmRestantes: kmLeft, proximoKm: nextServiceKm };
  const res = await sendViaBrevo({
    to: [env.FLEET_EMAIL || env.FROM_EMAIL],
    subject: `🔧 Servicio próximo — ${vehicleIcon} ${vehicleName} (faltan ${fmtN(kmLeft)} km)`,
    html: buildMaintEmail(veh, st),
  }, env);
  return res.ok ? json({ success: true }) : json({ error: 'Email rechazado' }, 500);
}

// ══════════════════════════════════════════════════════════════════════════════
// EMAIL SHELL (estilos compartidos)
// ══════════════════════════════════════════════════════════════════════════════
const CSS = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#1a1a2e}.wrap{max-width:680px;margin:0 auto;padding:28px 16px}.card{background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.09)}.header{padding:36px 44px 0;background:#fff}.logo-row{display:flex;align-items:center;gap:14px;margin-bottom:28px}.logo-box{width:50px;height:50px;background:linear-gradient(135deg,#1e40af,#3b82f6);border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0}.logo-name{font-size:1.2rem;font-weight:800;color:#0f172a}.logo-sub{font-size:.65rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.12em;margin-top:2px}.h-title{font-size:1.9rem;font-weight:900;color:#0f172a;letter-spacing:-.03em;line-height:1.15}.h-sub{font-size:.9rem;color:#64748b;margin-top:8px;padding-bottom:32px}.accent-bar{height:3px;background:linear-gradient(90deg,#1e40af,#3b82f6,#93c5fd)}.body{padding:36px 44px}.v-hero{background:linear-gradient(135deg,#eff6ff,#dbeafe);border-radius:16px;padding:28px 24px;text-align:center;margin-bottom:32px;border:1px solid #bfdbfe}.v-emoji{font-size:4rem;display:block;margin-bottom:10px}.v-name{font-size:1.25rem;font-weight:800;color:#1e3a8a;margin-bottom:4px}.v-greet{font-size:.88rem;color:#3b82f6}.sec-title{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:#94a3b8;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #f1f5f9}.row{display:flex;justify-content:space-between;align-items:center;padding:13px 0;border-bottom:1px solid #f8fafc}.row-l{font-size:.88rem;color:#64748b;font-weight:500}.row-v{font-size:.88rem;color:#0f172a;font-weight:700;text-align:right}.total-box{background:linear-gradient(135deg,#eff6ff,#e0f2fe);border-radius:14px;padding:20px 24px;margin-top:20px;display:flex;justify-content:space-between;align-items:center;border:1px solid #bfdbfe}.total-l{font-size:.95rem;font-weight:700;color:#374151}.total-v{font-size:2rem;font-weight:900;color:#1e40af}.badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.badge{display:inline-flex;align-items:center;gap:5px;padding:6px 16px;border-radius:20px;font-size:.72rem;font-weight:700}.bg{background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0}.bb{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}.sgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:28px}.sc{background:#f8faff;border-radius:14px;padding:20px;text-align:center;border:1px solid #e0e7ff}.sc.g{background:#f0fdf4;border-color:#bbf7d0}.sv{font-size:1.35rem;font-weight:900;color:#1e40af;display:block;line-height:1;margin-bottom:6px}.sc.g .sv{color:#15803d}.sl{font-size:.6rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8}.tbl-wrap{overflow-x:auto;border-radius:12px;border:1px solid #e2e8f0}table{width:100%;border-collapse:collapse;min-width:520px}th{background:#f8fafc;padding:10px 10px;text-align:left;font-size:.58rem;font-weight:800;text-transform:uppercase;color:#94a3b8;border-bottom:2px solid #e2e8f0}td{padding:9px 10px;border-bottom:1px solid #f1f5f9;color:#374151;font-size:.78rem}tfoot td{background:#f0fdf4;font-weight:800;color:#15803d;border-top:2px solid #bbf7d0}.vc{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px;margin-bottom:12px;position:relative}.vc::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,#1e40af,#60a5fa)}.vc-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.vc-n{display:flex;align-items:center;gap:12px}.vc-e{font-size:2.2rem}.vc-t{font-weight:800;font-size:1rem;color:#0f172a}.vc-s{font-size:.75rem;color:#64748b;margin-top:3px}.vc-a{font-size:1.3rem;font-weight:900;color:#1e40af}.vc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center}.vc-sv{font-size:.9rem;font-weight:800;color:#1e40af}.vc-sl{font-size:.58rem;color:#94a3b8;text-transform:uppercase;margin-top:2px}.ai-box{background:linear-gradient(135deg,#eff6ff,#f0fdf4);border:1px solid #bfdbfe;border-radius:16px;padding:24px;margin-top:8px}.alert{background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:18px 20px}.alert p{color:#92400e;font-size:.84rem;line-height:1.75}.alert.red{background:#fef2f2;border-color:#fecaca}.alert.red p{color:#991b1b}.footer{padding:24px 44px 28px;background:#f8fafc;border-top:1px solid #f1f5f9;text-align:center}.footer p{color:#94a3b8;font-size:.72rem;line-height:2}`;
const emailShell = (title, headerContent, bodyContent) => `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body><div class="wrap"><div class="card"><div class="header"><div class="logo-row"><div class="logo-box">🚛</div><div><div class="logo-name">Flota ML</div><div class="logo-sub">Control de Flota</div></div></div>${headerContent}</div><div class="accent-bar"></div><div class="body">${bodyContent}</div><div class="footer"><p>🚛 <strong>Flota ML</strong> · Sistema de Control de Flota<br>Generado automáticamente · ${new Date().toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: 'long', year: 'numeric' })}<br>No responder a este mensaje.</p></div></div></div></body></html>`;