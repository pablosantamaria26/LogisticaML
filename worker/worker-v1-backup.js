/**
 * Cloudflare Worker — Flota ML v5
 *
 * VARIABLES EN CLOUDFLARE DASHBOARD (Settings → Variables & Secrets):
 *   SENDGRID_API_KEY   → API Key de Brevo (xkeysib-...)
 *   GEMINI_API_KEY     → API Key de Gemini
 *   FROM_EMAIL         → santamariapablodaniel@gmail.com
 *   OWNER_EMAIL        → tu email personal
 *   CONTADOR_EMAIL     → email del contador
 *   FLEET_EMAIL        → distribuidoramercadolimpio@gmail.com
 *   VAPID_PRIVATE_KEY  → [REDACTADO]
 *   VAPID_PUBLIC_KEY   → BO5ffoUk2v9SANCQEHtJoApnWxSVk2ozvV-Cc_yG_ktp7bo339VqwL99kbgEYfWWzjFbYCZGsdqLIy9BnI8IUZY
 *
 * KV NAMESPACE binding = "FLOTA_KV"
 */

const TIMEZONE        = "America/Argentina/Buenos_Aires";
const FROM_NAME       = "Flota ML";
const FLEET_EMAIL_DEF = "distribuidoramercadolimpio@gmail.com";
const VAPID_SUBJECT   = "mailto:santamariapablodaniel@gmail.com";

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};
function json(data, status=200){return new Response(JSON.stringify(data),{status,headers:{...CORS,'Content-Type':'application/json'}})}

export default {
  async fetch(request, env, ctx) {
    if(request.method==='OPTIONS') return new Response(null,{headers:CORS});
    const url=new URL(request.url);
    try{
      switch(url.pathname){
        case '/api/health':            return json({ok:true,ts:new Date().toISOString()});
        case '/api/reset-all':         return handleResetAll(request,env);
        case '/api/assignments':       return handleAssignments(request,env);
        case '/api/assign-vehicle':    return handleAssignVehicle(request,env);
        case '/api/weekly-report':     return handleWeeklyReport(request,env);
        case '/api/debug':             return json({
          hasKV: !!env.FLOTA_KV,
          kvType: typeof env.FLOTA_KV,
          envKeys: Object.keys(env).filter(k=>!k.includes('KEY')&&!k.includes('SECRET')&&!k.includes('EMAIL')),
          ts: new Date().toISOString()
        });
        case '/api/process-ticket':    return handleProcessTicket(request,env,ctx);
        case '/api/process-odometer':  return handleProcessOdometer(request,env);
        case '/api/send-confirmation': return handleSendConfirmation(request,env);
        case '/api/send-report':       return handleSendReport(request,env);
        case '/api/sync-record':       return handleSyncRecord(request,env);
        case '/api/maintenance-alert': return handleMaintenanceAlert(request,env);
        case '/api/fuel-analysis':     return handleFuelAnalysis(request,env);
        case '/api/register-push':     return handleRegisterPush(request,env);
        case '/api/push-notify':       return handlePushNotify(request,env);
        case '/api/get-records':       return handleGetRecords(request,env);
        default: return json({error:'Not Found'},404);
      }
    }catch(err){console.error('Worker:',err);return json({error:err.message},500)}
  },
  async scheduled(event,env,ctx){
    const now   = new Date();
    const arNow = new Date(now.toLocaleString('en-US',{timeZone:'America/Argentina/Buenos_Aires'}));
    const arDay  = arNow.getDay();   // 0=dom,1=lun,...,5=vie,6=sab
    const arDate = arNow.getDate();  // 1-31
    const arHour = arNow.getHours(); // 0-23 (hora AR)
    const arMin  = arNow.getMinutes();
    const isWeekday = arDay >= 1 && arDay <= 5; // lun a vie

    // ── EMAILS ──────────────────────────────────────────────────────────────
    // Viernes 15:00 AR → reporte semanal IA
    if(arDay===5 && arHour===15) ctx.waitUntil(sendWeeklyReport(env));
    // Día 25 09:00 AR → resumen contador
    if(arDate===25) ctx.waitUntil(sendContadorReport(env));
    // Día 1  08:00 AR → reporte dueño
    if(arDate===1  && arHour===8) ctx.waitUntil(sendOwnerReport(env));

    // ── PUSH DIARIO (lun-vie 08:00 AR) ──────────────────────────────────────
    if(isWeekday && arHour===8 && arMin<10)
      ctx.waitUntil(sendDailyCheckPush(env));

    // ── PUSH VIERNES LIMPIEZA (vie 13:30 AR) ────────────────────────────────
    if(arDay===5 && arHour===13 && arMin>=30 && arMin<40)
      ctx.waitUntil(sendFridayCleanPush(env));

    // ── PUSH MENSUAL NEUMÁTICOS (día 15 09:00 AR) ───────────────────────────
    if(arDate===15 && arHour===9 && arMin<10)
      ctx.waitUntil(sendTiresPush(env));

    // ── PUSH MENSUAL AUXILIO (día 20 09:00 AR) ───────────────────────────────
    if(arDate===20 && arHour===9 && arMin<10)
      ctx.waitUntil(sendSpareTirePush(env));

    // ── PUSH MENSUAL PAPELES (día 1 08:30 AR) ────────────────────────────────
    if(arDate===1 && arHour===8 && arMin>=30 && arMin<40)
      ctx.waitUntil(sendDocsPush(env));
  },
};

// ── OCR TICKET ────────────────────────────────────────────────────────────────
async function handleProcessTicket(request,env,ctx){
  const{image,apiKey}=await request.json();
  const geminiKey=apiKey||env.GEMINI_API_KEY;
  if(!geminiKey) return json({error:'API Key de Gemini requerida.'},400);
  const b64=image.includes(',')?image.split(',')[1]:image;
  const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
  const payload={
    systemInstruction:{parts:[{text:'Eres experto contador Argentina. Extrae datos tickets nafta. Responde SOLO JSON válido sin markdown.'}]},
    contents:[{role:"user",parts:[
      {text:'Extrae todos los datos del ticket. Devuelve SOLO JSON:\n{"fecha":"YYYY-MM-DD","hora":"HH:MM:SS","surtidor":{"cuit":"XX-XXXXXXXX-X","razonSocial":"","localidad":"","direccion":""},"combustible":{"tipo":"SUPER","litros":0.00,"precioUnitario":0.00},"monto":{"subtotal":0.00,"iva":0.00,"total":0.00},"validaciones":{"iva_creditable":true,"confidencia_ocr":95,"campos_criticos_ok":true}}'},
      {inlineData:{mimeType:"image/jpeg",data:b64}}
    ]}],
    generationConfig:{responseMimeType:"application/json",temperature:0.1}
  };
  try{
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!res.ok){const e=await res.json();throw new Error(`Gemini: ${e.error?.message||res.statusText}`)}
    const data=await res.json();
    const ticket=JSON.parse(data.candidates[0].content.parts[0].text.trim());
    if(env.FIREBASE_CREDENTIALS) ctx.waitUntil(saveToFirebase(ticket,env));
    return json({ticket});
  }catch(err){console.error('Ticket OCR:',err);return json({error:'Error procesando imagen',details:err.message},500)}
}

// ── OCR ODÓMETRO ──────────────────────────────────────────────────────────────
async function handleProcessOdometer(request,env){
  const{image,apiKey}=await request.json();
  const geminiKey=apiKey||env.GEMINI_API_KEY;
  if(!geminiKey) return json({error:'API Key de Gemini requerida.'},400);
  const b64=image.includes(',')?image.split(',')[1]:image;
  const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
  const payload={
    systemInstruction:{parts:[{text:'Eres experto en lectura de tableros de vehículos. Extrae el valor del odómetro. Responde SOLO JSON válido sin markdown.'}]},
    contents:[{role:"user",parts:[
      {text:'Lee el odómetro en esta imagen. Devuelve SOLO JSON: {"km": 123456, "confianza": 95}. Si no podés leerlo con certeza devuelve {"km": null, "confianza": 0}.'},
      {inlineData:{mimeType:"image/jpeg",data:b64}}
    ]}],
    generationConfig:{responseMimeType:"application/json",temperature:0.1}
  };
  try{
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!res.ok) throw new Error('Gemini '+res.status);
    const data=await res.json();
    const result=JSON.parse(data.candidates[0].content.parts[0].text.trim());
    if(!result.km) return json({error:'No se pudo leer el odómetro'},422);
    return json({km:result.km,confianza:result.confianza});
  }catch(err){console.error('Odómetro:',err);return json({error:'Error leyendo odómetro',details:err.message},500)}
}

