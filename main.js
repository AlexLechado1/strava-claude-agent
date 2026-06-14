require("dotenv").config();
const https = require("https");
const http = require("http");
const fs = require("fs");
const { URL } = require("url");

// ─── CONFIGURATION ───────────────────────────────────────────────────────────
const CONFIG = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  refreshToken: process.env.STRAVA_REFRESH_TOKEN,
  accessToken: "",
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  webhookVerifyToken: process.env.STRAVA_WEBHOOK_VERIFY_TOKEN || "strava-claude-agent-2026",
  intervalsApiKey: process.env.INTERVALS_API_KEY,
  intervalsAthleteId: process.env.INTERVALS_ATHLETE_ID || "I268707",
  lastActivityId: null,
  lastWeeklySummaryDate: null,
  lastMorningReadinessDate: null,
  dataFile: "state.json",
  checkInterval: 30 * 60 * 1000,      // 30 min fallback (webhook handles real-time)
  tokenRefreshInterval: 50 * 60 * 1000,
};

const ATHLETE = {
  nombre: "Alex",
  edad: 27,
  objetivo: "70.3 Vitoria sub-5h",
  historial: "Maratón 3h29, 70.3 Mallorca 6h",
  zonasFCMax: 190,
  raceDate: new Date("2026-07-12T08:00:00"),
};

// ─── STATE ───────────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(CONFIG.dataFile)) {
      const s = JSON.parse(fs.readFileSync(CONFIG.dataFile, "utf8"));
      CONFIG.lastActivityId = s.lastActivityId;
      CONFIG.refreshToken = s.refreshToken || CONFIG.refreshToken;
      if (s.accessToken) CONFIG.accessToken = s.accessToken;
      if (s.lastWeeklySummaryDate) CONFIG.lastWeeklySummaryDate = s.lastWeeklySummaryDate;
      console.log("State loaded. Last activity ID:", CONFIG.lastActivityId);
    } else {
      // Cold start: mark today to avoid duplicate weekly summary on restart
      CONFIG.lastWeeklySummaryDate = new Date().toDateString();
      console.log("No prior state, starting fresh.");
    }
  } catch (e) {
    CONFIG.lastWeeklySummaryDate = new Date().toDateString();
    console.log("State load error, starting fresh.");
  }
}

function saveState() {
  fs.writeFileSync(
    CONFIG.dataFile,
    JSON.stringify(
      {
        lastActivityId: CONFIG.lastActivityId,
        refreshToken: CONFIG.refreshToken,
        accessToken: CONFIG.accessToken,
        lastWeeklySummaryDate: CONFIG.lastWeeklySummaryDate,
      },
      null,
      2
    )
  );
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min ${s}s`;
  return `${s}s`;
}

function formatDistance(meters, type) {
  if ((type || "").toLowerCase().includes("swim")) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(2)}km`;
}

function formatPace(metersPerSecond) {
  const secsPerKm = 1000 / metersPerSecond;
  const min = Math.floor(secsPerKm / 60);
  const sec = Math.round(secsPerKm % 60);
  return `${min}'${sec < 10 ? "0" : ""}${sec}"/km`;
}

function formatSwimPace(metersPerSecond) {
  const secsPer100m = 100 / metersPerSecond;
  const min = Math.floor(secsPer100m / 60);
  const sec = Math.round(secsPer100m % 60);
  return `${min}'${sec < 10 ? "0" : ""}${sec}"/100m`;
}

function getHeartZone(avgHR, maxHR) {
  if (!avgHR || !maxHR) return null;
  const pct = (avgHR / maxHR) * 100;
  if (pct < 65) return "Z1 (recovery)";
  if (pct < 80) return "Z2 (aerobic base)";
  if (pct < 89) return "Z3 (tempo)";
  if (pct < 92) return "Z4 (threshold)";
  return "Z5 (VO2max)";
}

function getDaysToRace() {
  return Math.ceil((ATHLETE.raceDate - new Date()) / (1000 * 60 * 60 * 24));
}

