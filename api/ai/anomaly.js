
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Gunakan metode POST."
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!supabaseUrl || !supabaseKey || !geminiKey) {
    return res.status(500).json({
      success: false,
      message: "Environment Variable belum lengkap."
    });
  }

  try {
    // 1. Mengambil 20 data sensor terbaru
    const dbResponse = await fetch(
      `${supabaseUrl}/rest/v1/telemetry?select=id,device_id,temperature,humidity,created_at&order=created_at.desc&limit=20`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      }
    );

    if (!dbResponse.ok) {
      throw new Error("Gagal mengambil data Supabase.");
    }

    const data = await dbResponse.json();

    if (!data.length) {
      return res.status(404).json({
        success: false,
        message: "Belum ada data sensor."
      });
    }

    const latest = data[0];
    const previous = data.slice(1);

    const temperature = Number(latest.temperature);
    const humidity = Number(latest.humidity);

    if (!Number.isFinite(temperature) ||
        !Number.isFinite(humidity)) {
      return res.status(422).json({
        success: false,
        message: "Data sensor terbaru tidak valid."
      });
    }

    // 2. Menyiapkan riwayat valid
    const validData = previous.filter(item =>
      Number.isFinite(Number(item.temperature)) &&
      Number.isFinite(Number(item.humidity))
    );

    const tempValues = validData.map(
      item => Number(item.temperature)
    );

    const humValues = validData.map(
      item => Number(item.humidity)
    );

    const enoughData = validData.length >= 5;
    const anomalies = [];

    // 3. Deteksi berdasarkan median dan MAD
    if (enoughData) {
      const tempMedian = median(tempValues);
      const humMedian = median(humValues);

      const tempMAD = median(
        tempValues.map(v => Math.abs(v - tempMedian))
      );

      const humMAD = median(
        humValues.map(v => Math.abs(v - humMedian))
      );

      const tempThreshold = Math.max(3 * 1.4826 * tempMAD, 2);
      const humThreshold = Math.max(3 * 1.4826 * humMAD, 8);

      if (Math.abs(temperature - tempMedian) > tempThreshold) {
        anomalies.push({
          sensor: "temperature",
          current: temperature,
          baseline: tempMedian,
          message: "Suhu menyimpang dari pola riwayat."
        });
      }

      if (Math.abs(humidity - humMedian) > humThreshold) {
        anomalies.push({
          sensor: "humidity",
          current: humidity,
          baseline: humMedian,
          message: "Kelembapan menyimpang dari pola riwayat."
        });
      }
    }

    // 4. Deteksi lonjakan dari pembacaan sebelumnya
    if (validData.length > 0) {
      const lastPrevious = validData[0];

      const tempChange = Math.abs(
        temperature - Number(lastPrevious.temperature)
      );

      const humChange = Math.abs(
        humidity - Number(lastPrevious.humidity)
      );

      if (tempChange >= 2.5) {
        anomalies.push({
          sensor: "temperature",
          change: tempChange,
          message: "Terjadi perubahan suhu mendadak."
        });
      }

      if (humChange >= 10) {
        anomalies.push({
          sensor: "humidity",
          change: humChange,
          message: "Terjadi perubahan kelembapan mendadak."
        });
      }
    }

    const status = !enoughData
      ? "INSUFFICIENT_DATA"
      : anomalies.length > 0
        ? "ANOMALY"
        : "NORMAL";

    // 5. Meminta Gemini menjelaskan hasil deteksi
    const prompt = `
Kamu adalah AI Anomaly Detection AirWatch.

Jelaskan hasil pemeriksaan sensor berikut dalam bahasa Indonesia.

Data terbaru:
${JSON.stringify(latest)}

Jumlah data pembanding:
${validData.length}

Status deteksi statistik:
${status}

Anomali yang ditemukan:
${JSON.stringify(anomalies)}

Jelaskan:
1. Kondisi sensor.
2. Apakah ada anomali.
3. Penyebab berdasarkan data yang tersedia.
4. Rekomendasi pemeriksaan.

Jangan mengubah hasil deteksi statistik.
Jangan mengarang data.
Jika data tidak cukup, jelaskan keterbatasannya.
`;

    const aiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiKey
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 700
          }
        })
      }
    );

    const aiResult = await aiResponse.json();

    if (!aiResponse.ok) {
      console.error("Gemini error:", aiResult);

      return res.status(502).json({
        success: false,
        message: "Gemini gagal menjelaskan hasil deteksi.",
        details: aiResult.error?.message
      });
    }

    const explanation = aiResult.candidates?.[0]?.content
      ?.parts?.map(part => part.text || "")
      .join("")
      .trim();

    return res.status(200).json({
      success: true,
      feature: "Anomaly Detection",
      model: "gemini-3.1-flash-lite",
      status,
      totalData: data.length,
      latestData: latest,
      anomalies,
      explanation: explanation || "Penjelasan AI tidak tersedia.",
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("Anomaly Detection Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}