// ── HELPER: obtener KV sea cual sea el binding name ──────────────────────────
function getKV(env){
  // Probamos los nombres más comunes
  return env.FLOTA_KV || env.KV || env.flota_kv || env.DB || null;
}

// ── SYNC KV ───────────────────────────────────────────────────────────────────
async function handleSyncRecord(request,env){
  const kv=getKV(env);
  if(!kv) return json({ok:true,stored:false,reason:'Sin KV'});
  try{
    const{userId,userName,vehicleId,vehicleName,vehicleIcon,vehicleBaseKm,record}=await request.json();
    if(!record||!vehicleId) return json({error:'Faltan datos'},400);
    const month=(record.date||new Date().toISOString()).slice(0,7);
    const key=`record:${month}:${vehicleId}:${record.id}`;
    await kv.put(key,JSON.stringify({userId,userName,vehicleId,vehicleName,vehicleIcon,vehicleBaseKm:vehicleBaseKm||0,record,syncedAt:new Date().toISOString()}),{expirationTtl:400*86400});
    return json({ok:true,stored:true,key});
  }catch(err){return json({error:err.message},500)}
}

// ── RESET ALL KV ──────────────────────────────────────────────────────────────
async function handleResetAll(request,env){
  const kv=getKV(env);
  if(!kv) return json({error:'Sin KV'},500);
  if(request.method!=='POST') return json({error:'POST requerido'},405);
  const body=await request.json().catch(()=>({}));
  if(body.confirm!=='BORRAR_TODO') return json({error:'Falta confirm'},400);
  try{
    let deleted=0,cursor=undefined;
    do{
      const opts={};if(cursor)opts.cursor=cursor;
      const result=await kv.list(opts);
      await Promise.all(result.keys.map(k=>kv.delete(k.name)));
      deleted+=result.keys.length;
      cursor=result.list_complete?undefined:result.cursor;
    }while(cursor);
    return json({ok:true,deleted,msg:`${deleted} keys borradas`});
  }catch(err){return json({error:err.message},500)}
}

async function handleGetRecords(request,env){
  const kv=getKV(env);
  if(!kv) return json({ok:false,records:[],reason:'Sin KV'});
  try{
    const url=new URL(request.url);
    const mp=url.searchParams.get('month');
    const allRecords=[];
    if(mp){
      // Mes específico
      const list=await kv.list({prefix:`record:${mp}:`});
      const items=await Promise.all(list.keys.map(k=>kv.get(k.name,'json')));
      items.filter(Boolean).forEach(r=>allRecords.push(r));
    }else{
      // TODOS los registros — lista completa con prefix "record:"
      let cursor=undefined;
      do{
        const opts={prefix:'record:'};
        if(cursor)opts.cursor=cursor;
        const result=await kv.list(opts);
        const items=await Promise.all(result.keys.map(k=>kv.get(k.name,'json')));
        items.filter(Boolean).forEach(r=>allRecords.push(r));
        cursor=result.list_complete?undefined:result.cursor;
      }while(cursor);
    }
    return json({ok:true,records:allRecords});
  }catch(err){return json({error:err.message},500)}
}


async function handleRegisterPush(request,env){
  const kv=getKV(env);
  if(!kv) return json({ok:false,stored:false,reason:'Sin KV — verificá el binding en Cloudflare'});
  try{
    const{subscription,userId,username,vehicleId}=await request.json();
    if(!subscription) return json({error:'Sin suscripción'},400);
    const endpoint=subscription.endpoint;
    // Limpiar este endpoint de TODOS los vehículos antes de registrar
    // Así un dispositivo solo aparece en UN vehículo/lista a la vez
    const allKeys=['hiace','saveiro','fiat','__admin__'];
    for(const key of allKeys){
      const vKey=`push:vehicle:${key}`;
      const data=await kv.get(vKey,'json');
      if(!data?.subs?.length) continue;
      const filtered=data.subs.filter(s=>s.subscription?.endpoint!==endpoint);
      if(filtered.length!==data.subs.length){
        await kv.put(vKey,JSON.stringify({subs:filtered}),{expirationTtl:90*86400});
      }
    }
    // Por usuario
    await kv.put(`push:user:${username||userId}`,JSON.stringify({subscription,vehicleId,savedAt:new Date().toISOString()}),{expirationTtl:90*86400});
    // Por vehículo — admin sin vehículo va a __admin__
    const effectiveVehicleId = vehicleId || '__admin__';
    const vKey=`push:vehicle:${effectiveVehicleId}`;
    const existing=await kv.get(vKey,'json')||{subs:[]};
    existing.subs=existing.subs.filter(s=>s.subscription?.endpoint!==endpoint);
    existing.subs.push({subscription,username,savedAt:new Date().toISOString()});
    await kv.put(vKey,JSON.stringify(existing),{expirationTtl:90*86400});
    console.log(`✅ Push registrada para ${username}, vehículo ${effectiveVehicleId}`);
    return json({ok:true, userKey:`push:user:${username||userId}`, vehicleKey:`push:vehicle:${effectiveVehicleId}`});
  }catch(err){console.error('Register push:',err);return json({error:err.message},500)}
}

// ── PUSH NOTIFY ───────────────────────────────────────────────────────────────
async function handlePushNotify(request,env){
  const kv=getKV(env);
  if(!kv) return json({ok:false,reason:'Sin KV — verificá el binding en Cloudflare'});
  try{
    const{vehicleId,title,body,tag}=await request.json();
    // Combinar subs del vehículo + admin (admin recibe todo)
    const vData=await kv.get(`push:vehicle:${vehicleId}`,'json')||{subs:[]};
    const aData=await kv.get('push:vehicle:__admin__','json')||{subs:[]};
    const allSubs=[...vData.subs,...aData.subs.filter(a=>!vData.subs.find(v=>v.subscription?.endpoint===a.subscription?.endpoint))];
    if(!allSubs.length) return json({ok:true,sent:0,reason:'Sin suscriptores'});
    let sent=0;
    const validVehicleSubs=[];
    const validAdminSubs=[];
    for(const entry of allSubs){
      try{
        await sendWebPush(entry.subscription,{title,body,tag:tag||'fml'},env);
        sent++;
        const isAdmin=aData.subs.find(a=>a.subscription?.endpoint===entry.subscription?.endpoint);
        if(isAdmin) validAdminSubs.push(entry); else validVehicleSubs.push(entry);
      }catch(e){
        const msg=e.message||'';
        if(msg.includes('410')||msg.includes('404')){
          console.warn(`🗑️ Sub expirada eliminada: ${entry.username}`);
        }else{
          console.warn('Push error:',msg);
          const isAdmin=aData.subs.find(a=>a.subscription?.endpoint===entry.subscription?.endpoint);
          if(isAdmin) validAdminSubs.push(entry); else validVehicleSubs.push(entry);
        }
      }
    }
    if(validVehicleSubs.length!==vData.subs.length)
      await kv.put(`push:vehicle:${vehicleId}`,JSON.stringify({subs:validVehicleSubs}),{expirationTtl:90*86400});
    if(validAdminSubs.length!==aData.subs.length)
      await kv.put('push:vehicle:__admin__',JSON.stringify({subs:validAdminSubs}),{expirationTtl:90*86400});
    return json({ok:true,sent,total:allSubs.length,cleaned:allSubs.length-validVehicleSubs.length-validAdminSubs.length});
  }catch(err){return json({error:err.message},500)}
}