function getRaceCountdownStr() {
  const days = getDaysToRace();
  if (days <= 0) return "Race day is here!";
  const weeks = Math.floor(days / 7);
  const remainingDays = days % 7;
  if (weeks > 0) return `${weeks} weeks and ${remainingDays} days to Vitoria`;
  return `${days} days to Vitoria`;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function httpsRequest(opts, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (r) => {
      let data = "";
      r.on("data", (chunk) => (data += chunk));
      r.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
  const body = JSON.stringify({ chat_id: CONFIG.chatId, text: msg, parse_mode: "HTML" });
  const res = await httpsRequest(
    {
      hostname: "api.telegram.org",
      path: "/bot" + CONFIG.telegramToken + "/sendMessage",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );
  if (res.ok) {
    console.log("Telegram: message sent OK");
  } else {
    console.log("Telegram error:", JSON.stringify(res));
  }
}

async function sendErrorAlert(context, errorMsg) {
  try {
    await sendTelegram(
      `🔴 <b>Agent Error</b>\n\n<b>Where:</b> ${context}\n<b>Error:</b> ${errorMsg}\n\n<i>Check Render logs for details.</i>`
    );
  } catch (e) {
    console.log("Could not send error alert:", e.message);
  }
}

// ─── STRAVA ───────────────────────────────────────────────────────────────────
async function refreshAccessToken() {
  if (!CONFIG.refreshToken) {
    console.log("No refresh token, cannot renew.");
    return false;
  }
  console.log("Refreshing access token...");
  const body = JSON.stringify({
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
    refresh_token: CONFIG.refreshToken,
    grant_type: "refresh_token",
  });
  const data = await httpsRequest(
    {
      hostname: "www.strava.com",
      path: "/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );
  if (data.access_token) {
    CONFIG.accessToken = data.access_token;
    CONFIG.refreshToken = data.refresh_token;
    saveState();
    console.log("Token refreshed successfully.");
    return true;
  }
  console.log("Token refresh error:", JSON.stringify(data));
  return false;
}

async function stravaGet(path, retry = true) {
  const data = await httpsRequest({
    hostname: "www.strava.com",
    path,
    headers: { Authorization: "Bearer " + CONFIG.accessToken },
  });
  if (data?.message === "Rate Limit Exceeded") {
    console.log("Strava rate limit hit. Waiting for next cycle...");
    return null;
  }
  if (data?.errors && data?.message === "Authorization Error") {
    if (!retry) {
      console.log("Persistent auth error, check credentials.");
      return null;
    }
    console.log("Token expired, refreshing...");
    const ok = await refreshAccessToken();
    if (ok) return stravaGet(path, false);
  }
  return data;
}

async function getLatestActivity() {
  const data = await stravaGet("/api/v3/athlete/activities?per_page=1");
  if (Array.isArray(data) && data.length > 0) return data[0];
  return null;
}

async function getRecentActivities(days = 7) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const data = await stravaGet(`/api/v3/athlete/activities?per_page=30&after=${since}`);
  if (Array.isArray(data)) return data;
  return [];
}

// ─── INTERVALS.ICU ───────────────────────────────────────────────────────────
async function getIntervalsWellness(date) {
  if (!CONFIG.intervalsApiKey) return null;
  const credentials = Buffer.from(`API_KEY:${CONFIG.intervalsApiKey}`).toString("base64");
  try {
    const data = await httpsRequest({
      hostname: "intervals.icu",
      path: `/api/v1/athlete/${CONFIG.intervalsAthleteId}/wellness/${date}`,
      headers: { Authorization: `Basic ${credentials}` },
    });
    if (data?.error || data?.message) return null;
    return data;
  } catch (e) {
    console.log("Intervals.icu error:", e.message);
    return null;
  }
}

function formatWellnessContext(w) {
  if (!w) return "";
  const parts = [];

  if (w.ctl != null && w.atl != null) {
    const tsb = Math.round(w.ctl - w.atl);
    const form = tsb > 10 ? "muy fresco" : tsb > 0 ? "fresco" : tsb > -10 ? "neutro" : tsb > -25 ? "fatigado" : "muy fatigado";
    parts.push(`Fitness (CTL): ${Math.round(w.ctl)} | Fatiga (ATL): ${Math.round(w.atl)} | Forma (TSB): ${tsb} (${form})`);
  }
  if (w.hrv != null)       parts.push(`HRV rMSSD: ${Math.round(w.hrv)}ms`);
  if (w.rhr != null)       parts.push(`FC reposo: ${w.rhr}bpm`);
  if (w.sleepSecs != null) {
    const h = (w.sleepSecs / 3600).toFixed(1);
    parts.push(`Sueño: ${h}h${w.sleepScore != null ? ` (puntuación ${w.sleepScore})` : ""}`);
  }
  if (w.spO2 != null)      parts.push(`SpO2: ${w.spO2}%`);

  return parts.length
    ? `\nDATO GARMIN VÍA INTERVALS.ICU (hoy):\n${parts.map((p) => `- ${p}`).join("\n")}`
    : "";
}

// ─── CLAUDE ───────────────────────────────────────────────────────────────────
async function claudePost(systemPrompt, userContent, maxTokens = 500) {
  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });
  const data = await httpsRequest(
    {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-api-key": CONFIG.anthropicKey,
        "anthropic-version": "2023-06-01",
      },
    },
    body
  );
  if (data.error) {
    console.log("Claude error:", data.error.message);
    return null;
  }
  return data.content?.[0]?.text || null;
}

const COACH_SYSTEM_PROMPT = `You are an expert triathlon coach specializing in running, cycling, and swimming.
You analyze training data from Strava with precision and give direct, data-driven feedback.
Always reference specific metrics (pace, HR, distance) in your analysis.
Speak directly to the athlete by name. Use emojis. Be concise and actionable.
All responses must be in Spanish.

ATHLETE HEART RATE ZONES (HRmax = 190bpm, confirmed):
- Z1 Recovery: <124bpm (<65%)
- Z2 Aerobic base: 124-152bpm (65-80%) — TARGET: 80% of weekly training time
- Z3 Tempo / 70.3 race pace: 153-169bpm (81-89%)
- Z4 Threshold / marathon pace: 170-175bpm (89-92%)
- Z5 VO2max: >=176bpm (>92%)`;

async function analyzeActivity(act, recentActivities = []) {
  const tipo = act.type || "Unknown";
  const esCarrera = tipo.toLowerCase().includes("run");
  const esNatacion = tipo.toLowerCase().includes("swim");

  const dist = formatDistance(act.distance, tipo);
  const tiempo = formatTime(act.moving_time);
  const avgHR = act.average_heartrate ? Math.round(act.average_heartrate) : null;
  const maxHR = act.max_heartrate ? Math.round(act.max_heartrate) : null;
  const fcStr = avgHR ? `${avgHR}bpm media (max ${maxHR}bpm)` : "sin datos FC";
  const zona = getHeartZone(avgHR, ATHLETE.zonasFCMax);
  const elevacion = act.total_elevation_gain ? `${Math.round(act.total_elevation_gain)}m D+` : "0m D+";

  let ritmoStr = "-";
  if (act.average_speed) {
    if (esCarrera) ritmoStr = formatPace(act.average_speed);
    else if (esNatacion) ritmoStr = formatSwimPace(act.average_speed);
    else ritmoStr = `${(act.average_speed * 3.6).toFixed(1)}km/h`;
  }

  const activityDate = (act.start_date || "").split("T")[0] || new Date().toISOString().split("T")[0];
  const wellness = await getIntervalsWellness(activityDate);
  const wellnessContext = formatWellnessContext(wellness);

  let cargaSemanal = "";
  if (recentActivities.length > 1) {
    const otras = recentActivities.filter((a) => a.id !== act.id);
    const totalKm = otras.reduce((s, a) => s + (a.distance || 0), 0) / 1000;
    const totalMin = otras.reduce((s, a) => s + (a.moving_time || 0), 0) / 60;
    cargaSemanal = `\nWeekly load so far (excl. this session): ${totalKm.toFixed(0)}km in ${Math.round(totalMin)}min (${otras.length} sessions)`;
  }

  const diasParaCarrera = getDaysToRace();
  const fase =
    diasParaCarrera > 60
      ? "base building"
      : diasParaCarrera > 30
      ? "specific build"
      : diasParaCarrera > 14
      ? "peak"
      : "taper";

  const userContent = `Analyze this training session for ${ATHLETE.nombre} (${ATHLETE.edad}yo male).
Goal: ${ATHLETE.objetivo}. Background: ${ATHLETE.historial}.
Current training phase: ${fase} (${diasParaCarrera} days to race).

SESSION DATA:
- Name: ${act.name}
- Type: ${tipo}
- Distance: ${dist}
- Moving time: ${tiempo}
- HR avg/max: ${fcStr}${zona ? ` → ${zona}` : ""}
- Pace/speed: ${ritmoStr}
- Elevation: ${elevacion}${cargaSemanal}${wellnessContext}

Provide a 4-5 sentence analysis:
1. Overall quality and physiological stimulus
2. What the HR data tells you and whether it fits the current phase (${fase})
3. One specific recommendation for improvement toward the 70.3
4. Rating 1-10 with brief justification`;

  return (await claudePost(COACH_SYSTEM_PROMPT, userContent, 500)) || "Analysis unavailable.";
}

// ─── OVERTRAINING DETECTION ────────────────────────────────────────────────────
async function checkOvertraining(activities) {
  if (activities.length < 3) return;

  const sortedDates = activities
    .map((a) => new Date(a.start_date).toDateString())
    .filter((d, i, arr) => arr.indexOf(d) === i)
    .sort();

  let maxStreak = 1, currentStreak = 1;
  for (let i = 1; i < sortedDates.length; i++) {
    const diffDays =
      (new Date(sortedDates[i]) - new Date(sortedDates[i - 1])) / (1000 * 60 * 60 * 24);
    if (diffDays === 1) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 1;
    }
  }

  const totalHoras = activities.reduce((s, a) => s + (a.moving_time || 0), 0) / 3600;
  const alertas = [];
  if (maxStreak >= 5) alertas.push(`${maxStreak} consecutive training days without rest`);
  if (totalHoras > 10) alertas.push(`${totalHoras.toFixed(1)}h load this week (recommended limit ~10h)`);

  const sesionesConFC = activities.filter((a) => a.average_heartrate).slice(0, 3);
  if (sesionesConFC.length >= 3) {
    const fcMediaPromedio = sesionesConFC.reduce((s, a) => s + a.average_heartrate, 0) / sesionesConFC.length;
    const pctFCMax = (fcMediaPromedio / ATHLETE.zonasFCMax) * 100;
    if (pctFCMax > 82)
      alertas.push(
        `Average HR of last 3 sessions in Z3/Z4 (${Math.round(fcMediaPromedio)}bpm, ${Math.round(pctFCMax)}% HRmax)`
      );
  }

  if (alertas.length === 0) return;

  const analisis = await claudePost(
    COACH_SYSTEM_PROMPT,
    `${ATHLETE.nombre} (27yo, goal: ${ATHLETE.objetivo}) shows these potential overtraining signals this week:\n${alertas.map((a) => `- ${a}`).join("\n")}\n\nWrite a 3-4 sentence alert: explain the specific risk, one immediate recommendation, and how it affects the goal.`,
    300
  );

  if (analisis) {
    await sendTelegram(`⚠️ <b>Load Alert — ${ATHLETE.nombre}</b>\n\n${analisis}\n\n<i>${getRaceCountdownStr()}</i>`);
    console.log("Overtraining alert sent.");
  }
}

