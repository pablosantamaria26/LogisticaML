// Prueba end-to-end: login admin + carga con fotos reales de tickets de junio
// Uso: node worker/test-extraccion.js [cantidad]
const fs = require('fs');
const path = require('path');
const API = 'https://logisticaml.santamariapablodaniel.workers.dev';

async function main() {
  const n = parseInt(process.argv[2] || '4');
  const login = await (await fetch(API + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'pablo', pin: process.env.FML_PIN || '' }),
  })).json();
  if (!login.ok) { console.error('LOGIN FALLO:', login); process.exit(1); }
  console.log('login ok, rol:', login.user.rol);
  const token = login.token;

  const dir = path.resolve(__dirname, '..');
  const fotos = fs.readdirSync(dir).filter(f => f.startsWith('WhatsApp Image 2026-07-15')).slice(0, n);
  for (const f of fotos) {
    const b64 = fs.readFileSync(path.join(dir, f)).toString('base64');
    const id = 'test-' + f.replace(/\D/g, '').slice(-8) + '-' + Math.random().toString(36).slice(2, 6);
    const t0 = Date.now();
    const res = await (await fetch(API + '/api/cargas', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ id, vehiculoId: 'hiace', fotoTicket: b64 }),
    })).json();
    const c = res.carga || {};
    console.log('\n──', f, `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (!res.ok) { console.log('ERROR:', res); continue; }
    console.log(`  ${c.tipo_comprobante} (${c.codigo_comprobante}) N° ${c.punto_venta}-${c.numero_comprobante}`);
    console.log(`  ${c.fecha} ${c.hora || ''} | ${c.emisor_razon_social} | CUIT ${c.emisor_cuit} | IIBB ${c.emisor_iibb || '—'}`);
    console.log(`  ${c.producto}: ${c.litros}L x $${c.precio_unitario}`);
    console.log(`  neto=$${c.neto_gravado} iva=$${c.iva} otros=$${c.otros_tributos} percep=$${c.percepciones ?? 0} TOTAL=$${c.total}`);
    console.log(`  receptor: ${c.receptor_nombre} ${c.receptor_cuit} | pago: ${c.condicion_pago} | conf: ${c.confianza}`);
    console.log(`  validacion: ${c.validacion} ${JSON.stringify(c.warnings)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });