
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
    // 1. Mengambil data seluruh sensor dari Supabase
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
      throw new Error("Gagal mengambil data sensor dari Supabase.");
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

    // 3. Menyiapkan data seluruh sensor untuk AI
    // Nilai null tetap null, tidak diubah menjadi angka 0.
    const aiSensorData = sensorData.map((item) => ({
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

    // 4. Menyiapkan prompt AI Monitoring
    const prompt = `
Kamu adalah AI Monitoring AirWatch, sistem monitoring lingkungan berbasis IoT.

Kamu menerima data dari sensor:
- DHT22: suhu dan kelembapan.
- PMS5003: PM1.0, PM2.5, dan PM10.
- MQ135: nilai ADC mentah (gas_raw).

DATA SENSOR TERBARU DAN RIWAYAT:

${JSON.stringify(aiSensorData, null, 2)}

PANDUAN MEMBACA DATA:

1. Temperature:
   - Satuan derajat Celsius (°C).

2. Humidity:
   - Satuan persen (%).

3. PM1.0:
   - Konsentrasi partikel berukuran hingga 1,0 mikrometer.
   - Satuan µg/m³.

4. PM2.5:
   - Konsentrasi partikel berukuran hingga 2,5 mikrometer.
   - Satuan µg/m³.

5. PM10:
   - Konsentrasi partikel berukuran hingga 10 mikrometer.
   - Satuan µg/m³.

6. gas_raw:
   - Nilai pembacaan ADC mentah dari MQ135.
   - Bukan nilai PPM.
   - Jangan mengubahnya menjadi PPM tanpa proses kalibrasi yang valid.

ATURAN ANALISIS:

- Analisis seluruh parameter yang memiliki nilai.
- Bandingkan perubahan nilai sensor berdasarkan riwayat data.
- Jelaskan parameter yang mengalami kenaikan atau penurunan.
- Perhatikan hubungan antarparameter jika memang didukung data.
- Jangan menyimpulkan kualitas udara hanya berdasarkan gas_raw.
- Jangan menghitung AQI sendiri dari gas_raw.
- Jangan mengarang batas aman atau ambang bahaya.
- Jangan menganggap nilai null sebagai angka nol.
- Jika parameter bernilai null, jelaskan bahwa data parameter tersebut belum tersedia.
- Jika data hanya berasal dari satu atau sedikit pembacaan, jelaskan keterbatasan analisis.
- Jangan menyimpulkan sensor rusak hanya karena ada jeda data.
- Jangan menyebut prediksi sebagai fakta.

ATURAN WAKTU:

- Semua timestamp sudah dikonversi ke WIB (Asia/Jakarta).
- Gunakan WIB setiap kali menyebutkan waktu.
- Jangan mengubah waktu yang diberikan.
- Jangan menambahkan keterangan UTC.
- Jangan melakukan konversi waktu ulang.

FORMAT JAWABAN:

1. Kondisi lingkungan saat ini.
2. Analisis suhu dan kelembapan.
3. Analisis PM1.0, PM2.5, dan PM10.
4. Analisis pembacaan MQ135.
5. Perubahan kondisi berdasarkan riwayat.
6. Rekomendasi.

GAYA BAHASA:

- Gunakan bahasa Indonesia yang santai, natural, dan mudah dipahami.
- Jelaskan hasil seperti sedang berbicara langsung dengan pengguna.
- Hindari gaya bahasa terlalu formal atau seperti laporan ilmiah.
- Hindari kalimat terlalu panjang.
- Jangan menggunakan Markdown seperti tanda pagar atau tanda bintang.
- Gunakan penomoran biasa jika diperlukan.
- Jangan mengubah angka, waktu, atau fakta dari data sensor.
- Jangan mengarang nilai sensor.
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
            maxOutputTokens: 1200
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

    // 6. Mengirim hasil analisis ke dashboard
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
