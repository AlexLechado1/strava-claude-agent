# Strava Claude Agent

An autonomous AI coaching agent that monitors your Strava training, analyzes each session using Claude (Anthropic), and delivers personalized feedback via Telegram — including overtraining alerts and weekly summaries.

Built to prepare for the 70.3 Vitoria triathlon (July 2026).

---

## What it does

- **Per-session analysis**: Detects new Strava activities every 15 minutes, sends them to Claude with context about training phase, HR zones, and weekly load, and delivers a structured coaching message via Telegram
- **Overtraining detection**: Flags consecutive training days (≥5), excessive weekly load (>10h), and sustained high HR across recent sessions
- **Weekly summary**: Every Monday at 8am — discipline breakdown, load trend vs prior week, and forward-looking recommendations
- **HTTP API**: Local endpoints to query activities, weekly stats, and trigger summaries on demand

## Why I built it

I'm an endurance athlete (Half Ironman and marathon finisher) training toward a sub-5h 70.3. I wanted a system that gives me the kind of coaching feedback a real coach would give — data-driven, phase-aware, not generic — delivered automatically after every session.

This also let me explore how LLM agents work in practice: designing effective system prompts, structuring athlete context for Claude, and building a polling loop with OAuth token refresh.

## Stack & design decisions

| Layer | Technology | Why |
|---|---|---|
| LLM | Anthropic Claude (claude-sonnet-4-6) | Best reasoning for structured coaching feedback |
| Training data | Strava API v3 + OAuth | Real personal data, not synthetic |
| Notifications | Telegram Bot API | Instant mobile delivery, HTML formatting |
| Runtime | Node.js (no framework) | Zero dependencies beyond dotenv; easy to run anywhere |
| State | JSON file | Simple persistence for token rotation and dedup |

**Key design choice — system prompt architecture**: The coach persona lives in a dedicated `COACH_SYSTEM_PROMPT` constant, separate from the per-session user content. This makes it easy to A/B test different coaching styles without touching the data-formatting logic.

**Key design choice — polling vs webhooks**: The agent polls every 15 minutes rather than using Strava webhooks. Webhooks require a publicly accessible server; polling works from any machine with zero infrastructure. Trade-off: up to 15-minute delay on notifications.

## How to run it

**Prerequisites**: Node.js 18+, a Strava Developer app, an Anthropic API key, a Telegram bot

```bash
git clone https://github.com/YOUR_USERNAME/strava-claude-agent
cd strava-claude-agent
npm install
cp .env.example .env
# Fill in your credentials in .env
node main.js
```

**Getting Strava credentials**:
1. Create an app at [strava.com/settings/api](https://www.strava.com/settings/api)
2. Authorize via OAuth to get your `refresh_token` (one-time setup)
3. The agent auto-refreshes the access token every 50 minutes

**Getting a Telegram bot**:
1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Get your `TELEGRAM_BOT_TOKEN`
3. Start a chat with your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your `chat_id`

## API endpoints (port 3000)

| Endpoint | Description |
|---|---|
| `GET /health` | Agent status, days to race, last activity ID |
| `GET /activities` | Last 20 Strava activities |
| `GET /week` | Current week stats by discipline |
| `GET /summary` | Trigger weekly summary immediately |

## Output example

```
🏃 New session

Long run — Z2 base
18.5km | 1h 52min | 148bpm | 6'03"/km

Alex, excellent Z2 run. Your 148bpm average (81% HRmax) sits perfectly in aerobic base territory
for your current build phase — exactly where you need to be 63 days out from Vitoria.
The 6'03" pace at this HR suggests your aerobic efficiency is improving...

Rating: 8/10 — disciplined execution of a key long session.

63 days to Vitoria
```

## Roadmap (V2)

- [ ] Strava webhook integration for real-time notifications
- [ ] Garmin HRV data for recovery scoring
- [ ] Structured output via Claude tool use (JSON analysis + Telegram message as two separate steps)
- [ ] Multi-athlete support
- [ ] Web dashboard for training load visualization

## Telegram analysis
Nueva sesion

Carrera de noche
5.41km | 25min 1s | 142bpm | 4'37"/km

# 🏃‍♂️ Análisis: Carrera de Noche

**1. Calidad y estímulo fisiológico**
Sesión de calidad moderada-alta con un estímulo de tempo continuo — corres a 4'37"/km sostenido, lo que representa un esfuerzo aeróbico desarrollado pero no fácil. 💪 La potencia de 290W y cadencia de 88rpm son datos sólidos, aunque esa cadencia está ligeramente por debajo del rango óptimo (90-92rpm) para triatlón, lo que puede costarte energía a largo plazo en el 70.3.

**2. ¿Qué dicen las pulsaciones?** ⚠️
FC media de 142bpm en Z3 con solo 5.4km es una señal de alerta para fase de base: estás entrenando demasiado intenso para el objetivo de esta etapa. En construcción de base, la mayor parte del volumen debería estar en Z1-Z2 (probablemente ~125-135bpm para ti), no en tempo. Esto no es malo ocasionalmente, pero si es tu patrón habitual, estás quemando adaptaciones que necesitas construir despacio.

**3. Consejo específico para tu 70.3** 🎯
Con un maratón de 3h29 tienes base de corredor, pero tu 70.3 de Mallorca en 6h indica que el problema no es velocidad pura sino gestión de esfuerzo acumulado. **Prioriza el 80% de tus kilómetros en Z2 real** — aunque se sienta demasiado fácil. La carrera del 70.3 se gana corriendo cómodo los primeros 15km, no aguantando los últimos 5.

**4. Valoración** 🔢
**5.5/10** — Técnicamente bien ejecutada y con buenas métricas de potencia/cadencia, pero en fase de

9 semanas y 1 dias para Vitoria