// ══════════════════════════════════════════════════════════════════════════════
// FLEET PUSH HELPERS
// ══════════════════════════════════════════════════════════════════════════════
const FLEET_NAME = '🚛 MERCADO LIMPIO FLOTA';
const VEHICLE_USERS = {
  hiace:   { username: 'nicolas', name: 'Nicolás',  icon: '🚐' },
  saveiro: { username: 'martin',  name: 'Martín',   icon: '🚙' },
  fiat:    { username: 'ramiro',  name: 'Ramiro',   icon: '🚗' },
};

async function pushToAll(payload, env) {
  const kv = getKV(env); if (!kv) return;
  const vehicles = ['hiace','saveiro','fiat','__admin__'];
  const seen = new Set();
  const allSubs = [];
  for (const vid of vehicles) {
    const d = await kv.get(`push:vehicle:${vid}`, 'json') || { subs: [] };
    for (const s of d.subs) {
      if (!seen.has(s.subscription?.endpoint)) {
        seen.add(s.subscription?.endpoint);
        allSubs.push(s);
      }
    }
  }
  let sent = 0, failed = 0;
  for (const entry of allSubs) {
    try { await sendWebPush(entry.subscription, payload, env); sent++; }
    catch(e) { failed++; console.warn('pushToAll error:', e.message); }
  }
  console.log(`📣 pushToAll "${payload.title}" → sent=${sent} failed=${failed}`);
}

async function pushToVehicle(vid, payload, env) {
  const kv = getKV(env); if (!kv) return;
  const d = await kv.get(`push:vehicle:${vid}`, 'json') || { subs: [] };
  // Admin siempre recibe
  const adm = await kv.get('push:vehicle:__admin__', 'json') || { subs: [] };
  const all = [...d.subs, ...adm.subs.filter(a => !d.subs.find(v => v.subscription?.endpoint === a.subscription?.endpoint))];
  for (const entry of all) {
    try { await sendWebPush(entry.subscription, payload, env); }
    catch(e) { console.warn(`pushToVehicle ${vid}:`, e.message); }
  }
}

// ── CRON: Revisión diaria (lun-vie 08:00 AR) ─────────────────────────────────
async function sendDailyCheckPush(env) {
  await pushToAll({
    title: `${FLEET_NAME}`,
    body:  '🔍 Revisión diaria antes de salir: nivel de agua refrigerante, aceite de motor y agua del limpiaparabrisas. ¡Que tengas un buen día!',
    tag:   'daily-check',
  }, env);
}

// ── CRON: Limpieza personalizada (viernes 13:30 AR) ──────────────────────────
async function sendFridayCleanPush(env) {
  for (const [vid, info] of Object.entries(VEHICLE_USERS)) {
    await pushToVehicle(vid, {
      title: `${FLEET_NAME}`,
      body:  `Hola ${info.name} ${info.icon} — Es viernes. Recordá mantener el ${info.icon} limpio por dentro y por fuera. ¡Es nuestra herramienta de trabajo!`,
      tag:   `friday-clean-${vid}`,
    }, env);
  }
}

// ── CRON: Neumáticos (día 15, una vez al mes) ─────────────────────────────────
async function sendTiresPush(env) {
  await pushToAll({
    title: `${FLEET_NAME}`,
    body:  '🔵 Recordatorio mensual: calibrá las 4 ruedas de aire. Evitá desgaste desigual de cubiertas y daños en el tren delantero.',
    tag:   'tires-monthly',
  }, env);
}

// ── CRON: Auxilio/rueda de repuesto (día 20, una vez al mes) ─────────────────
async function sendSpareTirePush(env) {
  await pushToAll({
    title: `${FLEET_NAME}`,
    body:  '🛞 Revisá que el auxilio esté en condiciones: neumático inflado, llave y gato. Ante cualquier eventualidad, queremos que estés cubierto.',
    tag:   'spare-monthly',
  }, env);
}

// ── CRON: Papeles al día (día 1, una vez al mes) ─────────────────────────────
async function sendDocsPush(env) {
  await pushToAll({
    title: `${FLEET_NAME}`,
    body:  '📋 Recordatorio mensual: VTV vigente, registro de conducir, cédula verde y certificado de seguro. ¡Controlá que todo esté en orden!',
    tag:   'docs-monthly',
  }, env);
}