// ─── WEEKLY SUMMARY ───────────────────────────────────────────────────────────
async function sendWeeklySummary() {
  console.log("Generating weekly summary...");
  const activities = await getRecentActivities(7);
  if (activities.length === 0) {
    await sendTelegram(`No activities this week. ${getRaceCountdownStr()}.`);
    return;
  }

  const porDisciplina = {};
  for (const act of activities) {
    const tipo = act.type || "Other";
    const categoria = tipo.toLowerCase().includes("run")
      ? "Running"
      : tipo.toLowerCase().includes("ride")
      ? "Cycling"
      : tipo.toLowerCase().includes("swim")
      ? "Swimming"
      : tipo;
    if (!porDisciplina[categoria]) porDisciplina[categoria] = { sesiones: 0, km: 0, minutos: 0 };
    porDisciplina[categoria].sesiones++;
    porDisciplina[categoria].km += (act.distance || 0) / 1000;
    porDisciplina[categoria].minutos += (act.moving_time || 0) / 60;
  }

  const totalHoras = activities.reduce((s, a) => s + (a.moving_time || 0), 0) / 3600;
  const totalKm = activities.reduce((s, a) => s + (a.distance || 0), 0) / 1000;

  const prevActivities = await getRecentActivities(14);
  const prevWeek = prevActivities.filter((a) => {
    const daysAgo = (new Date() - new Date(a.start_date)) / (1000 * 60 * 60 * 24);
    return daysAgo >= 7 && daysAgo < 14;
  });
  const prevHoras = prevWeek.reduce((s, a) => s + (a.moving_time || 0), 0) / 3600;
  const tendencia =
    totalHoras > prevHoras * 1.1 ? "↑ +load" : totalHoras < prevHoras * 0.9 ? "↓ -load" : "→ stable";

  const disciplinasStr = Object.entries(porDisciplina)
    .map(
      ([d, v]) =>
        `  • ${d}: ${v.sesiones} session${v.sesiones > 1 ? "s" : ""}, ${v.km.toFixed(1)}km, ${Math.round(v.minutos)}min`
    )
    .join("\n");

  const resumenData = `Week: ${activities.length} sessions | ${totalKm.toFixed(1)}km | ${totalHoras.toFixed(1)}h | ${tendencia}
Previous week: ${prevHoras.toFixed(1)}h

By discipline:
${disciplinasStr}`;

  const analisis = await claudePost(
    COACH_SYSTEM_PROMPT,
    `Generate the weekly summary for ${ATHLETE.nombre} (goal: ${ATHLETE.objetivo}, ${getDaysToRace()} days to race).\n\nWEEK DATA:\n${resumenData}\n\nWrite 4-5 sentences: assess the week globally, balance between disciplines, trend vs prior week, and 1-2 concrete recommendations for next week based on days remaining to race.`,
    500
  );

  const msg = `📊 <b>Weekly Summary — ${ATHLETE.nombre}</b>\n\n${resumenData}\n\n${analisis || ""}\n\n<i>${getRaceCountdownStr()}</i>`;
  await sendTelegram(msg);
  console.log("Weekly summary sent.");

  CONFIG.lastWeeklySummaryDate = new Date().toDateString();
  saveState();
}

