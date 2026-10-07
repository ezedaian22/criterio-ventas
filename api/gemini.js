// ═══ Criterio Ventas · api/gemini.js ═══
// La API key vive en las variables de entorno de Vercel y NUNCA llega al navegador.
// Asi Google no la marca como expuesta: la key que estaba escrita en el index.html
// la deshabilito por eso mismo ("Your API key was reported as leaked").
//
// Se escribe en CommonJS a proposito: este repo no tiene package.json, asi que
// Vercel trata los .js de /api como CommonJS. Con `export default` no arrancaria.

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Modelos a probar, en orden. Los de respaldo van al final: cada modelo tiene su
// propia cuota, asi que cuando el primero se queda sin nafta el segundo suele andar.
const RESPALDOS = ["gemini-3.6-flash", "gemini-flash-latest"];

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Solo POST" });

  const { base64, prompt, mimeType } = req.body || {};
  if (!base64 || !prompt) return res.status(400).json({ error: "Faltan la foto o el prompt" });

  // Varias keys: UNA POR LINEA. No se separan por coma porque las keys del formato
  // AQ. tienen comas adentro: partirlas por coma las rompe y Google las rechaza
  // aunque sean validas.
  const keys = (process.env.GEMINI_API_KEYS || "")
    .split(/[\r\n]+/).map((k) => k.trim()).filter(Boolean);

  if (keys.length === 0) {
    return res.status(500).json({ error: "No hay ninguna GEMINI_API_KEYS configurada en Vercel" });
  }

  const configurados = (process.env.GEMINI_MODELOS || "")
    .split(",").map((m) => m.trim()).filter(Boolean);
  const modelos = [...new Set([...configurados, ...RESPALDOS])];

  let ultimoError = "sin detalle";
  const porKey = {};

  async function intentar(modelo, apiKey) {
    // Hay DOS formatos de key y cada uno viaja distinto:
    //   AIza... -> como parametro ?key= en la URL (las de AI Studio son asi)
    //   AQ....  -> en el header x-goog-api-key
    // Mandarla por la via equivocada da 400/401 aunque la key sea perfecta.
    const esAIza = /^AIza/i.test(apiKey);
    const base = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;
    const url = esAIza ? `${base}?key=${encodeURIComponent(apiKey)}` : base;
    const cabeceras = { "Content-Type": "application/json" };
    if (!esAIza) cabeceras["x-goog-api-key"] = apiKey;

    const resp = await fetch(url, {
      method: "POST",
      headers: cabeceras,
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mimeType || "image/jpeg", data: base64 } },
          { text: prompt },
        ] }],
        generationConfig: { temperature: 0.1 },
      }),
    });

    let data;
    try { data = await resp.json(); }
    catch { return { fallo: `HTTP ${resp.status} (respuesta ilegible)`, saturado: resp.status >= 500 }; }

    const codigo = (data && data.error && data.error.code) || resp.status;
    const mensaje = data && data.error && data.error.message ? ` — ${data.error.message}` : "";

    // El 429 son DOS cosas distintas y no se resuelven igual:
    //   · por minuto -> se repone en segundos, conviene esperar y reintentar.
    //     Pasa al leer varias fotos seguidas, que es lo normal al cargar un lote.
    //   · por dia    -> no se repone hasta mañana: hay que cambiar de key.
    if (codigo === 429) {
      const texto = JSON.stringify((data && data.error) || "");
      const porMinuto = /per ?minute|PerMinute|RequestsPerMinute/i.test(texto);
      return porMinuto
        ? { fallo: "límite por minuto", saturado: true }
        : { fallo: "cuota diaria agotada", sinCuota: true };
    }

    // 500/503 = el modelo esta saturado. La key no tiene nada que ver.
    if (!resp.ok || (data && data.error)) {
      return { fallo: `HTTP ${codigo}${mensaje}`, saturado: codigo >= 500 };
    }

    const texto = ((data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts) || []).map((p) => p.text || "").join("");

    if (!texto.trim()) return { fallo: "Gemini respondió vacío", saturado: false };
    return { texto };
  }

  // Cambiar de key es la salida rapida: cada una es un cupo distinto y la respuesta
  // es inmediata. Reintentar sobre la misma multiplica el tiempo por la cantidad de
  // keys. Por eso: una vuelta rapida por todas, y solo si todas fallaron por algo
  // temporal, una segunda vuelta tras una pausa corta. Con limite de tiempo.
  const limite = Date.now() + 45000;

  for (let vuelta = 0; vuelta < 2; vuelta++) {
    if (vuelta > 0) {
      const temporales = Object.values(porKey).some((f) => /límite por minuto|HTTP 5/.test(f));
      if (!temporales || Date.now() > limite) break;
      await esperar(2500);
    }
    for (const modelo of modelos) {
      for (let i = 0; i < keys.length; i++) {
        if (Date.now() > limite) break;
        try {
          const r = await intentar(modelo, keys[i]);
          if (r.texto) {
            return res.status(200).json({
              ok: true, texto: r.texto, keyUsada: i + 1, deCuantas: keys.length, modelo,
            });
          }
          ultimoError = `${r.fallo} (${modelo}, key ${i + 1})`;
          porKey[`key${i + 1}`] = r.fallo;
        } catch (err) {
          ultimoError = err.message || String(err);
          porKey[`key${i + 1}`] = `no se pudo enviar: ${ultimoError}`;
        }
      }
    }
  }

  const fallos = Object.values(porKey);

  // El limite por minuto se repone solo: decir que espere, no que cargue a mano.
  if (fallos.length > 0 && fallos.every((f) => /límite por minuto/.test(f))) {
    return res.status(502).json({
      error: 'El lector está ocupado en este momento. Esperá unos segundos y tocá "Reintentar".',
      detalle: ultimoError, porKey, reintentable: true,
    });
  }
  if (fallos.length > 0 && fallos.every((f) => /cuota/.test(f))) {
    return res.status(502).json({
      error: "Se agotó la cuota diaria de lectura. Agregá otra key o seguí mañana.",
      detalle: ultimoError, porKey, sinCuota: true,
    });
  }
  return res.status(502).json({
    error: `No se pudo leer. ${ultimoError}`, porKey, keysConfiguradas: keys.length,
  });
};
