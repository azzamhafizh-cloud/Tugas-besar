# AirWatch — IoT Air Quality Dashboard

Dashboard monitoring kualitas udara dengan tampilan dark mode. Project menggunakan HTML, CSS, dan JavaScript murni tanpa framework.

## Fitur
- Monitoring AQI, PM2.5, PM10, suhu, dan kelembapan.
- Grafik tren data yang diperbarui otomatis setiap 5 detik.
- Simulasi kondisi udara normal dan buruk.
- **Device diagnostics** untuk menampilkan kondisi perangkat, termasuk kegagalan pembacaan sensor dan error perangkat.
- Tombol simulasi error sensor, error perangkat, dan pemulihan perangkat.
- Riwayat peringatan dan rekomendasi tindakan.
- Tidak menampilkan informasi lokasi.

## Menjalankan di VS Code
1. Ekstrak file ZIP.
2. Buka folder `airwatch-iot-dashboard` di Visual Studio Code.
3. Buka `index.html` menggunakan ekstensi Live Server, atau buka langsung di browser.

## Struktur folder
```text
airwatch-iot-dashboard/
├── index.html
├── css/
│   └── style.css
├── js/
│   └── app.js
└── README.md
```

## Integrasi perangkat IoT
Saat ini data masih berupa simulasi lokal dan belum terhubung ke sensor fisik. Fungsi `publishSample(payload)` di `js/app.js` menjadi titik masuk data dari API, WebSocket, atau MQTT. Format payload:

```js
{
  timestamp: Date.now(),
  aqi: 32,
  pm25: 8.4,
  pm10: 18.2,
  temperature: 27.4,
  humidity: 61
}
```

Jika payload tidak valid, dashboard menampilkan status kegagalan pembacaan sensor. Untuk integrasi nyata, status koneksi perangkat dan sensor sebaiknya dikirim eksplisit dari firmware agar dashboard dapat membedakan sensor rusak, data timeout, dan perangkat terputus.

**Catatan:** ambang batas kualitas udara pada project ini hanya untuk demonstrasi dan bukan standar resmi.
