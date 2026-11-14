// Google Flood Forecasting (Flood Hub). La API pública requiere una API key de Google Cloud
// con "Flood Forecasting API" habilitada. Si no hay key, devolvemos estado "no configurado"
// y el frontend muestra el enlace a Flood Hub para consulta manual.
let cache = { at: 0, data: null };
const TTL = 30 * 60 * 1000;

export async function getFloodForecast({ lat, lng, apiKey }) {
  if (!apiKey) {
    return { ok: false, configured: false, source: 'Google Flood Forecasting',
      hubUrl: `https://sites.research.google/floods/l/${lat}/${lng}/10`, gauges: [] };
  }
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  try {
    // Medidores (gauges) cercanos en un radio ~50 km.
    const url = `https://floodforecasting.googleapis.com/v1/gauges:searchGaugesByArea?key=${apiKey}`;
    const body = { regionCode: 'EC', pageSize: 20,
      // bounding box aproximado alrededor del centro configurado
      areaBoundingBox: { minLatitude: lat - 0.5, maxLatitude: lat + 0.5, minLongitude: lng - 0.5, maxLongitude: lng + 0.5 } };
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Flood API ${res.status}`);
    const j = await res.json();
    const gauges = (j.gauges || []).map(g => ({
      id: g.gaugeId, river: g.river || g.siteName || 'Río', lat: g.location?.latitude, lng: g.location?.longitude,
      severity: g.severity || 'UNKNOWN',
    }));
    const data = { ok: true, configured: true, source: 'Google Flood Forecasting',
      hubUrl: `https://sites.research.google/floods/l/${lat}/${lng}/10`, gauges };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    return { ok: false, configured: true, error: err.message, source: 'Google Flood Forecasting',
      hubUrl: `https://sites.research.google/floods/l/${lat}/${lng}/10`, gauges: [] };
  }
}
