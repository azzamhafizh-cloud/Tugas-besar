
function linearRegression(values) {
  const n = values.length;

  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;

  values.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
  });

  const slope = denominator
    ? numerator / denominator
    : 0;

  return {
    slope,
    intercept: meanY - slope * meanX
  };
}

function calculatePrediction(values, minutesPerReading, horizon) {
  const regression = linearRegression(values);
  const futureSteps = horizon / minutesPerReading;
  const predicted = regression.intercept +
    regression.slope * (values.length - 1 + futureSteps);

  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  const residuals = values.map((value, index) => {
    const fitted = regression.intercept +
      regression.slope * index;
    return (value - fitted) ** 2;
  });

  const rmse = Math.sqrt(
    residuals.reduce((a, b) => a + b, 0) / values.length
  );

  return {
    current: values[values.length - 1],
    predicted: Number(predicted.toFixed(2)),
    change: Number((predicted - values[values.length - 1]).toFixed(2)),
    trend: regression.slope > 0.01
      ? "INCREASING"
      : regression.slope < -0.01
        ? "DECREASING"
        : "STABLE",
    rmse: Number(rmse.toFixed(2)),
    baseline: Number(mean.toFixed(2))
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

    // 2. Validasi data
    const validData = data
      .filter(item =>
        Number.isFinite(Number(item.temperature)) &&
        Number.isFinite(Number(item.humidity)) &&
        item.created_at
      )
      .reverse();

    if (validData.length < 10) {
      return res.status(422).json({
        success: false,
        message: "Diperlukan minimal 10 data sensor valid untuk prediksi."
      });
    }

    // 3. Menghitung interval pembacaan aktual
    const timestamps = validData.map(item =>
      new Date(item.created_at).getTime()
    );

    const intervals = [];

    for (let i = 1; i < timestamps.length; i++) {
      const difference = (timestamps[i] - timestamps[i - 1]) / 60000;

      if (difference > 0) {
        intervals.push(difference);
      }
    }

    if (intervals.length < 5) {
      return res.status(422).json({
        success: false,
        message: "Interval data sensor tidak cukup untuk prediksi."
      });
    }

    const minutesPerReading =
      intervals.reduce((a, b) => a + b, 0) / intervals.length;

    // 4. Menyiapkan nilai suhu dan kelembapan
    const temperatures = validData.map(item =>
      Number(item.temperature)
    );

    const humidities = validData.map(item =>
      Number(item.humidity)
    );

    // 5. Prediksi 30 menit ke depan
    const temperaturePrediction = calculatePrediction(
      temperatures,
      minutesPerReading,
      30
    );

    const humidityPrediction = calculatePrediction(
      humidities,
      minutesPerReading,
      30
    );

    // 6. Evaluasi kualitas model
    const sufficientHistory =
      (timestamps[timestamps.length - 1] -
        timestamps[0]) >= 60 * 60 * 1000;

    const prompt = `
Kamu adalah AI Prediction AirWatch.

Jelaskan hasil prediksi suhu dan kelembapan berdasarkan
perhitungan regresi linear berikut.

Prediksi:
${JSON.stringify({
  temperature: temperaturePrediction,
  humidity: humidityPrediction
}, null, 2)}

Durasi riwayat:
${Math.round(
  (timestamps[timestamps.length - 1] -
    timestamps[0]) / 60000
)} menit.

Target prediksi: 30 menit ke depan.

Jelaskan:
1. Perkiraan suhu dan kelembapan.
2. Tren perubahan.
3. Risiko dan rekomendasi.
4. Keterbatasan prediksi.

Jangan mengubah angka hasil perhitungan.
Jangan menganggap prediksi sebagai kepastian.
Jika riwayat terlalu singkat, jelaskan bahwa
hasil prediksi masih bersifat awal.
`;

    // 7. Meminta Gemini menjelaskan prediksi
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

    // 8. Mengirim hasil ke dashboard
    return res.status(200).json({
      success: true,
      feature: "AI Prediction",
      model: "gemini-3.1-flash-lite",
      predictionHorizon: "30 minutes",
      totalData: validData.length,
      historyDurationMinutes: Math.round(
        (timestamps[timestamps.length - 1] -
          timestamps[0]) / 60000
      ),
      sufficientHistory,
      intervalMinutes: Number(minutesPerReading.toFixed(2)),
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
      message: error.message || "Terjadi kesalahan pada sistem prediksi."
    });
  }
}
