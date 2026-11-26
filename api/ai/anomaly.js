
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

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

// Null, undefined, dan string kosong tidak boleh dianggap angka 0.
function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
      `${supabaseUrl}/rest/v1/telemetry?select=id,device_id,temperature,humidity,pm1,pm25,pm10,gas_raw,created_at&order=created_at.desc&limit=20`,
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

    const latest = data[0];
    const previous = data.slice(1);

    // 2. Konfigurasi parameter dan ambang perubahan.
    // Nilai ini merupakan ambang deteksi perubahan,
    // bukan batas aman atau standar kualitas udara.
    const sensorConfig = {
      temperature: {
        label: "Suhu",
        unit: "°C",
        madFloor: 2,
        suddenChange: 2.5
      },
      humidity: {
        label: "Kelembapan",
        unit: "%",
        madFloor: 8,
        suddenChange: 10
      },
      pm1: {
        label: "PM1.0",
        unit: "µg/m³",
        madFloor: 10,
        suddenChange: 15
      },
      pm25: {
        label: "PM2.5",
        unit: "µg/m³",
        madFloor: 10,
        suddenChange: 15
      },
      pm10: {
        label: "PM10",
        unit: "µg/m³",
        madFloor: 20,
        suddenChange: 25
      },
      gas_raw: {
        label: "MQ135 ADC",
        unit: "ADC",
        madFloor: 100,
        suddenChange: 300
      }
    };

    const anomalies = [];
    const sensorAnalysis = {};

    // 3. Memeriksa setiap parameter secara terpisah
    for (const [key, config] of Object.entries(sensorConfig)) {
      const currentValue = toNumber(latest[key]);

      // Ambil riwayat valid khusus parameter ini
      const history = previous
        .map(item => toNumber(item[key]))
        .filter(value => value !== null);

      const enoughData = history.length >= 5;

      sensorAnalysis[key] = {
        label: config.label,
        unit: config.unit,
        current: currentValue,
        historyCount: history.length,
        enoughData,
        baseline: null,
        status: currentValue === null
          ? "NO_DATA"
          : enoughData
            ? "NORMAL"
            : "INSUFFICIENT_DATA"
      };

      // Tidak melakukan deteksi jika nilai terbaru tidak tersedia
      if (currentValue === null) {
        continue;
      }

      // 4. Deteksi berdasarkan Median dan MAD
      if (enoughData) {
        const baseline = median(history);

        const mad = median(
          history.map(value => Math.abs(value - baseline))
        );

        const threshold = Math.max(
          3 * 1.4826 * mad,
          config.madFloor
        );

        const deviation = Math.abs(currentValue - baseline);

        sensorAnalysis[key].baseline = baseline;
        sensorAnalysis[key].threshold = threshold;

        if (deviation > threshold) {
          anomalies.push({
            sensor: key,
            label: config.label,
            current: currentValue,
            baseline,
            deviation,
            unit: config.unit,
            type: "STATISTICAL_DEVIATION",
            message: `${config.label} menyimpang dari pola riwayat.`
          });

          sensorAnalysis[key].status = "ANOMALY";
        }
      }

      // 5. Deteksi perubahan mendadak dari data sebelumnya
      if (history.length > 0) {
        const previousValue = history[0];

        const change = Math.abs(
          currentValue - previousValue
        );

        if (change >= config.suddenChange) {
          anomalies.push({
            sensor: key,
            label: config.label,
            current: currentValue,
            previous: previousValue,
            change,
            unit: config.unit,
            type: "SUDDEN_CHANGE",
            message: `Terjadi perubahan mendadak pada ${config.label}.`
          });

          sensorAnalysis[key].status = "ANOMALY";
        }
      }
    }

    // 6. Menentukan status keseluruhan
    const analyzedSensors = Object.values(sensorAnalysis)
      .filter(sensor => sensor.current !== null);

    const enoughSensorData = analyzedSensors.some(
      sensor => sensor.enoughData
    );

    const status = !enoughSensorData
      ? "INSUFFICIENT_DATA"
      : anomalies.length > 0
        ? "ANOMALY"
        : "NORMAL";

    // 7. Mengubah waktu data menjadi WIB
    const latestWib = {
      ...latest,
      created_at: formatWIB(latest.created_at)
    };

    const aiData = data.map(item => ({
      ...item,
      created_at: formatWIB(item.created_at)
    }));

    // 8. Meminta Gemini menjelaskan hasil deteksi
    const prompt = `
Kamu adalah AI Anomaly Detection AirWatch.

Tugasmu menjelaskan hasil pemeriksaan anomali dari seluruh sensor.

DATA TERBARU:
${JSON.stringify(latestWib, null, 2)}

RIWAYAT SENSOR:
${JSON.stringify(aiData, null, 2)}

HASIL PEMERIKSAAN SETIAP SENSOR:
${JSON.stringify(sensorAnalysis, null, 2)}

ANOMALI YANG TERDETEKSI:
${JSON.stringify(anomalies, null, 2)}

STATUS KESELURUHAN:
${status}

PARAMETER SENSOR:
- temperature: suhu dalam °C dari DHT22.
- humidity: kelembapan dalam % dari DHT22.
- pm1: konsentrasi PM1.0 dalam µg/m³ dari PMS5003.
- pm25: konsentrasi PM2.5 dalam µg/m³ dari PMS5003.
- pm10: konsentrasi PM10 dalam µg/m³ dari PMS5003.
- gas_raw: pembacaan ADC mentah MQ135.

ATURAN ANALISIS:
- Jelaskan setiap parameter yang memiliki data.
- Prioritaskan parameter yang terdeteksi mengalami anomali.
- Jelaskan perbedaan nilai terbaru dengan baseline atau pembacaan sebelumnya jika tersedia.
- Jangan menganggap nilai null sebagai angka nol.
- Jangan menyebut gas_raw sebagai PPM.
- Jangan menyimpulkan kualitas udara hanya dari gas_raw.
- Jangan mengarang nilai sensor atau hasil deteksi.
- Ambang deteksi statistik bukan batas aman kualitas udara.
- Jangan menyimpulkan sensor rusak hanya karena terjadi anomali.
- Jika data pembanding kurang dari 5, jelaskan bahwa deteksi statistik belum cukup kuat.
- Jika status INSUFFICIENT_DATA, jelaskan bahwa riwayat belum mencukupi.
- Jangan mengubah hasil deteksi statistik yang sudah diberikan.

ATURAN WAKTU:
- Semua waktu menggunakan WIB (Asia/Jakarta).
- Selalu gunakan WIB ketika menyebutkan waktu.
- Jangan menyebut UTC.
- Jangan mengonversi ulang timestamp.

Jelaskan dengan susunan:
1. Kondisi sensor saat ini.
2. Anomali yang ditemukan.
3. Perubahan nilai sensor.
4. Rekomendasi pemeriksaan.

GAYA BAHASA:
- Gunakan bahasa Indonesia yang santai dan natural.
- Jangan terlalu formal atau seperti laporan ilmiah.
- Gunakan kalimat yang mudah dipahami.
- Hindari kalimat terlalu panjang.
- Jangan gunakan Markdown seperti tanda pagar atau tanda bintang.
- Jangan mengarang informasi yang tidak tersedia.
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
        message: "Gemini gagal menjelaskan hasil deteksi.",
        details: aiResult.error?.message || "Unknown error"
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
      latestDataWib: latestWib,
      sensorAnalysis,
      anomalies,
      explanation: explanation || "Penjelasan AI tidak tersedia.",
      generatedAt: new Date().toISOString(),
      generatedAtWib: formatWIB(new Date().toISOString())
    });

  } catch (error) {
    console.error("Anomaly Detection Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Terjadi kesalahan pada server AI."
    });
  }
}