// ─── MORNING READINESS ───────────────────────────────────────────────────────
async function sendMorningReadiness() {
  const today = new Date().toISOString().split("T")[0];
  const wellness = await getIntervalsWellness(today);
  if (!wellness) return;

  const wellnessContext = formatWellnessContext(wellness);
  if (!wellnessContext) return;

  const tsb = wellness.ctl != null && wellness.atl != null ? Math.round(wellness.ctl - wellness.atl) : null;
  const diasParaCarrera = getDaysToRace();
  const fase = diasParaCarrera > 60 ? "base building" : diasParaCarrera > 30 ? "specific build" : diasParaCarrera > 14 ? "peak" : "taper";

  const analisis = await claudePost(
    COACH_SYSTEM_PROMPT,
    `Morning readiness check for ${ATHLETE.nombre} (goal: ${ATHLETE.objetivo}, ${diasParaCarrera} days to race, phase: ${fase}).

${wellnessContext.trim()}

Write 2-3 sentences in Spanish: assess today's readiness based on the data (HRV, sleep, TSB), and give one concrete recommendation for today's session (intensity, type, or full rest). Be direct.`,
    250
  );

  if (analisis) {
    await sendTelegram(
      `☀️ <b>Readiness matutino — ${ATHLETE.nombre}</b>\n\n${wellnessContext.trim()}\n\n${analisis}\n\n<i>${getRaceCountdownStr()}</i>`
    );
    CONFIG.lastMorningReadinessDate = new Date().toDateString();
    console.log("Morning readiness sent.");
  }
}

