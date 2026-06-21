// eval.js — Quality evaluation for the Strava coaching agent
// Run with: node eval.js

const https = require("https");
require("dotenv").config();

// ─── ATHLETE CONFIG ───────────────────────────────────────────────────────────
const ATHLETE = {
  nombre: "Alex",
  edad: 27,
  objetivo: "70.3 Vitoria sub-5h",
  historial: "Maratón 3h29, 70.3 Mallorca 6h",
  zonasFCMax: 190,
  raceDate: new Date("2026-07-12T08:00:00"),
};

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
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
- Z5 VO2max: >=176bpm (>92%)

ANALYSIS FRAMEWORK — you MUST use these exact labels, one per line, no markdown, no extra text before ESTADO:
ESTADO: Verde | Amarillo | Rojo
LECTURA: (max 2 sentences — session quality + recovery context combined)
TENDENCIA: (max 1 sentence — is the week/block on track?)
ACCIÓN INMEDIATA: (max 1 sentence — one concrete action for next 24-48h)
ACCIÓN A MEDIO PLAZO: (max 1 sentence — one plan adjustment, or "Mantener plan.")

Start your response with ESTADO: and nothing else before it.`;

// ─── HELPERS (from main.js) ───────────────────────────────────────────────────
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

function formatWellnessContext(w) {
  if (!w) return "";
  const parts = [];
  if (w.ctl != null && w.atl != null) {
    const tsb = Math.round(w.ctl - w.atl);
    const form = tsb > 10 ? "muy fresco" : tsb > 0 ? "fresco" : tsb > -10 ? "neutro" : tsb > -25 ? "fatigado" : "muy fatigado";
    parts.push(`Fitness (CTL): ${Math.round(w.ctl)} | Fatiga (ATL): ${Math.round(w.atl)} | Forma (TSB): ${tsb} (${form})`);
  }
  if (w.hrv != null)       parts.push(`HRV rMSSD: ${Math.round(w.hrv)}ms`);
  if (w.restingHR != null) parts.push(`FC reposo: ${w.restingHR}bpm`);
  if (w.sleepSecs != null) {
    const h = (w.sleepSecs / 3600).toFixed(1);
    parts.push(`Sueño: ${h}h${w.sleepScore != null ? ` (puntuación ${w.sleepScore})` : ""}`);
  }
  if (w.spO2 != null) parts.push(`SpO2: ${w.spO2}%`);
  return parts.length
    ? `\nDATO GARMIN VÍA INTERVALS.ICU (hoy):\n${parts.map((p) => `- ${p}`).join("\n")}`
    : "";
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function httpsRequest(opts, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (r) => {
      let data = "";
      r.on("data", (chunk) => (data += chunk));
      r.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── STRAVA ───────────────────────────────────────────────────────────────────
let accessToken = "";

async function refreshAccessToken() {
  const body = JSON.stringify({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: process.env.STRAVA_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const data = await httpsRequest(
    {
      hostname: "www.strava.com",
      path: "/oauth/token",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    body
  );
  if (data.access_token) {
    accessToken = data.access_token;
    return true;
  }
  throw new Error("Strava token refresh failed: " + JSON.stringify(data));
}

async function stravaGet(path) {
  return httpsRequest({
    hostname: "www.strava.com",
    path,
    headers: { Authorization: "Bearer " + accessToken },
  });
}

// ─── STRAVA ZONES ────────────────────────────────────────────────────────────
async function getActivityZones(activityId) {
  try {
    const data = await stravaGet(`/api/v3/activities/${activityId}/zones`);
    const hrZone = Array.isArray(data) ? data.find((z) => z.type === "heartrate") : null;
    if (!hrZone?.distribution_buckets) return null;

    const buckets = hrZone.distribution_buckets;
    const totalSecs = buckets.reduce((s, b) => s + b.time, 0);
    if (totalSecs === 0) return null;

    const zones = buckets.map((b, i) => ({
      zone: `Z${i + 1}`,
      pct: Math.round((b.time / totalSecs) * 100),
      time: formatTime(b.time),
    }));

    return zones.map((z) => `${z.zone}: ${z.pct}% (${z.time})`).join(" | ");
  } catch {
    return null;
  }
}

// ─── TREND (pace:FC ratio vs recent similar sessions) ─────────────────────────
function buildTrendContext(act, recentActivities) {
  const tipo = (act.type || "").toLowerCase();
  const esCarrera = tipo.includes("run");
  const esBici = tipo.includes("ride");
  if (!esCarrera && !esBici) return "";
  if (!act.average_speed || !act.average_heartrate) return "";

  const similares = recentActivities
    .filter(
      (a) =>
        a.id !== act.id &&
        (act.type || "") === (a.type || "") &&
        a.average_speed &&
        a.average_heartrate &&
        a.distance > 3000
    )
    .slice(0, 4);

  if (similares.length < 2) return "";

  // pace:FC ratio — seconds per km per bpm (lower = more efficient)
  const ratio = (a) => (1000 / a.average_speed) / a.average_heartrate;

  const currentRatio = ratio(act);
  const avgPrevRatio = similares.reduce((s, a) => s + ratio(a), 0) / similares.length;
  const diffPct = Math.round(((avgPrevRatio - currentRatio) / avgPrevRatio) * 100);

  const trend = diffPct > 0
    ? `✅ +${diffPct}% más eficiente que la media de las últimas ${similares.length} sesiones similares`
    : diffPct < 0
    ? `⚠️ ${Math.abs(diffPct)}% menos eficiente que la media de las últimas ${similares.length} sesiones similares`
    : `→ Eficiencia igual a la media reciente`;

  const prevPaces = similares.map((a) =>
    esCarrera ? formatPace(a.average_speed) : `${(a.average_speed * 3.6).toFixed(1)}km/h`
  );

  return `\nTENDENCIA AERÓBICA (ratio pace:FC):\n- Sesiones anteriores: ${prevPaces.join(", ")}\n- ${trend}`;
}

// ─── VITORIA POSITIONING ──────────────────────────────────────────────────────
function buildVitoriaContext(act) {
  const tipo = (act.type || "").toLowerCase();
  const esCarrera = tipo.includes("run");
  const esBici = tipo.includes("ride");
  const esNatacion = tipo.includes("swim");
  if (!act.average_speed) return "";

  let line = "";

  if (esCarrera) {
    const paceSecPerKm = 1000 / act.average_speed;
    const targetMin = 5 * 60;   // 5:00/km = 300s
    const targetMax = 5.5 * 60; // 5:30/km = 330s
    const diff = paceSecPerKm - targetMin;
    const diffStr = diff > 0
      ? `${Math.round(diff)}s/km más lento que el pace objetivo mínimo (5:00/km)`
      : `${Math.abs(Math.round(diff))}s/km más rápido que el pace objetivo`;

    let assessment = "";
    if (paceSecPerKm > 6 * 60) assessment = "⚠️ Hay trabajo por hacer — el pace Z2 aún está lejos del objetivo de carrera";
    else if (paceSecPerKm > targetMax) assessment = "🟡 En desarrollo — vas por buen camino con margen por ganar";
    else if (paceSecPerKm > targetMin) assessment = "🟢 Dentro del rango objetivo para el run de Vitoria";
    else assessment = "🟢 Por encima del pace objetivo — foco en resistencia específica";

    line = `\nPOSICIONAMIENTO VS VITORIA (run leg ~5:00–5:30/km objetivo):\n- Pace de hoy: ${formatPace(act.average_speed)} (${diffStr})\n- ${assessment}`;
  } else if (esBici) {
    const kmh = act.average_speed * 3.6;
    const targetKmh = 37; // ~2:26h para 90km
    const diff = (kmh - targetKmh).toFixed(1);
    const assessment = kmh >= 37
      ? "🟢 Por encima de la velocidad objetivo para el segmento de bici"
      : kmh >= 34
      ? "🟡 Ligeramente por debajo — normal si hay desnivel o es entrenamiento Z2"
      : "⚠️ Por debajo del objetivo — revisar potencia y posición";

    line = `\nPOSICIONAMIENTO VS VITORIA (bici 90km, objetivo ~37km/h / 2:26h):\n- Velocidad de hoy: ${kmh.toFixed(1)}km/h (${diff > 0 ? "+" : ""}${diff}km/h vs objetivo)\n- ${assessment}`;
  } else if (esNatacion) {
    const secsPer100m = 100 / act.average_speed;
    const targetSecs = 120; // 2:00/100m → ~38min para 1.9km
    const diff = Math.round(secsPer100m - targetSecs);
    const assessment = secsPer100m <= 120
      ? "🟢 Ritmo compatible con el objetivo de natación (~38-42min)"
      : secsPer100m <= 140
      ? "🟡 Dentro del rango — trabajar en resistencia en agua abierta"
      : "⚠️ Ritmo a mejorar para llegar a T1 en condiciones";

    line = `\nPOSICIONAMIENTO VS VITORIA (natación 1.9km, objetivo ~2:00/100m / 38-42min):\n- Ritmo de hoy: ${formatSwimPace(act.average_speed)} (${diff > 0 ? "+" : ""}${diff}s/100m vs objetivo)\n- ${assessment}`;
  }

  return line;
}

// ─── INTERVALS.ICU ────────────────────────────────────────────────────────────
async function getIntervalsWellness(date) {
  if (!process.env.INTERVALS_API_KEY) return null;
  const credentials = Buffer.from(`API_KEY:${process.env.INTERVALS_API_KEY}`).toString("base64");
  try {
    const data = await httpsRequest({
      hostname: "intervals.icu",
      path: `/api/v1/athlete/${process.env.INTERVALS_ATHLETE_ID || "i268707"}/wellness/${date}`,
      headers: { Authorization: `Basic ${credentials}` },
    });
    if (data?.error || data?.message) return null;
    return data;
  } catch {
    return null;
  }
}

// ─── BUILD USER CONTENT (same logic as analyzeActivity in main.js) ────────────
async function buildUserContent(act, recentActivities = [], wellness = null) {
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
    diasParaCarrera > 60 ? "base building" :
    diasParaCarrera > 30 ? "specific build" :
    diasParaCarrera > 14 ? "peak" : "taper";

  // Detect brick: was there another activity in the 3h before this one?
  const actStart = new Date(act.start_date).getTime();
  const brickPrior = recentActivities.find((a) => {
    if (a.id === act.id) return false;
    const priorStart = new Date(a.start_date).getTime();
    const priorEnd = priorStart + (a.elapsed_time || a.moving_time || 0) * 1000;
    const gapMins = (actStart - priorEnd) / 60000;
    return gapMins >= 0 && gapMins <= 180; // finished within 3h before this session
  });

  let brickContext = "";
  if (brickPrior) {
    const gapMins = Math.round((actStart - (new Date(brickPrior.start_date).getTime() + (brickPrior.elapsed_time || brickPrior.moving_time) * 1000)) / 60000);
    brickContext = `\n⚠️ BRICK SESSION: This run was done ${gapMins} min after completing a ${brickPrior.type} (${formatDistance(brickPrior.distance, brickPrior.type)} in ${formatTime(brickPrior.moving_time)}). Elevated HR and reduced pace are expected and NORMAL — interpret this as a brick, not as a standalone run.`;
  }

  const zones = await getActivityZones(act.id);
  const zonesStr = zones ? `\n- Zone distribution: ${zones}` : "";
  const trendContext = buildTrendContext(act, recentActivities);
  const vitoriaContext = buildVitoriaContext(act);

  return `Analyze this training session for ${ATHLETE.nombre} (${ATHLETE.edad}yo male).
