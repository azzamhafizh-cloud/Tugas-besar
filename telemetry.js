// Vercel Serverless Function: ESP32 POST, dashboard GET.
// Environment variables required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEVICE_API_TOKEN
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({ error: "Supabase environment variables belum diatur di Vercel." });
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  try {
    if (req.method === "POST") {
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!process.env.DEVICE_API_TOKEN || token !== process.env.DEVICE_API_TOKEN)
        return res.status(401).json({ error: "Token perangkat tidak valid." });
      const b = req.body || {};
      const keys = ["aqi", "pm25", "pm10", "temperature", "humidity"];
      if (keys.some(k => !Number.isFinite(Number(b[k])))) return res.status(400).json({ error: "Payload sensor tidak lengkap atau bukan angka." });
      const row = { device_id: String(b.device_id || "AW-001"), aqi: Number(b.aqi), pm25: Number(b.pm25), pm10: Number(b.pm10), temperature: Number(b.temperature), humidity: Number(b.humidity), gas_raw: b.gas_raw == null ? null : Number(b.gas_raw), created_at: new Date().toISOString() };
      const r = await fetch(`${url}/rest/v1/telemetry`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(row) });
      if (!r.ok) return res.status(502).json({ error: "Gagal menyimpan data ke database.", detail: await r.text() });
      return res.status(201).json({ ok: true, saved: true, device_id: row.device_id, timestamp: row.created_at });
    }
    if (req.method === "GET") {
      const r = await fetch(`${url}/rest/v1/telemetry?select=device_id,aqi,pm25,pm10,temperature,humidity,gas_raw,created_at&order=created_at.desc&limit=1`, { headers });
      if (!r.ok) return res.status(502).json({ error: "Gagal membaca database.", detail: await r.text() });
      const rows = await r.json();
      return res.status(200).json({ data: rows[0] || null });
    }
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) { return res.status(500).json({ error: "Server error", detail: e.message }); }
}
