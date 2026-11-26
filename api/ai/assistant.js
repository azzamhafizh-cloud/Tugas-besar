
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
    // 1. Ambil pertanyaan pengguna
    const { question } = req.body || {};

    if (
      typeof question !== "string" ||
      !question.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Pertanyaan tidak boleh kosong."
      });
    }

    if (question.length > 1000) {
      return res.status(400).json({
        success: false,
        message: "Pertanyaan maksimal 1000 karakter."
      });
    }

    // 2. Ambil 100 data sensor terbaru
    const dbResponse = await fetch(
      `${supabaseUrl}/rest/v1/telemetry?select=id,device_id,temperature,humidity,created_at&order=created_at.desc&limit=100`,
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

    const rawData = await dbResponse.json();

    const validData = rawData
      .filter(item =>
        Number.isFinite(Number(item.temperature)) &&
        Number.isFinite(Number(item.humidity)) &&
        item.created_at &&
        Number.isFinite(new Date(item.created_at).getTime())
      )
      .reverse();

    if (validData.length === 0) {
      return res.status(200).json({
        success: true,
        feature: "AI Assistant",
        status: "NO_SENSOR_DATA",
        answer: "Belum ada data sensor yang tersedia di AirWatch."
      });
    }

    // 3. Ambil data terbaru
    const latest = validData[validData.length - 1];

    const latestTimestamp = new Date(latest.created_at);
    const ageMinutes = Math.max(
      0,
      (Date.now() - latestTimestamp.getTime()) / 60000
    );

    // 4. Hitung ringkasan riwayat
    const temperatures = validData.map(item =>
      Number(item.temperature)
    );

    const humidities = validData.map(item =>
      Number(item.humidity)
    );

    const average = values =>
      Number((
        values.reduce((sum, value) => sum + value, 0) /
        values.length
      ).toFixed(2));

    const summary = {
      totalData: validData.length,
      latest: {
        temperature: Number(latest.temperature),
        humidity: Number(latest.humidity),
        createdAt: latest.created_at,
        ageMinutes: Number(ageMinutes.toFixed(2))
      },
      history: {
        averageTemperature: average(temperatures),
        averageHumidity: average(humidities),
        minimumTemperature: Math.min(...temperatures),
        maximumTemperature: Math.max(...temperatures),
        minimumHumidity: Math.min(...humidities),
        maximumHumidity: Math.max(...humidities),
        firstRecord: validData[0].created_at,
        lastRecord: latest.created_at
      }
    };

    // 5. Kirim pertanyaan dan konteks ke Gemini
    const prompt = `
Kamu adalah AI Assistant AirWatch, asisten untuk
membantu pengguna memahami data monitoring sensor DHT22.

DATA SENSOR AIRWATCH:
${JSON.stringify(summary, null, 2)}

PERTANYAAN PENGGUNA:
${question.trim()}

ATURAN:
1. Jawab dalam bahasa Indonesia yang mudah dipahami.
2. Gunakan data sensor yang diberikan sebagai sumber utama.
3. Jangan mengarang nilai sensor atau data yang tidak tersedia.
4. Bedakan kondisi terkini dan rata-rata historis.
5. Jika data terbaru sudah berumur lebih dari 5 menit,
   jelaskan bahwa data mungkin sudah tidak terkini.
6. Jika ditanya tentang anomali, jelaskan bahwa ringkasan ini
   tidak menjalankan pemeriksaan anomali secara langsung.
7. Jika ditanya prediksi, jelaskan bahwa ringkasan ini
   bukan hasil perhitungan prediksi.
8. Berikan rekomendasi yang relevan jika diperlukan.
9. Jangan mengaku mengendalikan perangkat atau sensor.
10. Jawab secara ringkas tetapi jelas.
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
            temperature: 0.3,
            maxOutputTokens: 800
          }
        })
      }
    );

    const aiResult = await aiResponse.json();

    if (!aiResponse.ok) {
      console.error("Gemini error:", aiResult);

      return res.status(502).json({
        success: false,
        message: "AI Assistant gagal memberikan jawaban.",
        details: aiResult.error?.message
      });
    }

    const answer = aiResult.candidates?.[0]?.content
      ?.parts?.map(part => part.text || "")
      .join("")
      .trim();

    if (!answer) {
      return res.status(502).json({
        success: false,
        message: "AI tidak menghasilkan jawaban."
      });
    }

    // 6. Kirim jawaban ke pengguna
    return res.status(200).json({
      success: true,
      feature: "AI Assistant",
      model: "gemini-3.1-flash-lite",
      status: "ANSWER_AVAILABLE",
      question: question.trim(),
      answer,
      sensorContext: summary,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("AirWatch Assistant Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message ||
        "Terjadi kesalahan pada AI Assistant."
    });
  }
}