Goal: ${ATHLETE.objetivo}. Background: ${ATHLETE.historial}.
Current training phase: ${fase} (${diasParaCarrera} days to race).

SESSION DATA:
- Name: ${act.name}
- Type: ${tipo}
- Distance: ${dist}
- Moving time: ${tiempo}
- HR avg/max: ${fcStr}${zona ? ` → ${zona}` : ""}
- Pace/speed: ${ritmoStr}
- Elevation: ${elevacion}${zonesStr}${cargaSemanal}${trendContext}${vitoriaContext}${wellnessContext}

IMPORTANT: If wellness data is present, it must SHAPE the entire analysis — not just be mentioned.${brickContext}`;
}

// ─── SCORING CRITERIA ─────────────────────────────────────────────────────────
const CRITERIA = [
  {
    id: "C1",
    description: "Tiene los 5 bloques del diagnóstico",
    check: (output) =>
      ["ESTADO:", "LECTURA:", "TENDENCIA:", "ACCIÓN INMEDIATA:", "ACCIÓN A MEDIO PLAZO:"].every(
        (block) => output.includes(block)
      ),
  },
  {
    id: "C2",
    description: "ESTADO es Verde, Amarillo o Rojo",
    check: (output) => /ESTADO:.*?(Verde|Amarillo|Rojo)/i.test(output),
  },
  {
    id: "C4",
    description: "Menciona HRV o sueño si había datos de wellness",
    check: (output, hasWellness) => {
      if (!hasWellness) return true; // no wellness → criterio no aplica, pasa automático
      return output.toLowerCase().includes("hrv") || output.toLowerCase().includes("sueño");
    },
  },
  {
    id: "C5",
    description: "Conecta recuperación con calidad de sesión",
    check: (output, hasWellness) => {
      if (!hasWellness) return true;
      const lower = output.toLowerCase();
      return (
        (lower.includes("hrv") || lower.includes("sueño")) &&
        (lower.includes("sesión") || lower.includes("esfuerzo") || lower.includes("deriva"))
      );
    },
  },
  {
    id: "C6",
    description: "ACCIÓN INMEDIATA es concreta (>20 palabras)",
    check: (output) => {
      const match = output.match(/ACCIÓN INMEDIATA:([\s\S]*?)(?:ACCIÓN A MEDIO PLAZO:|$)/i);
      if (!match) return false;
      return match[1].trim().split(/\s+/).length > 20;
    },
  },
];

// ─── CLAUDE API ───────────────────────────────────────────────────────────────
function claudePost(systemPrompt, userContent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      },
      (r) => {
        let data = "";
        r.on("data", (chunk) => (data += chunk));
        r.on("end", () => {
          try { resolve(JSON.parse(data).content?.[0]?.text || null); }
          catch { reject(new Error("Failed to parse Claude response")); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── SCORER ──────────────────────────────────────────────────────────────────
function scoreOutput(output, hasWellness) {
  const results = CRITERIA.map((criterion) => ({
    ...criterion,
    passed: criterion.check(output, hasWellness),
  }));
  const passed = results.filter((r) => r.passed).length;
  return { results, score: passed, total: results.length, pct: Math.round((passed / results.length) * 100) };
}

function printResult(act, output, scoring, wellness) {
  console.log("\n" + "═".repeat(60));
  console.log(`📍 ${act.name} (${act.type} · ${new Date(act.start_date).toLocaleDateString("es-ES")})`);
  console.log("═".repeat(60));
  if (wellness) {
    const tsb = wellness.ctl != null && wellness.atl != null ? Math.round(wellness.ctl - wellness.atl) : "?";
    console.log(`   Wellness: HRV ${wellness.hrv ?? "-"}ms | Sueño ${wellness.sleepSecs ? (wellness.sleepSecs/3600).toFixed(1)+"h" : "-"} | TSB ${tsb}`);
  }
  console.log("\n📝 OUTPUT:\n");
  console.log(output);
  console.log("\n📊 SCORING:\n");
  for (const r of scoring.results) {
    console.log(`  ${r.passed ? "✅" : "❌"} [${r.id}] ${r.description}`);
  }
  console.log(`\n  SCORE: ${scoring.score}/${scoring.total} (${scoring.pct}%)`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function runEvals() {
  console.log("🏃 Running Strava Agent Evals against real activities...\n");

  if (!process.env.ANTHROPIC_API_KEY) { console.error("❌ ANTHROPIC_API_KEY not set"); process.exit(1); }
  if (!process.env.STRAVA_CLIENT_ID)  { console.error("❌ STRAVA_CLIENT_ID not set");  process.exit(1); }

  // 1. Get Strava token
  console.log("🔑 Refreshing Strava token...");
  await refreshAccessToken();
  console.log("✅ Token OK\n");

  // 2. Pull last 5 activities
  console.log("📥 Fetching last 5 activities from Strava...");
  const activities = await stravaGet("/api/v3/athlete/activities?per_page=5");
  if (!Array.isArray(activities) || activities.length === 0) {
    console.error("❌ No activities returned from Strava");
    process.exit(1);
  }
  console.log(`✅ Got ${activities.length} activities\n`);

  let totalScore = 0;
  let totalCriteria = 0;

  for (const act of activities) {
    const actDate = (act.start_date || "").split("T")[0];
    const wellness = await getIntervalsWellness(actDate);
    const hasWellness = !!wellness;

    const userContent = await buildUserContent(act, activities, wellness);
    const output = await claudePost(COACH_SYSTEM_PROMPT, userContent);

    if (!output) {
      console.log(`❌ No output for "${act.name}"`);
      continue;
    }

    const scoring = scoreOutput(output, hasWellness);
    printResult(act, output, scoring, wellness);

    totalScore += scoring.score;
    totalCriteria += scoring.total;
  }

  console.log("\n" + "═".repeat(60));
  console.log(`TOTAL: ${totalScore}/${totalCriteria} criteria passed across ${activities.length} real activities`);
  console.log(`AVERAGE: ${Math.round((totalScore / totalCriteria) * 100)}%`);
  console.log("═".repeat(60) + "\n");
}

runEvals().catch(console.error);
