/* AirWatch demo data layer.
   Ganti publishSample() dengan adapter API/MQTT/WebSocket saat perangkat tersedia.
   Format payload yang diharapkan:
   { timestamp, aqi, pm25, pm10, temperature, humidity }
*/
const $ = (id) => document.getElementById(id);
const state = { mode: "normal", deviceFault: null, current: null, history: [], alerts: [], lastStatus: null, timer: null };
const LIMITS = { aqi: 100, pm25: 35, pm10: 50, temperature: 35, humidityHigh: 75, humidityLow: 30 };
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const round = (v, d=1) => Number(v.toFixed(d));
const nowTime = () => new Date().toLocaleTimeString("id-ID", {hour:"2-digit",minute:"2-digit",second:"2-digit"});

function makeSample(mode = state.mode) {
  const bad = mode === "bad";
  const base = bad
    ? { aqi: 132, pm25: 68, pm10: 112, temperature: 31.8, humidity: 78 }
    : { aqi: 32, pm25: 8.4, pm10: 18.2, temperature: 27.4, humidity: 61 };
  const jitter = (amount) => (Math.random() - .5) * amount;
  return {
    timestamp: Date.now(),
    aqi: Math.round(clamp(base.aqi + jitter(bad ? 22 : 15), 5, 300)),
    pm25: round(clamp(base.pm25 + jitter(bad ? 18 : 4), 1, 250)),
    pm10: round(clamp(base.pm10 + jitter(bad ? 25 : 8), 2, 400)),
    temperature: round(clamp(base.temperature + jitter(2.2), 15, 50)),
    humidity: Math.round(clamp(base.humidity + jitter(8), 10, 100))
  };
}

function getStatus(data) {
  const bad = data.aqi > LIMITS.aqi || data.pm25 > LIMITS.pm25 || data.pm10 > LIMITS.pm10 ||
    data.temperature > LIMITS.temperature || data.humidity > LIMITS.humidityHigh || data.humidity < LIMITS.humidityLow;
  return bad ? "bad" : "safe";
}
function updateMetric(id, value, max, statusText, level) {
  $(id + "Value").textContent = value;
  const bar = $(id + "Bar");
  bar.style.width = `${clamp((Number(value) / max) * 100, 2, 100)}%`;
  bar.style.background = level === "danger" ? "var(--red)" : level === "warn" ? "var(--yellow)" : "var(--green)";
  const tag = $(id + "Tag");
  tag.textContent = statusText;
  tag.className = `metric-tag ${level === "danger" ? "danger" : level === "warn" ? "warn" : id === "temp" || id === "humidity" ? "neutral" : ""}`;
}
function renderMetrics(d) {
  updateMetric("aqi", d.aqi, 200, d.aqi > 150 ? "Poor" : d.aqi > 100 ? "Moderate" : "Good", d.aqi > 100 ? "danger" : d.aqi > 50 ? "warn" : "safe");
  updateMetric("pm25", d.pm25, 100, d.pm25 > 35 ? "High" : "Low", d.pm25 > 35 ? "danger" : d.pm25 > 15 ? "warn" : "safe");
  updateMetric("pm10", d.pm10, 150, d.pm10 > 50 ? "High" : "Low", d.pm10 > 50 ? "danger" : d.pm10 > 25 ? "warn" : "safe");
  updateMetric("temp", d.temperature, 50, d.temperature > 35 ? "Hot" : "Comfortable", d.temperature > 35 ? "danger" : "safe");
  updateMetric("humidity", d.humidity, 100, d.humidity > 75 || d.humidity < 30 ? "Out of range" : "Normal", d.humidity > 75 || d.humidity < 30 ? "warn" : "safe");
}
function renderStatus(d) {
  const status = getStatus(d), banner = $("statusBanner");
  banner.className = `status-banner ${status}`;
  $("statusSymbol").textContent = status === "safe" ? "✓" : "!";
  $("statusKicker").textContent = status === "safe" ? "AIR QUALITY STATUS" : "AIR QUALITY ALERT";
  $("statusTitle").textContent = status === "safe" ? "BAIK / AMAN" : "PERINGATAN / BURUK";
  $("statusMessage").textContent = status === "safe"
    ? "Kondisi udara terpantau baik. Aktivitas di dalam ruangan dapat berjalan normal."
    : "Kualitas udara melewati ambang pemantauan. Kurangi paparan dan perbaiki sirkulasi udara.";
  $("statusCondition").textContent = status === "safe" ? "NORMAL" : "NEEDS ATTENTION";
  $("lastUpdated").textContent = `Updated ${nowTime()}`;
  $("recommendTitle").textContent = status === "safe" ? "Pertahankan kondisi ruangan" : "Kurangi paparan polutan";
  $("recommendText").textContent = status === "safe"
    ? "Pastikan sirkulasi udara berjalan baik dan lakukan pemantauan secara berkala."
    : "Tutup jendela jika sumber polusi berasal dari luar, nyalakan air purifier/ventilasi yang sesuai, dan gunakan masker saat harus beraktivitas di area berdebu.";
  $("recommendIcon").textContent = status === "safe" ? "✦" : "!";
  if (state.lastStatus !== null && state.lastStatus !== status) {
    addAlert(status, status === "safe" ? "Kualitas udara kembali normal" : "Ambang kualitas udara terlampaui",
      status === "safe" ? "Parameter kembali berada dalam rentang pemantauan." : `AQI ${d.aqi} · PM2.5 ${d.pm25} · PM10 ${d.pm10} µg/m³`);
  }
  state.lastStatus = status;
}
function addAlert(status, title, detail) {
  state.alerts.unshift({status,title,detail,time:nowTime()});
  state.alerts = state.alerts.slice(0, 30);
  renderAlerts();
}
function renderAlerts() {
  $("navAlertCount").textContent = state.alerts.length;
  const list = $("alertList");
  if (!state.alerts.length) {
    list.innerHTML = '<div class="empty-state"><span>✓</span><strong>No alerts yet</strong><small>Perubahan status peringatan akan muncul di sini.</small></div>';
    return;
  }
  list.innerHTML = state.alerts.map(a => `<div class="alert-row ${a.status === "safe" ? "safe-event" : ""}">
    <span class="alert-mark"></span><div class="alert-details"><strong>${escapeHTML(a.title)}</strong><small>${escapeHTML(a.detail)}</small></div><span class="alert-time">${a.time}</span></div>`).join("");
}
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