// ── WEB PUSH SEND — RFC 8291 aes128gcm ──────────────────────────────────────
async function sendWebPush(subscription, payload, env) {
  if (!env.VAPID_PRIVATE_KEY) { console.warn('Sin VAPID_PRIVATE_KEY'); return; }

  const endpoint = subscription.endpoint;
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);

  // ── 1. VAPID JWT ────────────────────────────────────────────────────────
  const pubRaw = b64ToBytes(env.VAPID_PUBLIC_KEY);
  const privJwk = {
    kty:'EC', crv:'P-256', ext:true, key_ops:['sign'],
    d: b64url(b64ToBytes(env.VAPID_PRIVATE_KEY)),
    x: b64url(pubRaw.slice(1,33)),
    y: b64url(pubRaw.slice(33,65)),
  };
  const privKey = await crypto.subtle.importKey('jwk', privJwk, {name:'ECDSA',namedCurve:'P-256'}, false, ['sign']);
  const header  = b64url(te('{"typ":"JWT","alg":"ES256"}'));
  const claims  = b64url(te(JSON.stringify({aud:audience, exp:now+43200, sub:VAPID_SUBJECT})));
  const sig     = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, privKey, te(`${header}.${claims}`));
  const jwt     = `${header}.${claims}.${b64url(sig)}`;

  // ── 2. Cifrado RFC 8291 aes128gcm ──────────────────────────────────────
  const authSecret  = b64ToBytes(subscription.keys.auth);
  const receiverPub = b64ToBytes(subscription.keys.p256dh);
  const plaintext   = te(JSON.stringify(payload));

  // Par efímero
  const ephPair   = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'}, true, ['deriveBits']);
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephPair.publicKey));

  // ECDH shared secret
  const rxKey    = await crypto.subtle.importKey('raw', receiverPub, {name:'ECDH',namedCurve:'P-256'}, false, []);
  const ikm      = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:rxKey}, ephPair.privateKey, 256));

  // Salt 16 bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK — RFC 8291 §3.3: HKDF-Extract(salt=authSecret, IKM=ikm)
  // info = "WebPush: info" || 0x00 || receiverPub(65) || senderPub(65)
  const prkInfo = cat(te('WebPush: info'), new Uint8Array([0]), receiverPub, ephPubRaw);
  const ikmKey  = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const prk     = new Uint8Array(await crypto.subtle.deriveBits(
    {name:'HKDF', hash:'SHA-256', salt:authSecret, info:prkInfo}, ikmKey, 256
  ));

  // CEK 16 bytes, Nonce 12 bytes — RFC 8291 §3.3
  // info = label || 0x00  (un solo byte nulo, SIN el 0x01 de HKDF genérico)
  const prkKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);
  const cek    = new Uint8Array(await crypto.subtle.deriveBits(
    {name:'HKDF', hash:'SHA-256', salt, info:cat(te('Content-Encoding: aes128gcm'), new Uint8Array([0]))}, prkKey, 128
  ));
  const nonce  = new Uint8Array(await crypto.subtle.deriveBits(
    {name:'HKDF', hash:'SHA-256', salt, info:cat(te('Content-Encoding: nonce'), new Uint8Array([0]))}, prkKey, 96
  ));

  // Encrypt: plaintext || 0x02 (delimiter, sin padding)
  // rs en el header = tamaño real del ciphertext (RFC 8291 lo permite)
  // NO hacer padding a 4096 — el body total superaría el límite de 4KB de Apple/FCM
  const aesKey     = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    {name:'AES-GCM', iv:nonce}, aesKey, cat(plaintext, new Uint8Array([2]))
  ));

  // aes128gcm binary header: salt(16) + rs(4 BE) + idlen(1) + keyid(65)
  // rs = 4096 — record size fijo (RFC 8291 §2). Debe ser >= ciphertext.length.
  // Usar ciphertext.length exacto hace que algunos browsers rechacen la notif.
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const body = cat(salt, rs, new Uint8Array([ephPubRaw.length]), ephPubRaw, ciphertext);

  // ── 3. POST ─────────────────────────────────────────────────────────────
  const res = await fetch(endpoint, {
    method:'POST',
    headers:{
      'Authorization':    `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
      'Urgency':          'high',
    },
    body,
  });
  if (res.status !== 200 && res.status !== 201) {
    const t = await res.text().catch(()=>'');
    throw new Error(`Push ${res.status}: ${t}`);
  }
  console.log(`✅ Push enviado a ${endpoint.slice(0,60)}... status=${res.status}`);
}

function te(s){return new TextEncoder().encode(s)}
function cat(...a){const t=a.reduce((s,x)=>s+x.length,0);const o=new Uint8Array(t);let p=0;for(const x of a){o.set(x,p);p+=x.length}return o}
function b64url(i){const b=i instanceof Uint8Array?i:new Uint8Array(i);let s='';for(const x of b)s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}
function b64ToBytes(s){const p='='.repeat((4-s.length%4)%4);const b=(s+p).replace(/-/g,'+').replace(/_/g,'/');return new Uint8Array([...atob(b)].map(c=>c.charCodeAt(0)))}

// ── CONFIRMATION EMAIL ────────────────────────────────────────────────────────
async function handleSendConfirmation(request,env){
  const{to,cc,userName,vehicleName,vehicleIcon,fuelRecord,location,address}=await request.json();
  if(!to) return json({error:'Email requerido'},400);
  if(!env.SENDGRID_API_KEY) return json({error:'API key no configurada'},500);
  const ppl=fuelRecord.liters>0?(fuelRecord.amount/fuelRecord.liters).toFixed(2):'—';
  const html=buildConfirmEmail({userName,vehicleName,vehicleIcon,fuelRecord,location:location||fuelRecord.location||'—',address:address||fuelRecord.address||'—',pricePerLiter:ppl});
  const toList=[to];if(cc&&cc.includes('@')&&cc!==to)toList.push(cc);
  const res=await sendViaBrevo({to:toList,subject:`⛽ Carga registrada — ${vehicleIcon} ${vehicleName}`,html},env);
  if(!res.ok){const t=await res.text();return json({error:'Email rechazado',details:t},500)}
  return json({success:true,to});
}

async function handleSendReport(request,env){
  const{to,reportType,vehicleName,fuelRecords,summary}=await request.json();
  if(!to) return json({error:'Email requerido'},400);
  if(!env.SENDGRID_API_KEY) return json({error:'API key no configurada'},500);
  const isC=reportType==='contador';
  const html=isC?buildContadorEmail(fuelRecords,vehicleName,summary):buildOwnerEmail([{vehicleName,vehicleIcon:'🚛',records:fuelRecords,summary}],summary);
  const res=await sendViaBrevo({to:[to],subject:isC?'🧾 Flota ML — Resumen Crédito Fiscal':'📊 Flota ML — Reporte del Mes',html},env);
  if(!res.ok){const t=await res.text();return json({error:'Email rechazado',details:t},500)}
  return json({success:true});
}

async function handleMaintenanceAlert(request,env){
  const{vehicleName,vehicleIcon,currentKm,nextServiceKm,kmLeft,userEmail}=await request.json();
  if(!env.SENDGRID_API_KEY) return json({error:'API key no configurada'},500);
  const fleetEmail=env.FLEET_EMAIL||FLEET_EMAIL_DEF;
  const html=buildMaintenanceAlertEmail({vehicleName,vehicleIcon,currentKm,nextServiceKm,kmLeft});
  const toList=[fleetEmail];if(userEmail&&userEmail.includes('@')&&userEmail!==fleetEmail)toList.push(userEmail);
  const res=await sendViaBrevo({to:toList,subject:`🔧 Servicio próximo — ${vehicleIcon} ${vehicleName} (faltan ${fmtN(kmLeft)} km)`,html},env);
  if(!res.ok){const t=await res.text();return json({error:'Email rechazado',details:t},500)}
  return json({success:true});
}

async function handleFuelAnalysis(request,env){
  const{vehicleGroups,fuelPriceHistory}=await request.json();
  const geminiKey=env.GEMINI_API_KEY;
  if(!geminiKey) return json({error:'GEMINI_API_KEY requerida'},400);
  const prompt=`Eres analista de flota en Argentina. Analizá estos datos y respondé SOLO JSON sin markdown.\nFlota: ${JSON.stringify(vehicleGroups)}\nPrecios: ${JSON.stringify(fuelPriceHistory)}\nDevuelve: {"priceTrend":{"direction":"sube|baja|estable","percentChange":0.0,"analysis":""},"vehicles":[{"vehicleId":"","vehicleName":"","projectedNextMonthARS":0,"weeklyBudgetARS":0,"costPerKm":0.0,"efficiencyTrend":"mejora|empeora|estable","advice":""}],"globalAdvice":""}`;
  try{
    const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:0.3}})});
    if(!res.ok) throw new Error('Gemini '+res.status);
    const data=await res.json();
    return json({analysis:JSON.parse(data.candidates[0].content.parts[0].text.trim())});
  }catch(err){return json({error:err.message},500)}
}

// ── ASSIGNMENTS ───────────────────────────────────────────────────────────────
async function handleAssignments(request,env){
  const kv=getKV(env);if(!kv)return json({ok:true,assignments:{}});
  try{
    const data=await kv.get('assignments','json')||{};
    return json({ok:true,assignments:data});
  }catch(e){return json({ok:false,assignments:{},error:e.message})}
}
async function handleAssignVehicle(request,env){
  const kv=getKV(env);if(!kv)return json({error:'Sin KV'},500);
  try{
    const{adminPin,username,vehicleId}=await request.json();
    if(adminPin!=='2817')return json({error:'No autorizado'},403);
    if(!username||!vehicleId)return json({error:'Faltan datos'},400);
    const data=await kv.get('assignments','json')||{};
    data[username.toLowerCase()]=vehicleId;
    await kv.put('assignments',JSON.stringify(data),{expirationTtl:365*86400});
    // Invalida cache push para ese usuario (fuerza re-registro con nuevo vehículo)
    await kv.delete(`push:user:${username.toLowerCase()}`);
    return json({ok:true,username,vehicleId});
  }catch(e){return json({error:e.message},500)}
}

// ── WEEKLY REPORT ─────────────────────────────────────────────────────────────
async function handleWeeklyReport(request,env){
  if(!env.SENDGRID_API_KEY)return json({error:'Sin API key email'},500);
  await sendWeeklyReport(env);
  return json({ok:true});
}
async function sendWeeklyReport(env){
  const ownerEmail=env.OWNER_EMAIL;if(!ownerEmail)return;
  const kv=getKV(env);if(!kv)return;
  // Traer todos los registros del KV
  let allRecords=[];
  try{
    let cursor;
    do{
      const opts={prefix:'record:'};if(cursor)opts.cursor=cursor;
      const result=await kv.list(opts);
      const items=await Promise.all(result.keys.map(k=>kv.get(k.name,'json')));
      items.filter(Boolean).forEach(r=>allRecords.push(r));
      cursor=result.list_complete?undefined:result.cursor;
    }while(cursor);
  }catch(e){return}
  if(!allRecords.length)return;

  // Agrupar por vehículo
  const byV={};
  allRecords.forEach(entry=>{
    const vid=entry.vehicleId;const r=entry.record;if(!r)return;
    if(!byV[vid])byV[vid]={name:entry.vehicleName,icon:entry.vehicleIcon,records:[],drivers:new Set(),baseKm:0};
    // Actualizar baseKm con el vehicleBaseKm más bajo encontrado (punto de partida histórico)
    if(entry.vehicleBaseKm>0&&(byV[vid].baseKm===0||entry.vehicleBaseKm<byV[vid].baseKm))byV[vid].baseKm=entry.vehicleBaseKm;
    byV[vid].records.push({...r, _syncedAt: entry.syncedAt});
    if(entry.userName)byV[vid].drivers.add(entry.userName);
  });

  // Semana actual
  const now=new Date();
  const weekAgo=new Date(now-7*86400000);
  const monthAgo=new Date(now-60*86400000); // límite inferior razonable

  // Helper: fecha efectiva del registro — usa syncedAt si record.date es antigua o futura
  function effectiveDate(r, syncedAt){
    const rd=new Date(r.date);
    // Si la fecha del ticket es razonable (últimos 60 días o futura hasta 1 día), usarla
    if(rd>=monthAgo && rd<=new Date(now.getTime()+86400000)) return rd;
    // Sino, usar syncedAt (fecha real de registro)
    return syncedAt ? new Date(syncedAt) : rd;
  }

  // Calcular métricas por vehículo
  const vehicleStats=Object.entries(byV).map(([vid,vd])=>{
    // Necesitamos syncedAt — viene del entry padre, lo adjuntamos al record en la fase de merge
    const recs=vd.records.sort((a,b)=>new Date(a.date)-new Date(b.date));
    const weekRecs=recs.filter(r=>effectiveDate(r,r._syncedAt)>=weekAgo);
    const totalLit=recs.reduce((s,r)=>s+(r.liters||0),0);
    const totalAmt=recs.reduce((s,r)=>s+(r.amount||0),0);
    const weekLit=weekRecs.reduce((s,r)=>s+(r.liters||0),0);
    const weekAmt=weekRecs.reduce((s,r)=>s+(r.amount||0),0);
    // KM recorridos — usa vehicleBaseKm como punto de partida si solo hay 1 registro
    const kms=recs.filter(r=>r.km>0).map(r=>r.km).sort((a,b)=>a-b);
    const baseKm=vd.baseKm||0; // KM previo al primer registro, enviado desde el cliente
    let kmRange=0;
    if(kms.length>=2) kmRange=kms[kms.length-1]-kms[0];
    else if(kms.length===1&&baseKm>0&&kms[0]>baseKm) kmRange=kms[0]-baseKm;
    const costPerKm=kmRange>0?totalAmt/kmRange:0;
    const kmL=totalLit>0?kmRange/totalLit:0;
    // Anomalías: consumo semanal vs promedio histórico
    const prevRecs=recs.filter(r=>effectiveDate(r,r._syncedAt)<weekAgo);
    const prevWeekLit=prevRecs.length>=2?prevRecs.slice(-2).reduce((s,r)=>s+(r.liters||0),0)/2:0;
    const anomaly=prevWeekLit>0&&weekLit>prevWeekLit*1.25;
    const anomalyPct=prevWeekLit>0?Math.round((weekLit/prevWeekLit-1)*100):0;
    // Detección cargas sospechosas
    const TANK_SIZES={hiace:70,saveiro:55,fiat:45};
    const maxTank=TANK_SIZES[vid]||70;
    const suspicious=weekRecs.filter(r=>r.liters>maxTank);
    // Proyección semanal
    const weeklyAvgLit=prevRecs.length>0?prevRecs.reduce((s,r)=>s+(r.liters||0),0)/(prevRecs.length/2||1):weekLit;
    const weeklyAvgAmt=prevRecs.length>0?prevRecs.reduce((s,r)=>s+(r.amount||0),0)/(prevRecs.length/2||1):weekAmt;
    return{vid,name:vd.name,icon:vd.icon,drivers:[...vd.drivers],
      totalRecs:recs.length,weekRecs:weekRecs.length,
      weekLit,weekAmt,totalLit,totalAmt,kmRange,costPerKm,kmL,
      anomaly,anomalyPct,suspicious,weeklyAvgLit,weeklyAvgAmt};
  });

  // Ranking por km/l
  const ranked=[...vehicleStats].filter(v=>v.kmL>0).sort((a,b)=>b.kmL-a.kmL);

  // Análisis IA si hay clave Gemini
  let iaAdvice='';
  if(env.GEMINI_API_KEY&&vehicleStats.length){
    try{
      const prompt=`Sos analista de flota de reparto en Argentina. Analizá estos datos de la semana y devolve un resumen ejecutivo breve (máx 3 párrafos) en español, con anomalías detectadas, recomendaciones prácticas y proyección de gasto semanal óptimo. Datos: ${JSON.stringify(vehicleStats.map(v=>({vehiculo:v.name,kmRecorridos:v.kmRange,litrosSemana:v.weekLit.toFixed(1),gastoSemana:'$'+Math.round(v.weekAmt),kmPorLitro:v.kmL.toFixed(2),anomalia:v.anomaly?`+${v.anomalyPct}% consumo`:null})))}. Días laborables: lunes a viernes 8am-15/21hs. Respondé SOLO texto plano sin markdown.`;
      const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.4}})});
      if(res.ok){const d=await res.json();iaAdvice=d.candidates?.[0]?.content?.parts?.[0]?.text||'';}
    }catch(e){iaAdvice=''}
  }

  const html=buildWeeklyEmail(vehicleStats,ranked,iaAdvice,now);
  const res=await sendViaBrevo({to:[ownerEmail],subject:`📊 Flota ML — Reporte Semanal ${now.toLocaleDateString('es-AR',{timeZone:TIMEZONE,day:'2-digit',month:'2-digit'})}`,html},env);
  if(!res.ok)console.error('Weekly report:',await res.text());
}

function buildWeeklyEmail(stats,ranked,iaAdvice,now){
  const fmtN=n=>(n||0).toLocaleString('es-AR');
  const fmt$=n=>'$'+(n||0).toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:0});
  const weekStr=now.toLocaleDateString('es-AR',{timeZone:TIMEZONE,day:'2-digit',month:'long',year:'numeric'});

  const anomalias=stats.filter(v=>v.anomaly);
  const suspicious=stats.flatMap(v=>v.suspicious.map(r=>({...r,vname:v.name,vicon:v.icon})));

  const vehicleCards=stats.map(v=>`
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:1rem;margin-bottom:.75rem;position:relative;border-left:4px solid #1e40af">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
        <div style="font-size:1.1rem;font-weight:800;color:#0f172a">${v.icon} ${v.name}</div>
        ${v.anomaly
          ?`<span style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;padding:.2rem .6rem;border-radius:20px;font-size:.7rem;font-weight:700">⚠️ CONSUMO +${v.anomalyPct}%</span>`
          :`<span style="background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;padding:.2rem .6rem;border-radius:20px;font-size:.7rem;font-weight:700">✅ Normal</span>`}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <tr>
          <td style="padding:.35rem .5rem;background:#f8fafc;border-radius:6px;text-align:center;width:16%"><div style="font-weight:800;color:#15803d;font-size:1rem">${v.weekRecs}</div><div style="font-size:.6rem;color:#64748b">Cargas</div></td>
          <td style="width:2%"></td>
          <td style="padding:.35rem .5rem;background:#f8fafc;border-radius:6px;text-align:center;width:16%"><div style="font-weight:800;color:#15803d;font-size:1rem">${v.weekLit.toFixed(1)}L</div><div style="font-size:.6rem;color:#64748b">Litros</div></td>
          <td style="width:2%"></td>
          <td style="padding:.35rem .5rem;background:#f8fafc;border-radius:6px;text-align:center;width:20%"><div style="font-weight:800;color:#d97706;font-size:1rem">${fmt$(v.weekAmt)}</div><div style="font-size:.6rem;color:#64748b">Gasto</div></td>
          <td style="width:2%"></td>
          <td style="padding:.35rem .5rem;background:#f8fafc;border-radius:6px;text-align:center;width:16%"><div style="font-weight:800;color:#1e40af;font-size:1rem">${fmtN(Math.round(v.kmRange))}</div><div style="font-size:.6rem;color:#64748b">KM</div></td>
          <td style="width:2%"></td>
          <td style="padding:.35rem .5rem;background:#f8fafc;border-radius:6px;text-align:center;width:12%"><div style="font-weight:800;color:#1e40af;font-size:1rem">${v.kmL>0?v.kmL.toFixed(2):'—'}</div><div style="font-size:.6rem;color:#64748b">km/L</div></td>
          <td style="width:2%"></td>
          <td style="padding:.35rem .5rem;background:#f8fafc;border-radius:6px;text-align:center;width:12%"><div style="font-weight:800;color:#1e40af;font-size:1rem">${v.costPerKm>0?'$'+v.costPerKm.toFixed(0):'—'}</div><div style="font-size:.6rem;color:#64748b">$/km</div></td>
        </tr>
      </table>
      <div style="margin-top:.5rem;font-size:.72rem;color:#64748b">👤 ${v.drivers.join(', ')||'Sin asignar'} · Proyección: ${fmt$(v.weeklyAvgAmt)}/semana</div>
    </div>`).join('');

  const rankingRows=ranked.map((v,i)=>`<tr><td style="padding:.5rem .75rem;border-bottom:1px solid #f1f5f9">${['🥇','🥈','🥉'][i]||`${i+1}.`}</td><td style="padding:.5rem .75rem;border-bottom:1px solid #f1f5f9;font-weight:700;color:#0f172a">${v.icon} ${v.name}</td><td style="padding:.5rem .75rem;border-bottom:1px solid #f1f5f9;font-weight:800;color:#15803d">${v.kmL.toFixed(2)} km/L</td><td style="padding:.5rem .75rem;border-bottom:1px solid #f1f5f9;color:#d97706;font-weight:700">$${v.costPerKm.toFixed(0)}/km</td></tr>`).join('');

  const anomaliasHtml=anomalias.length?`
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:1rem;margin-bottom:1rem">
      <div style="font-weight:800;color:#92400e;margin-bottom:.5rem">⚠️ Anomalías detectadas esta semana</div>
      ${anomalias.map(v=>`<div style="font-size:.82rem;color:#78350f;margin-bottom:.25rem">• ${v.icon} ${v.name}: consumo +${v.anomalyPct}% respecto a semana anterior. Revisar neumáticos, filtros o estilo de manejo.</div>`).join('')}
    </div>`:'';

  const suspiciousHtml=suspicious.length?`
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:1rem;margin-bottom:1rem">
      <div style="font-weight:800;color:#991b1b;margin-bottom:.5rem">🚨 Cargas sospechosas</div>
      ${suspicious.map(r=>`<div style="font-size:.82rem;color:#7f1d1d;margin-bottom:.25rem">• ${r.vicon} ${r.vname}: ${r.liters.toFixed(1)}L cargados (supera capacidad del tanque). Verificar ticket.</div>`).join('')}
    </div>`:'';

  const iaHtml=iaAdvice?`
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:1rem;margin-bottom:1rem">
      <div style="font-weight:800;color:#1e40af;margin-bottom:.75rem">🤖 Análisis IA</div>
      <div style="font-size:.84rem;color:#1e293b;line-height:1.75;white-space:pre-line">${iaAdvice}</div>
    </div>`:'';

  const header=`<div style="font-size:1.4rem;font-weight:700;margin-bottom:.25rem">📊 Reporte Semanal</div><div style="color:#64748b;font-size:.82rem">Semana al ${weekStr}</div>`;
  const body=`
    <p class="sec-title">Estado por vehículo</p>
    ${vehicleCards}
    ${anomaliasHtml}
    ${suspiciousHtml}
    ${ranked.length?`<p class="sec-title" style="margin-top:1.5rem">🏆 Ranking eficiencia (km/L)</p>
    <div class="tbl-wrap"><table style="min-width:0">
      <thead><tr><th>#</th><th>Vehículo</th><th>km/L</th><th>$/km</th></tr></thead>
      <tbody>${rankingRows}</tbody>
    </table></div>`:''}
    ${iaHtml}`;
  return emailShell(`Reporte Semanal — Flota ML`,header,body);
}

// ── CRON ──────────────────────────────────────────────────────────────────────
async function sendContadorReport(env){
  const contEmail=env.CONTADOR_EMAIL;if(!contEmail)return;
  const now=new Date();
  const month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const records=await getKVRecords(env,month);if(!records.length)return;
  const res=await sendViaBrevo({to:[contEmail],subject:`🧾 Flota ML — Resumen Crédito Fiscal ${formatMonth(now)}`,html:buildContadorEmail(records,'Toda la flota',summarize(records))},env);
  if(!res.ok)console.error('Contador:',await res.text());
}
async function sendOwnerReport(env){
  const ownerEmail=env.OWNER_EMAIL;if(!ownerEmail)return;
  const now=new Date();const prev=new Date(now.getFullYear(),now.getMonth()-1,1);
  const month=`${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
  const allRecords=await getKVRecords(env,month);if(!allRecords.length)return;
  const byV={};
  allRecords.forEach(r=>{if(!byV[r.vehicleId])byV[r.vehicleId]={vehicleName:r.vehicleName,vehicleIcon:r.vehicleIcon,records:[]};byV[r.vehicleId].records.push(r.record)});
  const groups=Object.values(byV).map(g=>({...g,summary:summarize(g.records)}));
  const res=await sendViaBrevo({to:[ownerEmail],subject:`📊 Flota ML — Reporte del Mes ${formatMonth(prev)}`,html:buildOwnerEmail(groups,summarize(allRecords.map(r=>r.record)))},env);
  if(!res.ok)console.error('Owner:',await res.text());
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function sendViaBrevo(payload,env){
  return fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':env.SENDGRID_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({sender:{name:FROM_NAME,email:env.FROM_EMAIL||'santamariapablodaniel@gmail.com'},to:payload.to.map(e=>({email:e})),subject:payload.subject,htmlContent:payload.html})});
}
async function getKVRecords(env,month){
  const kv=env.FLOTA_KV;if(!kv)return[];
  try{const list=await kv.list({prefix:`record:${month}:`});const items=await Promise.all(list.keys.map(k=>kv.get(k.name,'json')));return items.filter(Boolean)}
  catch(e){return[]}
}
function summarize(r){const a=r.reduce((s,x)=>s+(x.amount||0),0);const l=r.reduce((s,x)=>s+(x.liters||0),0);const v=r.reduce((s,x)=>s+(x.iva||0),0);return{count:r.length,totalAmount:a,totalLiters:l,totalIva:v,avgPrice:l>0?a/l:0}}
function formatMonth(d){return d.toLocaleDateString('es-AR',{month:'long',year:'numeric',timeZone:TIMEZONE})}
function fmt$(n){return'$'+(n||0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmtN(n){return(n||0).toLocaleString('es-AR')}
async function saveToFirebase(ticket,env){
  try{const c=JSON.parse(env.FIREBASE_CREDENTIALS);const p=c.project_id||c.projectId;if(!p)return;
  const url=`https://firestore.googleapis.com/v1/projects/${p}/databases/(default)/documents/tickets`;
  const doc={fields:{ts:{stringValue:new Date().toISOString()},fecha:{stringValue:ticket.fecha||''},total:{doubleValue:ticket.monto?.total||0},iva:{doubleValue:ticket.monto?.iva||0},litros:{doubleValue:ticket.combustible?.litros||0},cuit:{stringValue:ticket.surtidor?.cuit||''}}};
  await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(doc)})
  }catch(e){console.error('Firebase:',e)}
}

// ══════════════════════════════════════════════════════════════════════════════
// EMAIL TEMPLATES
// ══════════════════════════════════════════════════════════════════════════════
function buildConfirmEmail({userName,vehicleName,vehicleIcon,fuelRecord,location,address,pricePerLiter}){
  const header=`<h1 class="h-title">⛽ Carga registrada</h1><p class="h-sub">${vehicleIcon} ${vehicleName} &nbsp;·&nbsp; ${fuelRecord.date}</p>`;
  const body=`
    <div class="v-hero"><span class="v-emoji">${vehicleIcon}</span><div class="v-name">${vehicleName}</div><div class="v-greet">Hola <strong>${userName}</strong> — carga registrada correctamente ✓</div></div>
    <p class="sec-title">📋 Detalle de la carga</p>
    <div class="row"><span class="row-l">📅 Fecha</span><span class="row-v">${fuelRecord.date}</span></div>
    <div class="row"><span class="row-l">🕐 Hora</span><span class="row-v">${fuelRecord.time||'—'}</span></div>
    <div class="row"><span class="row-l">📍 Localidad</span><span class="row-v">${location}</span></div>
    <div class="row"><span class="row-l">🗺️ Dirección</span><span class="row-v">${address}</span></div>
    <div class="row"><span class="row-l">⛽ Litros</span><span class="row-v">${(fuelRecord.liters||0).toFixed(2)} L</span></div>
    <div class="row"><span class="row-l">💲 Precio/litro</span><span class="row-v">$${pricePerLiter}</span></div>
    ${fuelRecord.iva?`<div class="row"><span class="row-l">🧾 IVA 21%</span><span class="row-v">${fmt$(fuelRecord.iva)}</span></div>`:''}
    ${fuelRecord.cuit?`<div class="row"><span class="row-l">🏢 CUIT</span><span class="row-v mono">${fuelRecord.cuit}</span></div>`:''}
    ${fuelRecord.km?`<div class="row"><span class="row-l">🛣️ Kilómetros</span><span class="row-v">${fmtN(fuelRecord.km)} km</span></div>`:''}
    <div class="total-box"><span class="total-l">💰 Total pagado</span><span class="total-v">${fmt$(fuelRecord.amount)}</span></div>
    <div class="badges"><span class="badge bg">✅ Válido para crédito fiscal IVA</span><span class="badge bb">📊 Registrado en Flota ML</span></div>
    <div class="divider"></div>
    <p style="font-size:.8rem;color:#94a3b8;line-height:1.7">El IVA acumulado se reportará al contador el día 25 de cada mes.</p>`;
  return emailShell(`Carga confirmada — ${vehicleName}`,header,body);
}

function buildContadorEmail(records,fleetName,summary){
  const byV={};
  records.forEach(r=>{const rec=r.record||r;const vid=r.vehicleId||'x';if(!byV[vid])byV[vid]={name:r.vehicleName||fleetName,icon:r.vehicleIcon||'🚛',recs:[],iva:0,total:0};byV[vid].recs.push(rec);byV[vid].iva+=(rec.iva||0);byV[vid].total+=(rec.amount||0)});
  const all=records.map(r=>r.record||r);
  const tIva=all.reduce((s,r)=>s+(r.iva||0),0),tAmt=all.reduce((s,r)=>s+(r.amount||0),0),tLit=all.reduce((s,r)=>s+(r.liters||0),0);
  const mes=formatMonth(new Date());
  const rows=all.sort((a,b)=>new Date(a.date)-new Date(b.date)).map(r=>`<tr><td>${r.date||'—'}</td><td style="font-family:monospace;font-size:.78rem">${r.cuit||'—'}</td><td>${r.location||'—'}</td><td style="text-align:right">${(r.liters||0).toFixed(2)}</td><td style="text-align:right">${fmt$(r.amount)}</td><td style="text-align:right;color:#15803d;font-weight:700">${r.iva?fmt$(r.iva):'—'}</td></tr>`).join('');
  const vCards=Object.values(byV).map(v=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#f8faff;border-radius:12px;margin-bottom:8px;border:1px solid #e0e7ff"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:1.8rem">${v.icon}</span><div><div style="font-weight:800">${v.name}</div><div style="font-size:.75rem;color:#64748b">${v.recs.length} cargas · ${fmt$(v.total)}</div></div></div><span class="badge bg">IVA ${fmt$(v.iva)}</span></div>`).join('');
  const header=`<h1 class="h-title">🧾 Crédito Fiscal IVA</h1><p class="h-sub">Período: <strong>${mes}</strong> &nbsp;·&nbsp; Enviado automáticamente el día 25</p>`;
  const body=`<div class="sgrid"><div class="sc"><span class="sv">${all.length}</span><span class="sl">Cargas totales</span></div><div class="sc"><span class="sv">${tLit.toFixed(1)} L</span><span class="sl">Litros</span></div><div class="sc"><span class="sv">${fmt$(tAmt)}</span><span class="sl">Gasto total</span></div><div class="sc g"><span class="sv">${fmt$(tIva)}</span><span class="sl">IVA a imputar</span></div></div><p class="sec-title">🚛 IVA por vehículo</p>${vCards}<div class="divider"></div><p class="sec-title">📋 Detalle completo</p><div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>CUIT</th><th>Localidad</th><th style="text-align:right">Litros</th><th style="text-align:right">Total</th><th style="text-align:right">IVA 21%</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="3"><strong>TOTALES</strong></td><td style="text-align:right">${tLit.toFixed(2)}</td><td style="text-align:right">${fmt$(tAmt)}</td><td style="text-align:right">${fmt$(tIva)}</td></tr></tfoot></table></div><div class="alert" style="margin-top:20px"><p>⚠️ <strong>Recordatorio:</strong> El crédito IVA aplica solo con factura tipo A o ticket fiscal. Conservar comprobantes originales.</p></div>`;
  return emailShell(`Crédito Fiscal ${mes} — Flota ML`,header,body);
}

function buildOwnerEmail(groups,globalSummary,analysis){
  const prev=new Date(new Date().getFullYear(),new Date().getMonth()-1,1);
  const mes=formatMonth(prev);
  const sorted=[...groups].sort((a,b)=>(b.summary?.totalAmount||0)-(a.summary?.totalAmount||0));
  const tAmt=sorted.reduce((s,g)=>s+(g.summary?.totalAmount||0),0);
  const medals=['🥇','🥈','🥉'];
  const vcards=sorted.map((g,i)=>{
    const s=g.summary||{};const pct=tAmt>0?Math.round((s.totalAmount||0)/tAmt*100):0;
    const recs=g.records||[];const kr=recs.filter(r=>r.km).sort((a,b)=>new Date(a.date)-new Date(b.date));
    const km=kr.length>=2?kr[kr.length-1].km-kr[0].km:0;
    const eff=km>0&&s.totalLiters>0?(km/s.totalLiters).toFixed(1):'—';
    const cxkm=km>0&&s.totalAmount>0?'$'+(s.totalAmount/km).toFixed(2):'—';
    const av=analysis?.vehicles?.find(v=>v.vehicleName===g.vehicleName);
    return`<div class="vc"><div class="vc-h"><div class="vc-n"><span class="vc-e">${g.vehicleIcon||'🚛'}</span><div><div class="vc-t">${medals[i]||''} ${g.vehicleName||'—'}</div><div class="vc-s">${s.count||0} cargas · ${(s.totalLiters||0).toFixed(1)} L</div></div></div><div style="text-align:right"><div class="vc-a">${fmt$(s.totalAmount)}</div><div class="vc-p">${pct}% del gasto</div></div></div><div class="bar-bg"><div class="bar-f" style="width:${pct}%"></div></div><div class="vc-stats"><div><div class="vc-sv">${km>0?fmtN(km)+' km':'—'}</div><div class="vc-sl">Recorridos</div></div><div><div class="vc-sv">${eff}</div><div class="vc-sl">km/litro</div></div><div><div class="vc-sv">${cxkm}</div><div class="vc-sl">$/km</div></div><div><div class="vc-sv" style="color:#15803d">${fmt$(s.totalIva||0)}</div><div class="vc-sl">IVA créd.</div></div></div>${av?`<div style="margin-top:14px;padding:12px 14px;background:#f8faff;border-radius:10px;border:1px solid #e0e7ff;font-size:.82rem;color:#475569"><strong style="color:#1e40af">🤖 IA:</strong> ${av.advice}</div>`:''}</div>`;
  }).join('');
  const aiSection=analysis?`<div class="divider"></div><p class="sec-title">🤖 Análisis IA</p><div class="ai-box"><div class="trend-row"><span class="trend-icon">${analysis.priceTrend?.direction==='sube'?'📈':analysis.priceTrend?.direction==='baja'?'📉':'➡️'}</span><div><div class="trend-pct">${analysis.priceTrend?.percentChange||0}% vs mes anterior</div><div class="trend-txt">${analysis.priceTrend?.analysis||''}</div></div></div>${analysis.globalAdvice?`<div class="insight g"><strong>💡 Recomendación</strong>${analysis.globalAdvice}</div>`:''}</div>`:'';
  const header=`<h1 class="h-title">📊 Reporte Mensual</h1><p class="h-sub">${mes} &nbsp;·&nbsp; Generado el 1° de cada mes</p>`;
  const body=`<div class="sgrid"><div class="sc"><span class="sv">${globalSummary?.count||0}</span><span class="sl">Cargas</span></div><div class="sc"><span class="sv">${(globalSummary?.totalLiters||0).toFixed(1)} L</span><span class="sl">Litros</span></div><div class="sc"><span class="sv">${fmt$(globalSummary?.totalAmount)}</span><span class="sl">Gasto total</span></div><div class="sc"><span class="sv">$${(globalSummary?.avgPrice||0).toFixed(2)}</span><span class="sl">$/litro prom.</span></div></div><p class="sec-title">🚛 Vehículos</p>${vcards}${aiSection}`;
  return emailShell(`Reporte ${mes} — Flota ML`,header,body);
}

function buildMaintenanceAlertEmail({vehicleName,vehicleIcon,currentKm,nextServiceKm,kmLeft}){
  const urgent=kmLeft<=200;
  const header=`<h1 class="h-title">${urgent?'⚠️ Servicio urgente':'🔧 Servicio programado'}</h1><p class="h-sub">${vehicleIcon} ${vehicleName}</p>`;
  const body=`<div class="v-hero" style="${urgent?'background:linear-gradient(135deg,#fef2f2,#fee2e2);border-color:#fecaca':''}"><span class="v-emoji">${vehicleIcon}</span><div class="v-name">${vehicleName}</div><div class="v-greet">${urgent?'⚠️ Coordinar con el taller urgente':'Mantenimiento próximamente'}</div></div><div class="sgrid"><div class="sc"><span class="sv">${fmtN(currentKm)}</span><span class="sl">KM actuales</span></div><div class="sc"><span class="sv" style="${urgent?'color:#dc2626':''}">${fmtN(kmLeft)}</span><span class="sl">KM restantes</span></div></div><div class="alert ${urgent?'red':''}"><p>${urgent?`⚠️ <strong>${vehicleName}</strong> tiene el servicio muy próximo.`:`✅ <strong>${vehicleName}</strong> se acerca al próximo servicio. Agendar el cambio de aceite y filtros.`}</p></div>`;
  return emailShell(`Servicio ${urgent?'urgente':'próximo'} — ${vehicleName}`,header,body);
}

const CSS=`*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#1a1a2e}.wrap{max-width:680px;margin:0 auto;padding:28px 16px}.card{background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.09)}.header{padding:36px 44px 0;background:#fff}.logo-row{display:flex;align-items:center;gap:14px;margin-bottom:28px}.logo-box{width:50px;height:50px;background:linear-gradient(135deg,#1e40af,#3b82f6);border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0}.logo-name{font-size:1.2rem;font-weight:800;color:#0f172a}.logo-sub{font-size:.65rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.12em;margin-top:2px}.h-title{font-size:1.9rem;font-weight:900;color:#0f172a;letter-spacing:-.03em;line-height:1.15}.h-sub{font-size:.9rem;color:#64748b;margin-top:8px;padding-bottom:32px}.accent-bar{height:3px;background:linear-gradient(90deg,#1e40af,#3b82f6,#93c5fd)}.body{padding:36px 44px}.v-hero{background:linear-gradient(135deg,#eff6ff,#dbeafe);border-radius:16px;padding:28px 24px;text-align:center;margin-bottom:32px;border:1px solid #bfdbfe}.v-emoji{font-size:4rem;display:block;margin-bottom:10px}.v-name{font-size:1.25rem;font-weight:800;color:#1e3a8a;margin-bottom:4px}.v-greet{font-size:.88rem;color:#3b82f6}.sec-title{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:#94a3b8;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #f1f5f9}.row{display:flex;justify-content:space-between;align-items:center;padding:13px 0;border-bottom:1px solid #f8fafc}.row-l{font-size:.88rem;color:#64748b;font-weight:500}.row-v{font-size:.88rem;color:#0f172a;font-weight:700;text-align:right}.row-v.mono{font-family:monospace;font-size:.8rem}.total-box{background:linear-gradient(135deg,#eff6ff,#e0f2fe);border-radius:14px;padding:20px 24px;margin-top:20px;display:flex;justify-content:space-between;align-items:center;border:1px solid #bfdbfe}.total-l{font-size:.95rem;font-weight:700;color:#374151}.total-v{font-size:2rem;font-weight:900;color:#1e40af}.badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.badge{display:inline-flex;align-items:center;gap:5px;padding:6px 16px;border-radius:20px;font-size:.72rem;font-weight:700}.bg{background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0}.bb{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}.sgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:28px}.sc{background:#f8faff;border-radius:14px;padding:20px;text-align:center;border:1px solid #e0e7ff}.sc.g{background:#f0fdf4;border-color:#bbf7d0}.sv{font-size:1.6rem;font-weight:900;color:#1e40af;display:block;line-height:1;margin-bottom:6px}.sc.g .sv{color:#15803d}.sl{font-size:.6rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8}.tbl-wrap{overflow-x:auto;border-radius:12px;border:1px solid #e2e8f0}table{width:100%;border-collapse:collapse;min-width:520px}th{background:#f8fafc;padding:12px 14px;text-align:left;font-size:.6rem;font-weight:800;text-transform:uppercase;color:#94a3b8;border-bottom:2px solid #e2e8f0}td{padding:12px 14px;border-bottom:1px solid #f1f5f9;color:#374151;font-size:.82rem}tfoot td{background:#f0fdf4;font-weight:800;color:#15803d;border-top:2px solid #bbf7d0}.vc{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px;margin-bottom:12px;position:relative}.vc::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,#1e40af,#60a5fa)}.vc-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.vc-n{display:flex;align-items:center;gap:12px}.vc-e{font-size:2.2rem}.vc-t{font-weight:800;font-size:1rem;color:#0f172a}.vc-s{font-size:.75rem;color:#64748b;margin-top:3px}.vc-a{font-size:1.3rem;font-weight:900;color:#1e40af}.vc-p{font-size:.72rem;color:#94a3b8}.bar-bg{background:#e2e8f0;border-radius:4px;height:5px;margin:10px 0}.bar-f{height:100%;border-radius:4px;background:linear-gradient(90deg,#1e40af,#60a5fa)}.vc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center}.vc-sv{font-size:.9rem;font-weight:800;color:#1e40af}.vc-sl{font-size:.58rem;color:#94a3b8;text-transform:uppercase;margin-top:2px}.ai-box{background:linear-gradient(135deg,#eff6ff,#f0fdf4);border:1px solid #bfdbfe;border-radius:16px;padding:24px;margin-top:8px}.trend-row{display:flex;align-items:center;gap:14px;background:#fff;border-radius:10px;padding:14px 18px;margin-bottom:12px;border:1px solid #e0e7ff}.trend-icon{font-size:1.6rem}.trend-pct{font-size:1.15rem;font-weight:900}.trend-txt{font-size:.8rem;color:#64748b;margin-top:3px}.insight{background:#fff;border-left:3px solid #3b82f6;border-radius:0 10px 10px 0;padding:12px 16px;margin-bottom:8px;font-size:.83rem;color:#475569}.insight strong{display:block;color:#0f172a;margin-bottom:3px}.insight.g{border-left-color:#22c55e}.alert{background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:18px 20px}.alert p{color:#92400e;font-size:.84rem;line-height:1.75}.alert.red{background:#fef2f2;border-color:#fecaca}.alert.red p{color:#991b1b}.footer{padding:24px 44px 28px;background:#f8fafc;border-top:1px solid #f1f5f9;text-align:center}.footer p{color:#94a3b8;font-size:.72rem;line-height:2}.divider{height:1px;background:#f1f5f9;margin:24px 0}`;

const emailShell=(title,headerContent,bodyContent)=>`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body><div class="wrap"><div class="card"><div class="header"><div class="logo-row"><div class="logo-box">🚛</div><div><div class="logo-name">Flota ML</div><div class="logo-sub">Control de Flota</div></div></div>${headerContent}</div><div class="accent-bar"></div><div class="body">${bodyContent}</div><div class="footer"><p>🚛 <strong>Flota ML</strong> &nbsp;·&nbsp; Sistema de Control de Flota<br>Generado automáticamente &nbsp;·&nbsp; ${new Date().toLocaleDateString('es-AR',{timeZone:TIMEZONE,day:'2-digit',month:'long',year:'numeric'})}<br>No responder a este mensaje.</p></div></div></div></body></html>`;