
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

    // 2. Mengonversi timestamp UTC menjadi WIB
    const formatWIB = (timestamp) => {
      const date = new Date(timestamp);

      if (Number.isNaN(date.getTime())) {
        return "Waktu tidak valid";
      }

      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }).formatToParts(date);

      const values = {};

      for (const part of parts) {
        if (part.type !== "literal") {
          values[part.type] = part.value;
        }
      }

      return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} WIB`;
    };

    // 3. Menyiapkan data khusus untuk AI
    const aiSensorData = sensorData.map((item) => ({
      id: item.id,
      device_id: item.device_id,
      temperature: item.temperature,
      humidity: item.humidity,
      created_at: formatWIB(item.created_at)
    }));

    // 4. Menyiapkan prompt AI
    const prompt = `
Kamu adalah AI Monitoring AirWatch, sistem monitoring lingkungan berbasis IoT.

Analisis data suhu dan kelembapan berikut:

${JSON.stringify(aiSensorData, null, 2)}

ATURAN WAKTU:
- Semua timestamp yang diberikan sudah dikonversi ke zona waktu WIB (Asia/Jakarta).
- Gunakan WIB setiap kali menyebutkan waktu.
- Jangan mengubah waktu yang diberikan.
- Jangan menambahkan keterangan UTC.
- Jangan melakukan konversi waktu ulang.
- Jika membandingkan dua waktu, gunakan waktu WIB yang tersedia pada data.

Berikan analisis dengan format:

1. Kondisi lingkungan saat ini.
2. Analisis suhu.
3. Analisis kelembapan.
4. Perubahan data berdasarkan riwayat.
5. Rekomendasi.

GAYA BAHASA:
- Gunakan bahasa Indonesia yang santai, natural, dan mudah dipahami.
- Jangan menggunakan gaya bahasa terlalu formal atau seperti laporan ilmiah.
- Jelaskan hasil seperti sedang berbicara langsung dengan pengguna.
- Hindari kalimat terlalu panjang dan istilah teknis yang tidak diperlukan.
- Jangan gunakan Markdown seperti tanda pagar (#) atau tanda bintang (*).
- Gunakan penomoran biasa jika perlu.
- Jangan mengubah angka, waktu, atau fakta dari data sensor.
- Jangan mengarang nilai sensor.
- Jangan menyebut prediksi sebagai fakta.
- Jika data tidak cukup, jelaskan keterbatasannya.
- Jangan menyimpulkan sensor rusak hanya karena ada jeda data.
`;

    // 5. Mengirim data ke Gemini API
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

    // 6. Mengirim hasil ke dashboard
    return res.status(200).json({
      success: true,
      feature: "AI Monitoring",
      model: "gemini-3.1-flash-lite",
      totalData: sensorData.length,
      latestData: sensorData[0],
      latestDataWib: aiSensorData[0],
      analysis: analysis,
      generatedAt: new Date().toISOString(),
      generatedAtWib: formatWIB(new Date().toISOString())
    });

  } catch (error) {
    console.error("AirWatch AI error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Terjadi kesalahan pada server AI."
    });
  }
}
