
function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function calculateRegression(points, horizonMinutes) {
  const n = points.length;

  if (n < 2) return null;

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

// Mengubah timestamp menjadi WIB
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
    // 1. Mengambil hingga 500 data sensor terbaru
    const dbResponse = await fetch(
      `${supabaseUrl}/rest/v1/telemetry?select=id,device_id,temperature,humidity,pm1,pm25,pm10,gas_raw,created_at&order=created_at.desc&limit=500`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      }
    );

    if (!dbResponse.ok) {
      const errorText = await dbResponse.text();
      console.error("Supabase error:", errorText);
      throw new Error("Gagal mengambil data Supabase.");
    }

    const data = await dbResponse.json();

    if (!data.length) {
      return res.status(404).json({
        success: false,
        message: "Belum ada data sensor."
      });
    }

    // 2. Memastikan timestamp valid dan mengurutkan data
    const validData = data
      .filter(item =>
        item.created_at &&
        Number.isFinite(new Date(item.created_at).getTime())
      )
      .reverse();

    if (!validData.length) {
      return res.status(200).json({
        success: true,
        feature: "AI Prediction",
        status: "INSUFFICIENT_DATA",
        totalData: 0,
        requiredData: 10,
        predictions: null,
        message: "Belum ada timestamp sensor yang valid.",
        generatedAt: new Date().toISOString(),
        generatedAtWib: formatWIB(new Date().toISOString())
      });
    }

    // 3. Konfigurasi parameter sensor
    const sensorConfig = {
      temperature: {
        label: "Suhu",
        unit: "°C"
      },
      humidity: {
        label: "Kelembapan",
        unit: "%"
      },
      pm1: {
        label: "PM1.0",
        unit: "µg/m³"
      },
      pm25: {
        label: "PM2.5",
        unit: "µg/m³"
      },
      pm10: {
        label: "PM10",
        unit: "µg/m³"
      },
      gas_raw: {
        label: "MQ135 ADC",
        unit: "ADC"
      }
    };

    const requiredData = 10;
    const requiredHistoryMinutes = 60;
    const predictionHorizonMinutes = 30;

    const predictions = {};
    const sensorHistory = {};

    // 4. Menghitung prediksi setiap parameter secara terpisah
    for (const [key, config] of Object.entries(sensorConfig)) {
      const parameterData = validData
        .map(item => ({
          value: toNumber(item[key]),
          timestamp: new Date(item.created_at).getTime()
        }))
        .filter(item =>
          item.value !== null &&
          Number.isFinite(item.timestamp)
        );

      const totalParameterData = parameterData.length;

      if (totalParameterData === 0) {
        sensorHistory[key] = {
          label: config.label,
          unit: config.unit,
          totalData: 0,
          historyDurationMinutes: 0,
          sufficientData: false,
          status: "NO_DATA"
        };
        continue;
      }

      const firstTime = parameterData[0].timestamp;
      const lastTime = parameterData[parameterData.length - 1].timestamp;

      const historyDurationMinutes = (lastTime - firstTime) / 60000;

      const sufficientData =
        totalParameterData >= requiredData &&
        historyDurationMinutes >= requiredHistoryMinutes;

      const latestParameter = parameterData[parameterData.length - 1];

      sensorHistory[key] = {
        label: config.label,
        unit: config.unit,
        totalData: totalParameterData,
        historyDurationMinutes: Number(
          historyDurationMinutes.toFixed(2)
        ),
        sufficientData,
        current: latestParameter.value,
        latestTimestampWib: formatWIB(
          new Date(latestParameter.timestamp).toISOString()
        ),
        status: sufficientData
          ? "READY"
          : "INSUFFICIENT_DATA"
      };

      if (!sufficientData) {
        continue;
      }

      // Titik regresi menggunakan waktu aktual dalam menit
      const points = parameterData.map(item => ({
        x: (item.timestamp - firstTime) / 60000,
        y: item.value
      }));

      const prediction = calculateRegression(
        points,
        predictionHorizonMinutes
      );

      if (!prediction) {
        sensorHistory[key].status = "INSUFFICIENT_DATA";
        continue;
      }

      // Target dihitung 30 menit setelah pembacaan terakhir
      const targetTime = new Date(
        latestParameter.timestamp +
        predictionHorizonMinutes * 60000
      );

      predictions[key] = {
        ...prediction,
        unit: config.unit,
        predictionHorizon: `${predictionHorizonMinutes} minutes`,
        targetAtWib: formatWIB(targetTime.toISOString())
      };
    }

    // 5. Memeriksa apakah ada parameter yang bisa diprediksi
    const availableParameters = Object.keys(predictions);

    if (availableParameters.length === 0) {
      const allDurations = Object.values(sensorHistory)
        .map(item => item.historyDurationMinutes);

      const longestHistory = Math.max(0, ...allDurations);

      return res.status(200).json({
        success: true,
        feature: "AI Prediction",
        model: "gemini-3.1-flash-lite",
        status: "INSUFFICIENT_DATA",
        predictionHorizon: "30 minutes",
        totalData: validData.length,
        requiredData,
        requiredHistoryMinutes,
        historyDurationMinutes: longestHistory,
        sufficientHistory: false,
        sensorHistory,
        predictions: null,
        message:
          "Belum ada parameter sensor yang memiliki minimal 10 data valid dan riwayat 60 menit.",
        generatedAt: new Date().toISOString(),
        generatedAtWib: formatWIB(new Date().toISOString())
      });
    }

    // 6. Informasi data terbaru
    const latest = validData[validData.length - 1];

    const latestDataWib = {
      ...latest,
      created_at: formatWIB(latest.created_at)
    };

    const latestTarget = new Date(
      new Date(latest.created_at).getTime() +
      predictionHorizonMinutes * 60000
    );

    const predictionTargetAtWib = formatWIB(
      latestTarget.toISOString()
    );

    // 7. Menyiapkan riwayat sensor untuk AI
    const historyWib = validData.map(item => ({
      id: item.id,
      device_id: item.device_id,
      temperature: item.temperature,
      humidity: item.humidity,
      pm1: item.pm1,
      pm25: item.pm25,
      pm10: item.pm10,
      gas_raw: item.gas_raw,
      created_at: formatWIB(item.created_at)
    }));

    const availablePredictions = Object.fromEntries(
      Object.entries(predictions).map(([key, value]) => [
        key,
        value
      ])
    );

    // 8. Meminta Gemini menjelaskan hasil prediksi
    const prompt = `
Kamu adalah AI Prediction AirWatch.

Jelaskan hasil prediksi berdasarkan perhitungan Linear Regression
yang sudah dilakukan oleh sistem.

DATA SENSOR TERBARU:
${JSON.stringify(latestDataWib, null, 2)}

RIWAYAT SENSOR:
${JSON.stringify(historyWib, null, 2)}

STATUS DAN KECUKUPAN DATA:
${JSON.stringify(sensorHistory, null, 2)}

HASIL PREDIKSI:
${JSON.stringify(availablePredictions, null, 2)}

PARAMETER SENSOR:
- temperature: suhu DHT22 dalam °C.
- humidity: kelembapan DHT22 dalam %.
- pm1: PM1.0 PMS5003 dalam µg/m³.
- pm25: PM2.5 PMS5003 dalam µg/m³.
- pm10: PM10 PMS5003 dalam µg/m³.
- gas_raw: nilai ADC mentah MQ135, bukan PPM.

ATURAN PREDIKSI:
- Prediksi dilakukan 30 menit setelah pembacaan terakhir masing-masing parameter.
- Gunakan nilai predicted yang diberikan sistem.
- Jangan menghitung ulang hasil regresi.
- Jangan mengubah angka hasil perhitungan.
- Jangan menyebut gas_raw sebagai PPM.
- Jangan mengubah nilai null menjadi nol.
- Jangan membuat prediksi untuk parameter yang belum tersedia.
- Jelaskan parameter yang belum memenuhi syarat data.
- Jangan menyebut prediksi sebagai kepastian.
- RMSE bukan jaminan akurasi masa depan.
- Jangan menyimpulkan kualitas udara hanya dari gas_raw.
- Jangan mengarang batas aman atau ambang bahaya.

ATURAN WAKTU:
- Semua timestamp menggunakan WIB (Asia/Jakarta).
- Selalu gunakan WIB ketika menyebutkan waktu.
- Jangan menyebut UTC.
- Jangan mengonversi ulang timestamp.
- Gunakan targetAtWib dari hasil prediksi masing-masing parameter.

Jelaskan:
1. Perkiraan perubahan suhu dan kelembapan.
2. Perkiraan perubahan PM1.0, PM2.5, dan PM10.
3. Perkiraan perubahan pembacaan MQ135.
4. Tren yang terlihat.
5. Risiko, rekomendasi, dan keterbatasan prediksi.

GAYA BAHASA:
- Gunakan bahasa Indonesia yang santai, natural, dan mudah dipahami.
- Jangan terlalu formal atau seperti laporan ilmiah.
- Jelaskan seperti sedang berbicara langsung dengan pengguna.
- Hindari kalimat terlalu panjang.
- Jangan gunakan Markdown seperti tanda pagar atau tanda bintang.
- Gunakan penomoran biasa jika diperlukan.
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
            maxOutputTokens: 1000
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
        details: aiResult.error?.message || "Unknown error"
      });
    }

    const explanation = aiResult.candidates?.[0]?.content
      ?.parts?.map(part => part.text || "")
      .join("")
      .trim();

    // 9. Menentukan status prediksi keseluruhan
    const allParametersReady = Object.keys(sensorConfig).every(
      key => sensorHistory[key]?.sufficientData
    );

    return res.status(200).json({
      success: true,
      feature: "AI Prediction",
      model: "gemini-3.1-flash-lite",
      status: allParametersReady
        ? "PREDICTION_AVAILABLE"
        : "PARTIAL_PREDICTION",
      predictionHorizon: "30 minutes",
      totalData: validData.length,
      requiredData,
      requiredHistoryMinutes,
      sufficientHistory: allParametersReady,
      availableParameters,
      sensorHistory,
      predictions,
      latestData: latest,
      latestDataWib,
      predictionTargetAtWib,
      explanation: explanation || "Penjelasan AI tidak tersedia.",
      generatedAt: new Date().toISOString(),
      generatedAtWib: formatWIB(new Date().toISOString())
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