function drawChart() {
  const canvas = $("trendChart"), rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (!rect.width || !rect.height) return;
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d"); ctx.scale(dpr,dpr);
  const w = rect.width, h = rect.height, pad = {l:30,r:10,t:12,b:24};
  const cw = w-pad.l-pad.r, ch = h-pad.t-pad.b;
  ctx.clearRect(0,0,w,h);
  ctx.font = '9px "DM Sans"'; ctx.fillStyle = "#778493"; ctx.strokeStyle = "#2c3540"; ctx.lineWidth = 1;
  for(let i=0;i<4;i++){const y=pad.t+(ch/3)*i;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();ctx.fillText(String(150-i*50),2,y+3);}
  const values = state.history.slice(-24); if(values.length<2)return;
  const line = (key,color,max) => {
    ctx.beginPath(); values.forEach((v,i)=>{const x=pad.l+(i/(values.length-1))*cw,y=pad.t+ch-(clamp(v[key]/max,0,1)*ch);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
    ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineJoin="round";ctx.lineCap="round";ctx.stroke();
    const last=values[values.length-1],x=w-pad.r,y=pad.t+ch-clamp(last[key]/max,0,1)*ch;
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();
  };
  line("aqi","#a995ff",200); line("pm25","#e9ad69",100);
  ctx.fillStyle="#778493";ctx.fillText("−60s",pad.l,h-5);ctx.fillText("NOW",w-pad.r-22,h-5);
}
function setDeviceFault(type) {
  state.deviceFault = type;
  const isSensor = type === "sensor";
  const isError = Boolean(type);
  const title = !isError ? "Perangkat normal" : isSensor ? "Kegagalan pembacaan sensor" : "Terjadi error pada perangkat";
  const message = !isError ? "Seluruh sensor terbaca dengan baik" : isSensor
    ? "Data sensor tidak terbaca atau tidak valid. Periksa koneksi dan kondisi sensor."
    : "Perangkat tidak merespons dengan baik. Periksa catu daya, koneksi, dan modul utama.";
  ["deviceState", "diagnosticStatus"].forEach(id => $(id).classList.toggle("fault", isError));
  $("deviceStateTitle").textContent = title;
  $("deviceStateText").textContent = message;
  $("diagnosticTitle").textContent = !isError ? "Perangkat berfungsi normal" : title;
  $("diagnosticMessage").textContent = !isError ? "Tidak ditemukan error pada perangkat maupun sensor." : message;
  if (isError) addAlert("device-error", title, message);
  else if (type === null) addAlert("safe", "Perangkat kembali normal", "Pembacaan sensor dan status perangkat telah dipulihkan.");
}

function publishSample(payload) {
  // This is the single entry point for simulated or real device telemetry.
  const required = ["aqi","pm25","pm10","temperature","humidity"];
  if (state.deviceFault) return; // Pertahankan data terakhir saat perangkat/sensor error.
  if (!payload || required.some(k => !Number.isFinite(Number(payload[k])))) {
    setDeviceFault("sensor");
    console.warn("Payload telemetry tidak valid:", payload); return;
  }
  const data = {...payload, timestamp: payload.timestamp || Date.now()};
  state.current = data; state.history.push(data); state.history = state.history.slice(-24);
  renderMetrics(data); renderStatus(data); drawChart();
}
function setMode(mode) {
  state.mode = mode;
  $("normalBtn").classList.toggle("selected", mode === "normal");
  $("badBtn").classList.toggle("selected", mode === "bad");
  publishSample(makeSample(mode));
}
function init() {
  $("dateNow").textContent = new Date().toLocaleDateString("id-ID",{weekday:"short",day:"2-digit",month:"short",year:"numeric"});
  $("normalBtn").addEventListener("click",()=>setMode("normal"));
  $("badBtn").addEventListener("click",()=>setMode("bad"));
  $("sensorErrorBtn").addEventListener("click",()=>setDeviceFault("sensor"));
  $("deviceErrorBtn").addEventListener("click",()=>setDeviceFault("device"));
  $("restoreDeviceBtn").addEventListener("click",()=>{setDeviceFault(null);publishSample(makeSample());});
  $("clearAlerts").addEventListener("click",()=>{state.alerts=[];renderAlerts();});
  window.addEventListener("resize",drawChart);
  publishSample(makeSample("normal"));
  // Update otomatis setiap 5 detik.
  state.timer = window.setInterval(()=>publishSample(makeSample()),5000);
}
document.addEventListener("DOMContentLoaded",init);

/* Contoh integrasi:
   WebSocket:
   const ws = new WebSocket("ws://alamat-device:port");
   ws.onmessage = (event) => publishSample(JSON.parse(event.data));

   REST polling:
   fetch("/api/telemetry").then(r => r.json()).then(publishSample);

   MQTT via mqtt.js (tambahkan library mqtt.js dari CDN):
   client.on("message", (topic, message) => publishSample(JSON.parse(message.toString())));
*/
