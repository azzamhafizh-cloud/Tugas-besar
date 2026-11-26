
function formatWIB(timestamp) {
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
}

// Mengirim permintaan ke Gemini dengan percobaan ulang
async function callGemini(geminiKey, prompt) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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
              maxOutputTokens: 1000
            }
          }),
          signal: AbortSignal.timeout(30000)
        }
      );

      const responseText = await aiResponse.text();

      let result;

      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error("Respons Gemini tidak dapat dibaca.");
      }

      if (!aiResponse.ok) {
        const errorMessage =
          result.error?.message ||
          `Gemini mengembalikan HTTP ${aiResponse.status}.`;

        const error = new Error(errorMessage);
        error.status = aiResponse.status;

        const retryable = [429, 500, 502, 503, 504];

        if (
          retryable.includes(aiResponse.status) &&
          attempt < maxAttempts
        ) {
          lastError = error;
          await new Promise(resolve =>
            setTimeout(resolve, attempt * 1500)
          );
          continue;
        }

        throw error;
      }

      const candidate = result.candidates?.[0];

      const answer = candidate?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();

      if (answer) {
        return answer;
      }

      const finishReason = candidate?.finishReason;

      if (finishReason === "SAFETY") {
        throw new Error(
          "Permintaan tidak dapat dijawab karena terhalang filter keamanan AI."
        );
      }

      if (finishReason === "MAX_TOKENS") {
        throw new Error(
          "Jawaban AI terpotong karena mencapai batas token."
        );
      }

      throw new Error(
        `Gemini tidak menghasilkan jawaban. Status: ${finishReason || "Tidak diketahui"}.`
      );

    } catch (error) {
      lastError = error;

      const retryableStatus = [429, 500, 502, 503, 504];

      const shouldRetry =
        !error.status ||
        retryableStatus.includes(error.status);

      if (!shouldRetry || attempt >= maxAttempts) {
        break;
      }

      await new Promise(resolve =>
        setTimeout(resolve, attempt * 1500)
      );
    }
  }

  throw lastError || new Error("Gemini gagal memberikan jawaban.");
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
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!dbResponse.ok) {
      console.error(
        "Supabase error:",
        dbResponse.status,
        await dbResponse.text()
      );

      return res.status(502).json({
        success: false,
        message: "Gagal mengambil data sensor dari Supabase."
      });
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

    // 4. Menghitung ringkasan riwayat
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
        createdAt: formatWIB(latest.created_at),
        ageMinutes: Number(ageMinutes.toFixed(2))
      },
      history: {
        averageTemperature: average(temperatures),
        averageHumidity: average(humidities),
        minimumTemperature: Math.min(...temperatures),
        maximumTemperature: Math.max(...temperatures),
        minimumHumidity: Math.min(...humidities),
        maximumHumidity: Math.max(...humidities),
        firstRecord: formatWIB(validData[0].created_at),
        lastRecord: formatWIB(latest.created_at)
      }
    };

    // 5. Menyiapkan prompt AI
    const prompt = `
Kamu adalah AI Assistant AirWatch, asisten untuk membantu
pengguna memahami data monitoring sensor DHT22.

DATA SENSOR AIRWATCH:
${JSON.stringify(summary, null, 2)}

PERTANYAAN PENGGUNA:
${question.trim()}

ATURAN WAKTU:
- Semua waktu pada data menggunakan WIB (Asia/Jakarta).
- Selalu gunakan WIB ketika menyebutkan waktu.
- Jangan menyebut UTC.
- Jangan mengubah atau mengonversi ulang timestamp.

ATURAN MENJAWAB:
1. Jawab dalam bahasa Indonesia yang natural dan mudah dipahami.
2. Gunakan data sensor yang diberikan sebagai sumber utama.
3. Jangan mengarang nilai sensor atau informasi yang tidak tersedia.
4. Bedakan kondisi terkini dan rata-rata historis.
5. Jika data terbaru berumur lebih dari 5 menit, jelaskan bahwa data mungkin tidak terkini.
6. Jika ditanya tentang anomali, jelaskan bahwa ringkasan ini tidak menjalankan pemeriksaan anomali secara langsung.
7. Jika ditanya prediksi, jelaskan bahwa ringkasan ini bukan hasil perhitungan prediksi.
8. Berikan rekomendasi yang relevan jika diperlukan.
9. Jangan mengaku mengendalikan perangkat atau sensor.
10. Jawab secara ringkas tetapi jelas.
11. Jika pertanyaan tidak berkaitan langsung dengan sensor, tetap jawab dengan sopan jika masih relevan dengan AirWatch.
12. Jika informasi tidak tersedia, katakan dengan jujur.

GAYA BAHASA:
- Gunakan bahasa seperti sedang berbicara langsung dengan pengguna.
- Jangan terlalu formal atau seperti laporan ilmiah.
- Hindari kalimat yang terlalu panjang.
- Jangan gunakan Markdown seperti tanda pagar (#) atau tanda bintang (*).
- Gunakan penomoran biasa jika diperlukan.
`;

    // 6. Mengirim pertanyaan ke Gemini
    let answer;

    try {
      answer = await callGemini(geminiKey, prompt);
    } catch (error) {
      console.error("Gemini Assistant Error:", error);

      return res.status(502).json({
        success: false,
        feature: "AI Assistant",
        message: "AI Assistant sedang mengalami gangguan dan belum bisa menjawab.",
        details: error.message,
        suggestion: "Coba kirim pertanyaan kembali beberapa saat lagi."
      });
    }

    // 7. Mengirim jawaban ke pengguna
    return res.status(200).json({
      success: true,
      feature: "AI Assistant",
      model: "gemini-3.1-flash-lite",
      status: "ANSWER_AVAILABLE",
      question: question.trim(),
      answer,
      sensorContext: summary,
      generatedAt: new Date().toISOString(),
      generatedAtWib: formatWIB(new Date().toISOString())
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
