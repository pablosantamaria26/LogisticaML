// Genera migration.sql desde el export del KV (registros v1 → tabla cargas)
// Los registros viejos no tienen datos fiscales completos → validacion='migrado'
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2] || 'kv-export-20260715.json', 'utf8'));

const esc = v => v === null || v === undefined || v === '' ? 'NULL'
  : typeof v === 'number' ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`;

// Normalizar nombres de usuario del v1 → username seed
const USER_MAP = [
  [/ramiro/i, ['ramiro', 'Ramiro Farías']],
  [/nicol/i,  ['nicolas', 'Nicolás']],
  [/martin/i, ['martin', 'Martín Ponce']],
];

const rows = [];
const seen = new Set();
for (const e of data.records) {
  const r = e.record;
  if (!r || seen.has(String(r.id))) continue;
  seen.add(String(r.id));

  // Corregir año mal leído por OCR: si fecha difiere >45 días de createdAt,
  // probar con el año de createdAt; si así queda cerca, usarla.
  let fecha = r.date;
  const created = r.createdAt ? new Date(r.createdAt) : null;
  if (fecha && created && Math.abs(new Date(fecha) - created) > 45 * 86400000) {
    const fixed = `${created.getFullYear()}${fecha.slice(4)}`;
    if (Math.abs(new Date(fixed) - created) <= 45 * 86400000) fecha = fixed;
  }
  if (!fecha && created) fecha = created.toISOString().slice(0, 10);

  let username = null, nombre = e.userName || null;
  for (const [re, [u, n]] of USER_MAP) if (re.test(e.userName || '')) { username = u; nombre = n; break; }

  rows.push(`(${esc(String(r.id))},${esc(e.vehicleId)},` +
    `(SELECT id FROM usuarios WHERE username=${esc(username)}),${esc(nombre)},` +
    `${esc(fecha)},${esc(r.time)},${esc(r.cuit)},${esc(r.location)},${esc(r.address)},` +
    `${esc(r.liters)},${esc(r.iva)},${esc(r.amount)},${esc(r.km)},'migrado',` +
    `${esc(JSON.stringify({ migradoDe: 'kv-v1', syncedAt: e.syncedAt, fechaOriginal: r.date !== fecha ? r.date : undefined }))},` +
    `${esc(r.createdAt)})`);
}

const sql = `INSERT OR IGNORE INTO cargas
(id,vehiculo_id,usuario_id,usuario_nombre,fecha,hora,emisor_cuit,emisor_localidad,emisor_domicilio,litros,iva,total,km,validacion,validacion_detalle,creado)
VALUES\n${rows.join(',\n')};\n
-- actualizar km_actual de cada vehículo con el máximo migrado
UPDATE vehiculos SET km_actual=(SELECT COALESCE(MAX(km),0) FROM cargas WHERE cargas.vehiculo_id=vehiculos.id AND km IS NOT NULL)
WHERE EXISTS (SELECT 1 FROM cargas WHERE cargas.vehiculo_id=vehiculos.id AND km IS NOT NULL);`;

fs.writeFileSync('worker/migration.sql', sql);
console.log(`migration.sql: ${rows.length} cargas`);