// ─── DAILY SCHEDULER ─────────────────────────────────────────────────────────
async function dailyScheduler() {
  const now = new Date();
  const todayStr = now.toDateString();

  if (now.getDay() === 1 && now.getHours() === 8 && CONFIG.lastWeeklySummaryDate !== todayStr) {
    await sendWeeklySummary();
  }

  if (now.getHours() === 7 && CONFIG.lastMorningReadinessDate !== todayStr) {
    await sendMorningReadiness();
  }
}

// ─── MAIN CHECK ───────────────────────────────────────────────────────────────
async function check() {
  const now = new Date().toLocaleString("es-ES");
  console.log(`[${now}] Checking Strava...`);
  try {
    const act = await getLatestActivity();
    if (!act) {
      console.log("No activities on Strava.");
      return;
    }

    if (String(act.id) === String(CONFIG.lastActivityId)) {
      console.log(`No new activities. Last: "${act.name}"`);
      return;
    }

    // Cold start: seed the current activity without triggering analysis
    if (CONFIG.lastActivityId === null) {
      console.log(`Cold start — seeding last activity: "${act.name}" (ID: ${act.id})`);
      CONFIG.lastActivityId = act.id;
      saveState();
      return;
    }

    console.log(`New activity: "${act.name}" (ID: ${act.id})`);

    const recentActivities = await getRecentActivities(7);
    const analisis = await analyzeActivity(act, recentActivities);

    const dist = formatDistance(act.distance, act.type);
    const tiempo = formatTime(act.moving_time);
    const hrStr = act.average_heartrate ? ` | ${Math.round(act.average_heartrate)}bpm` : "";
    const speedStr =
      act.average_speed && (act.type || "").toLowerCase().includes("run")
        ? ` | ${formatPace(act.average_speed)}`
        : act.average_speed && (act.type || "").toLowerCase().includes("ride")
        ? ` | ${(act.average_speed * 3.6).toFixed(1)}km/h`
        : "";

    const msg = `🏃 <b>New session</b>\n\n<b>${act.name}</b>\n${dist} | ${tiempo}${hrStr}${speedStr}\n\n${analisis}\n\n<i>${getRaceCountdownStr()}</i>`;

    await sendTelegram(msg);

    // Save state AFTER successful Telegram send
    CONFIG.lastActivityId = act.id;
    saveState();

    await checkOvertraining(recentActivities);
  } catch (e) {
    console.log("Error in check():", e.message);
    await sendErrorAlert("check()", e.message);
  }
}

