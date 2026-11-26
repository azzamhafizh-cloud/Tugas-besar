
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
    // 1. Mengambil data sensor dari Supabase
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

    const sensorData = await dbResponse.json();

    if (!sensorData.length) {
      return res.status(404).json({
        success: false,
        message: "Belum ada data sensor."
      });
    }

    // 2. Menyiapkan data untuk AI
    const prompt = `
Kamu adalah AI Monitoring AirWatch, sistem monitoring
lingkungan berbasis IoT.

Analisis data suhu dan kelembapan berikut:

${JSON.stringify(sensorData, null, 2)}

Berikan analisis dalam bahasa Indonesia dengan format:

1. Kondisi lingkungan saat ini.
2. Analisis suhu.
3. Analisis kelembapan.
4. Perubahan data berdasarkan riwayat.
5. Rekomendasi.

Gunakan data yang diberikan saja.
Jangan mengarang nilai sensor.
Jangan menyebut prediksi sebagai fakta.
Jika data tidak cukup, jelaskan keterbatasannya.
`;

    // 3. Mengirim data ke Gemini API
    const aiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
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
            temperature: 0.3,
            maxOutputTokens: 800
          }
        })
      }
    );

    const aiResult = await aiResponse.json();

    if (!aiResponse.ok) {
      console.error("Gemini API error:", aiResult);

      return res.status(502).json({
        success: false,
        message: "Gemini API gagal memproses data.",
        details: aiResult.error?.message || "Unknown error"
      });
    }

    const analysis =
      aiResult.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();

    if (!analysis) {
      throw new Error("Gemini tidak menghasilkan analisis.");
    }

    // 4. Mengirim hasil ke dashboard
    return res.status(200).json({
      success: true,
      feature: "AI Monitoring",
      model: "gemini-2.5-flash",
      totalData: sensorData.length,
      latestData: sensorData[0],
      analysis: analysis,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("AirWatch AI error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Terjadi kesalahan pada server AI."
    });
  }
}
