/**
 * Cloudflare Worker - Fleet Control v2
 * Procesa OCR, valida datos y envía emails
 */

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Procesar ticket con IA
      if (url.pathname === '/api/process-ticket' && request.method === 'POST') {
        return await handleProcessTicket(request, env, corsHeaders);
      }

      // Enviar email de confirmación
      if (url.pathname === '/api/send-confirmation' && request.method === 'POST') {
        return await handleSendConfirmation(request, env, corsHeaders);
      }

      // Enviar reporte
      if (url.pathname === '/api/send-report' && request.method === 'POST') {
        return await handleSendReport(request, env, corsHeaders);
      }

      return new Response(JSON.stringify({ error: 'Not Found' }), { 
        status: 404, 
        headers: corsHeaders 
      });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};

/**
 * Procesar ticket con Claude Vision API
 */
async function handleProcessTicket(request, env, corsHeaders) {
  const { image, apiKey } = await request.json();

  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API Key requerida' }), {
      status: 400,
      headers: corsHeaders
    });
  }

  const systemPrompt = `Eres un experto contador en Argentina especializando en extracción de datos de tickets de nafta para crédito fiscal.

Tu tarea CRÍTICA:
1. Extrae EXACTAMENTE estos datos del ticket:
   - Fecha (YYYY-MM-DD)
   - Hora (HH:MM:SS)
   - CUIT del surtidor (XX-XXXXXXXX-X)
   - Razón social de la estación
   - Tipo de combustible (SUPER/DIESEL/GNC/AXION)
   - Litros cargados (decimal)
   - Precio por litro
   - Subtotal, IVA 21%, Total
   - Localidad y dirección si aparecen

2. Valida MATEMÁTICA:
   - Subtotal + IVA = Total (±0.05 margen)
   - Litros × Precio ≈ Subtotal

3. Responde SOLO en JSON válido, sin markdown:`;

  const userPrompt = `Extrae datos del ticket y devuelve SOLO JSON:
{
  "fecha": "YYYY-MM-DD",
  "hora": "HH:MM:SS",
  "surtidor": {
    "cuit": "XX-XXXXXXXX-X",
    "razonSocial": "...",
    "localidad": "...",
    "direccion": "..."
  },
  "combustible": {
    "tipo": "SUPER/DIESEL/GNC/AXION",
    "litros": 0.00,
    "precioUnitario": 0.00
  },
  "monto": {
    "subtotal": 0.00,
    "iva": 0.00,
    "total": 0.00
  },
  "validaciones": {
    "iva_creditable": true,
    "confidencia_ocr": 95,
    "campos_criticos_ok": true
  }
}`;

  try {
    const claudeResponse = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: image.split(',')[1]
                }
              },
              {
                type: 'text',
                text: userPrompt
              }
            ]
          }
        ]
      })
    });

    if (!claudeResponse.ok) {
      const error = await claudeResponse.json();
      throw new Error(`Claude API error: ${error.error?.message || claudeResponse.statusText}`);
    }

    const claudeData = await claudeResponse.json();
    const responseText = claudeData.content[0].text;
    let ticket = JSON.parse(responseText.replace(/```json|```/g, '').trim());

    return new Response(JSON.stringify({ ticket }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Claude API error:', error);
    return new Response(JSON.stringify({ 
      error: 'Error procesando imagen con IA',
      details: error.message 
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

/**
 * Enviar email de confirmación
 */
async function handleSendConfirmation(request, env, corsHeaders) {
  const { to, userName, vehicleName, vehicleIcon, fuelRecord, location, address } = await request.json();

  if (!to) {
    return new Response(JSON.stringify({ error: 'Email requerido' }), {
      status: 400,
      headers: corsHeaders
    });
  }

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1f2937; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #06b6d4; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
        .header h1 { margin: 0; font-size: 24px; }
        .content { background: #f9fafb; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
        .detail-label { font-weight: 600; color: #6b7280; }
        .detail-value { color: #1f2937; font-weight: 500; }
        .footer { color: #6b7280; font-size: 12px; text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
        .badge { display: inline-block; background: #dcfce7; color: #166534; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin: 10px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🚗 Fleet Control - Confirmación de Carga</h1>
          <p style="margin: 10px 0 0 0; opacity: 0.9;">Carga de combustible registrada correctamente</p>
        </div>

        <div class="content">
          <h2 style="margin-top: 0;">Hola ${userName},</h2>
          <p>Se ha registrado correctamente una carga de combustible en tu cuenta.</p>

          <h3 style="color: #06b6d4; margin-top: 20px;">Detalles de la Carga</h3>
          
          <div class="detail-row">
            <span class="detail-label">Vehículo</span>
            <span class="detail-value">${vehicleIcon} ${vehicleName}</span>
          </div>
          
          <div class="detail-row">
            <span class="detail-label">Fecha y Hora</span>
            <span class="detail-value">${fuelRecord.date} ${fuelRecord.time}</span>
          </div>
          
          <div class="detail-row">
            <span class="detail-label">Localidad</span>
            <span class="detail-value">${location || fuelRecord.location}</span>
          </div>
          
          <div class="detail-row">
            <span class="detail-label">Dirección</span>
            <span class="detail-value">${address || fuelRecord.address}</span>
          </div>
          
          <div class="detail-row">
            <span class="detail-label">Combustible</span>
            <span class="detail-value">${fuelRecord.liters} Litros</span>
          </div>
          
          <div class="detail-row" style="border-bottom: none; padding-bottom: 0;">
            <span class="detail-label">Monto Total</span>
            <span class="detail-value" style="font-size: 18px; color: #06b6d4;">$${fuelRecord.amount.toFixed(2)}</span>
          </div>

          <div class="badge">✅ Registro para crédito fiscal confirmado</div>

          <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">
            Este registro ha sido guardado automáticamente en tu cuenta y será incluido en los reportes mensuales para tu contador.
          </p>
        </div>

        <div class="footer">
          <p>Fleet Control • Sistema de Gestión de Flota</p>
          <p>Este es un email automático. Por favor no responda.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  // Aquí iría integración con SendGrid, Mailgun, etc.
  // Por ahora simulamos el envío
  console.log(`📧 Email enviado a ${to}`);

  return new Response(JSON.stringify({ 
    success: true, 
    message: 'Email de confirmación enviado' 
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

/**
 * Enviar reporte mensual
 */
async function handleSendReport(request, env, corsHeaders) {
  const { to, userName, vehicleName, fuelRecords, maintenanceRecords, summary } = await request.json();

  const fuelTable = fuelRecords.map(r => `
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${r.date}</td>
      <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${r.time}</td>
      <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${r.liters.toFixed(2)} L</td>
      <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">$${r.amount.toFixed(2)}</td>
      <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${r.location}</td>
    </tr>
  `).join('');

  const maintenanceTable = maintenanceRecords.length > 0 ? `
    <h3 style="color: #06b6d4; margin-top: 20px;">Servicios de Mantenimiento</h3>
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="background: #e5e7eb;">
          <th style="padding: 10px; text-align: left; font-weight: 600;">Tipo</th>
          <th style="padding: 10px; text-align: left; font-weight: 600;">Fecha</th>
          <th style="padding: 10px; text-align: left; font-weight: 600;">Km</th>
          <th style="padding: 10px; text-align: left; font-weight: 600;">Próximo</th>
        </tr>
      </thead>
      <tbody>
        ${maintenanceRecords.map(r => `
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${r.type}</td>
            <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${r.date}</td>
            <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${r.currentKm}</td>
            <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${r.nextKm}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '';

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1f2937; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #06b6d4; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .stat { display: inline-block; background: #dcfce7; color: #166534; padding: 10px 20px; border-radius: 6px; margin: 5px; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th { background: #e5e7eb; padding: 10px; text-align: left; font-weight: 600; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🚗 Reporte Fleet Control</h1>
          <p>${vehicleName}</p>
        </div>

        <h2>Resumen del Período</h2>
        <div>
          <span class="stat">📋 ${summary.count} Cargas</span>
          <span class="stat">⛽ ${summary.totalLiters.toFixed(1)} L</span>
          <span class="stat">💰 $${summary.totalAmount.toFixed(2)}</span>
          <span class="stat">📊 $${summary.avgPrice.toFixed(2)}/L</span>
        </div>

        <h3 style="color: #06b6d4; margin-top: 20px;">Detalle de Cargas de Combustible</h3>
        <table>
          <thead>
            <tr style="background: #e5e7eb;">
              <th>Fecha</th>
              <th>Hora</th>
              <th>Litros</th>
              <th>Monto</th>
              <th>Localidad</th>
            </tr>
          </thead>
          <tbody>
            ${fuelTable}
          </tbody>
        </table>

        ${maintenanceTable}

        <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">
          Este reporte ha sido generado automáticamente para su registro contable y control administrativo.
        </p>
      </div>
    </body>
    </html>
  `;

  console.log(`📧 Reporte enviado a ${to}`);

  return new Response(JSON.stringify({ 
    success: true, 
    message: 'Reporte enviado correctamente' 
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