// ─── STRAVA WEBHOOK ───────────────────────────────────────────────────────────
function handleWebhookVerification(req, res) {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const mode = urlObj.searchParams.get("hub.mode");
    const token = urlObj.searchParams.get("hub.verify_token");
    const challenge = urlObj.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === CONFIG.webhookVerifyToken) {
      console.log("Webhook verified by Strava.");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ "hub.challenge": challenge }));
    } else {
      console.log("Webhook verification failed — wrong token.");
      res.writeHead(403);
      res.end("Forbidden");
    }
  } catch (e) {
    res.writeHead(500);
    res.end("Error");
  }
}

function handleWebhookEvent(req, res) {
  // Respond immediately — Strava requires a fast 200
  res.writeHead(200);
  res.end("OK");

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const event = JSON.parse(body);
      console.log("Webhook event received:", JSON.stringify(event));
      if (event.object_type === "activity" && event.aspect_type === "create") {
        console.log("New activity via webhook, triggering check...");
        await check();
      }
    } catch (e) {
      console.log("Webhook parse error:", e.message);
    }
  });
}

async function registerWebhook(req, res) {
  const host = req.headers.host;
  const callbackUrl = `https://${host}/webhook`;
  console.log("Registering webhook with callback:", callbackUrl);

  const body = new URLSearchParams({
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
    callback_url: callbackUrl,
    verify_token: CONFIG.webhookVerifyToken,
  }).toString();

  const data = await httpsRequest(
    {
      hostname: "www.strava.com",
      path: "/api/v3/push_subscriptions",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );

  console.log("Webhook registration response:", JSON.stringify(data));
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
http
  .createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    // Webhook registration must come before the general /webhook check
    if (req.url === "/webhook/subscribe") {
      await registerWebhook(req, res);
    } else if (req.url.startsWith("/webhook")) {
      if (req.method === "GET") {
        handleWebhookVerification(req, res);
      } else if (req.method === "POST") {
        handleWebhookEvent(req, res);
      } else {
        res.writeHead(405);
        res.end("Method Not Allowed");
      }
    } else if (req.url === "/check") {
      await check();
      res.end(JSON.stringify({ status: "check triggered" }));
    } else if (req.url === "/activities") {
      const acts = await stravaGet("/api/v3/athlete/activities?per_page=20");
      res.end(JSON.stringify(acts));
    } else if (req.url === "/week") {
      const acts = await getRecentActivities(7);
      const summary = {
        daysToRace: getDaysToRace(),
        sessions: acts.length,
        totalKm: (acts.reduce((s, a) => s + (a.distance || 0), 0) / 1000).toFixed(1),
        totalHours: (acts.reduce((s, a) => s + (a.moving_time || 0), 0) / 3600).toFixed(1),
        activities: acts.map((a) => ({
          name: a.name,
          type: a.type,
          distance: formatDistance(a.distance, a.type),
          time: formatTime(a.moving_time),
        })),
      };
      res.end(JSON.stringify(summary, null, 2));
    } else if (req.url === "/summary") {
      await sendWeeklySummary();
      res.end(JSON.stringify({ status: "weekly summary sent via Telegram" }));
    } else if (req.url === "/wellness") {
      const today = new Date().toISOString().split("T")[0];
      const wellness = await getIntervalsWellness(today);
      res.end(JSON.stringify(wellness || { error: "No data or connection failed" }, null, 2));
    } else if (req.url === "/health") {
      res.end(
        JSON.stringify({
          status: "ok",
          daysToRace: getDaysToRace(),
          lastActivity: CONFIG.lastActivityId,
          timestamp: new Date().toISOString(),
        })
      );
    } else {
      res.end(
        JSON.stringify({
          status: "ok",
          endpoints: ["/activities", "/week", "/summary", "/health", "/check", "/webhook/subscribe"],
        })
      );
    }
  })
  .listen(process.env.PORT || 3000, () =>
    console.log(`HTTP server on port ${process.env.PORT || 3000}`)
  );

// ─── STARTUP ──────────────────────────────────────────────────────────────────
loadState();
refreshAccessToken().then(() => {
  console.log(`Agent started. ${getRaceCountdownStr()}.`);
  sendTelegram(`🏊 <b>Strava-Claude Agent activated</b>\n\n${getRaceCountdownStr()}. Let's go, ${ATHLETE.nombre}!`);
  check();
  setInterval(check, CONFIG.checkInterval);
  setInterval(refreshAccessToken, CONFIG.tokenRefreshInterval);
  setInterval(dailyScheduler, 60 * 60 * 1000);
});
