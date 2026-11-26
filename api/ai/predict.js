
function calculateRegression(points, horizonMinutes) {
  const n = points.length;

  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;

  let numerator = 0;
  let denominator = 0;

  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;

  const lastX = points[points.length - 1].x;
  const current = points[points.length - 1].y;
  const predicted = intercept + slope * (lastX + horizonMinutes);

  const squaredErrors = points.map(point => {
    const fitted = intercept + slope * point.x;
    return (point.y - fitted) ** 2;
  });

  const rmse = Math.sqrt(
    squaredErrors.reduce((sum, value) => sum + value, 0) / n
  );

  return {
    current,
    predicted: Number(predicted.toFixed(2)),
    change: Number((predicted - current).toFixed(2)),
    trend: slope > 0.01
      ? "INCREASING"
      : slope < -0.01
        ? "DECREASING"
        : "STABLE",
    slopePerMinute: Number(slope.toFixed(4)),
    rmse: Number(rmse.toFixed(3))
  };
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
    // 1. Ambil hingga 500 data sensor terbaru
    const dbResponse = await fetch(
      `${supabaseUrl}/rest/v1/telemetry?select=id,device_id,temperature,humidity,created_at&order=created_at.desc&limit=500`,
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

    // 2. Validasi data sensor dan timestamp
    const validData = data
      .filter(item =>
        Number.isFinite(Number(item.temperature)) &&
        Number.isFinite(Number(item.humidity)) &&
        item.created_at &&
        Number.isFinite(new Date(item.created_at).getTime())
      )
      .reverse();

    if (validData.length < 10) {
      return res.status(200).json({
        success: true,
        feature: "AI Prediction",
        status: "INSUFFICIENT_DATA",
        totalData: validData.length,
        requiredData: 10,
        message: "Minimal 10 data sensor valid diperlukan.",
        predictions: null,
        generatedAt: new Date().toISOString()
      });
    }

    // 3. Hitung durasi riwayat berdasarkan timestamp aktual
    const firstTime = new Date(validData[0].created_at).getTime();
    const lastTime = new Date(
      validData[validData.length - 1].created_at
    ).getTime();

    const historyDurationMinutes = (lastTime - firstTime) / 60000;

    const sufficientHistory = historyDurationMinutes >= 60;

    // 4. Jika riwayat kurang dari 60 menit, jangan membuat prediksi
    if (!sufficientHistory) {
      return res.status(200).json({
        success: true,
        feature: "AI Prediction",
        model: "gemini-3.1-flash-lite",
        status: "INSUFFICIENT_DATA",
        predictionHorizon: "30 minutes",
        totalData: validData.length,
        historyDurationMinutes: Number(
          historyDurationMinutes.toFixed(2)
        ),
        requiredHistoryMinutes: 60,
        sufficientHistory: false,
        predictions: null,
        latestData: validData[validData.length - 1],
        explanation:
          "Riwayat sensor belum mencapai 60 menit. " +
          "Sistem menunggu data tambahan agar prediksi lebih layak dihitung.",
        generatedAt: new Date().toISOString()
      });
    }

    // 5. Buat titik regresi berdasarkan waktu aktual dalam menit
    const temperaturePoints = validData.map(item => ({
      x: (new Date(item.created_at).getTime() - firstTime) / 60000,
      y: Number(item.temperature)
    }));

    const humidityPoints = validData.map(item => ({
      x: (new Date(item.created_at).getTime() - firstTime) / 60000,
      y: Number(item.humidity)
    }));

    // 6. Hitung prediksi 30 menit ke depan
    const temperaturePrediction = calculateRegression(
      temperaturePoints,
      30
    );

    const humidityPrediction = calculateRegression(
      humidityPoints,
      30
    );

    // 7. Minta Gemini menjelaskan hasil perhitungan
    const prompt = `
Kamu adalah AI Prediction AirWatch.

Jelaskan hasil prediksi berdasarkan regresi linear
yang sudah dihitung oleh sistem.

Data prediksi:
${JSON.stringify({
  temperature: temperaturePrediction,
  humidity: humidityPrediction
}, null, 2)}

Durasi riwayat: ${historyDurationMinutes.toFixed(2)} menit.
Jumlah data: ${validData.length}.
Target prediksi: 30 menit ke depan.

Berikan penjelasan dalam bahasa Indonesia:
1. Perkiraan suhu dan kelembapan.
2. Tren perubahan.
3. Risiko dan rekomendasi.
4. Keterbatasan prediksi.

Jangan mengubah angka hasil perhitungan.
Jangan menyebut RMSE sebagai jaminan akurasi masa depan.
Jangan menganggap prediksi sebagai kepastian.
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
        message: "Gemini gagal menjelaskan hasil prediksi.",
        details: aiResult.error?.message
      });
    }

    const explanation = aiResult.candidates?.[0]?.content
      ?.parts?.map(part => part.text || "")
      .join("")
      .trim();

    // 8. Kirim hasil prediksi
    return res.status(200).json({
      success: true,
      feature: "AI Prediction",
      model: "gemini-3.1-flash-lite",
      status: "PREDICTION_AVAILABLE",
      predictionHorizon: "30 minutes",
      totalData: validData.length,
      historyDurationMinutes: Number(
        historyDurationMinutes.toFixed(2)
      ),
      requiredHistoryMinutes: 60,
      sufficientHistory: true,
      predictions: {
        temperature: temperaturePrediction,
        humidity: humidityPrediction
      },
      latestData: validData[validData.length - 1],
      explanation: explanation || "Penjelasan AI tidak tersedia.",
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("AirWatch Prediction Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message ||
        "Terjadi kesalahan pada sistem prediksi."
    });
  }
}
