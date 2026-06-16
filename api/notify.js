// Life Arc MAXXING — JARVIS Notification Engine (complete, 30 notifications)
// Vercel Cron fires this on the schedule in vercel.json.
// All times are IST (UTC+5:30). Each slot checks hour and fires matching rules.

const ONESIGNAL_APP_ID  = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const APP_URL           = 'https://maximusk.vercel.app';

// ─── Send push with optional action buttons ───────────────────────────────────
async function sendPush({ title, body, url = '/', buttons = [] }) {
  const payload = {
    app_id:            ONESIGNAL_APP_ID,
    included_segments: ['All'],
    headings:          { en: title },
    contents:          { en: body },
    url:               `${APP_URL}${url}`,
    chrome_web_icon:   `${APP_URL}/apple-touch-icon.png`,
    app_url:           `${APP_URL}${url}`,
  };
  // Action buttons (max 2 on iOS web push)
  if (buttons.length) {
    payload.web_buttons = buttons.map((b, i) => ({
      id:   `btn${i}`,
      text: b.label,
      url:  `${APP_URL}${b.url}`,
    }));
  }
  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Basic ${ONESIGNAL_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function getSnapshot(date) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/daily_snapshots?date=eq.${date}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows?.[0] ?? null;
  } catch { return null; }
}

async function getRecentSnapshots(n = 7) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/daily_snapshots?order=date.desc&limit=${n}&user_id=eq.koustubh&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return (await res.json()) ?? [];
  } catch { return []; }
}

// ─── Dynamic JARVIS pulse via Gemini ─────────────────────────────────────────
async function buildJarvisPulse(snap, recent, hour) {
  if (!GEMINI_API_KEY) return null;
  const session = hour < 14 ? 'midday' : 'evening';

  const todayBundle = snap ? `
Today (${session} check-in at ${hour}:00):
- Sleep: ${snap.sleep_h ?? '?'}h | Readiness: ${snap.readiness_score ?? '?'}/100
- Caffeine active: ${snap.caffeine_mg ?? '?'}mg (limit: ${snap.caffeine_limit_mg ?? 400}mg) | Coffee score: ${snap.coffee_score ?? '?'}/100
- Protein: ${snap.protein_g ?? '?'}g of ${snap.protein_target_g ?? 150}g target | Meals logged: ${snap.meals_logged ?? 0}
- Workout today: ${snap.workout_logged ? 'yes' : 'no'} | Days since gym: ${snap.days_since_gym ?? '?'}
- Tasks remaining: ${snap.tasks_remaining ?? '?'} | Journal: ${snap.journal_written ? 'written' : 'not written'}
- Stack logged: ${snap.stack_logged ? 'yes' : 'no'}
- Net worth delta today: ${snap.net_worth_delta != null ? (snap.net_worth_delta >= 0 ? '+' : '') + snap.net_worth_delta.toFixed(0) : '?'}
- Savings rate this month: ${snap.savings_rate_pct ?? '?'}%`.trim()
  : `Today (${session}, ${hour}:00): no snapshot data yet.`;

  const historyBundle = recent.length > 1 ? '\n\n7-day history:\n' + recent.slice(1).map(r =>
    `${r.date}: sleep ${r.sleep_h ?? '?'}h | readiness ${r.readiness_score ?? '?'} | protein ${r.protein_g ?? '?'}g | ${r.workout_logged ? 'trained' : 'rest'} | savings ${r.savings_rate_pct ?? '?'}%`
  ).join('\n') : '';

  const prompt = `You are JARVIS — the AI inside Life Arc, a personal performance app. You speak directly, calmly, and honestly. No emojis, no fluff, no "Great job!".

Given this data:
${todayBundle}${historyBundle}

Write ONE push notification (maximum 2 sentences). Identify the single most important action the user should take RIGHT NOW. Use specific numbers. Sound like a trusted advisor, not a chatbot.

Reply with ONLY the notification text — no title, no quotes, nothing else.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const json = await res.json();
    return json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
  } catch { return null; }
}

// ─── Main cron handler ────────────────────────────────────────────────────────
async function handleCron() {
  const offsetH   = parseFloat(process.env.TIMEZONE_OFFSET_H || '5.5');
  const now       = new Date();
  const localHour = Math.floor((now.getUTCHours() + offsetH) % 24);
  const today     = new Date(now.getTime() + offsetH * 3600000).toISOString().slice(0, 10);
  const dayOfWeek = new Date(today).getDay(); // 0=Sun, 6=Sat

  const [snap, recent] = await Promise.all([
    getSnapshot(today),
    getRecentSnapshots(7),
  ]);

  const results = [];
  const push = (...args) => results.push(sendPush(...args));

  // ── 6:00am — Morning Brief + sleep debt check ────────────────────────────
  if (localHour === 6) {
    const readiness = snap?.readiness_score ?? null;
    push({
      title: 'Good morning.',
      body: readiness
        ? `Readiness ${readiness}/100. JARVIS has your morning brief ready.`
        : 'JARVIS has your morning brief ready.',
      url: '/?tab=jarvis',
      buttons: [{ label: 'Open Brief', url: '/?tab=jarvis' }],
    });

    // Sleep debt: 3+ nights under 6.5h
    const sleepHistory = recent.filter(r => r.sleep_h != null).slice(0, 5);
    const underSlept = sleepHistory.filter(r => r.sleep_h < 6.5).length;
    if (underSlept >= 3) {
      push({
        title: 'Sleep debt building.',
        body: `${underSlept} of your last ${sleepHistory.length} nights under 6.5h. Recovery is compounding — protect tonight.`,
        url: '/?tab=health',
        buttons: [{ label: 'View Health', url: '/?tab=health' }],
      });
    }
  }

  // ── 9:00am — Stack + gym streak + caffeine timing coach ─────────────────
  if (localHour === 9) {
    if (snap && !snap.stack_logged) {
      push({
        title: 'Morning stack not logged.',
        body: 'Your supplement stack hasn\'t been logged. Keep the streak alive.',
        url: '/?tab=main',
        buttons: [{ label: 'Log Stack', url: '/?tab=main' }],
      });
    }

    if (snap && !snap.workout_logged && (snap.days_since_gym ?? 0) >= 2) {
      push({
        title: 'Gym streak at risk.',
        body: `${snap.days_since_gym} days since your last workout. A session today keeps it alive.`,
        url: '/?tab=gym',
        buttons: [{ label: 'Open Gym', url: '/?tab=gym' }, { label: 'Log Workout', url: '/?tab=gym' }],
      });
    }

    // Caffeine timing: cortisol peaks until ~9:30am
    if (snap && !snap.caffeine_mg) {
      push({
        title: 'Caffeine timing.',
        body: 'Cortisol peaks until ~9:30am. Your first coffee hits harder if you wait 30 more minutes.',
        url: '/?tab=health',
      });
    }
  }

  // ── 11:00am — First meal nudge ───────────────────────────────────────────
  if (localHour === 11) {
    if (snap && (snap.meals_logged ?? 0) === 0) {
      push({
        title: 'No meals logged yet.',
        body: 'A protein-first meal now sets your macro pace for the day.',
        url: '/?tab=health',
        buttons: [{ label: 'Log Meal', url: '/?tab=health' }, { label: 'Snap Meal', url: '/?tab=health' }],
      });
    }
  }

  // ── 12:00pm — Dynamic JARVIS midday pulse ────────────────────────────────
  if (localHour === 12) {
    const pulse = await buildJarvisPulse(snap, recent, localHour);
    if (pulse) {
      push({
        title: 'JARVIS — midday',
        body: pulse,
        url: '/?tab=jarvis',
        buttons: [{ label: 'Open JARVIS', url: '/?tab=jarvis' }],
      });
    }
  }

  // ── 14:00 — Afternoon caffeine gate ──────────────────────────────────────
  if (localHour === 14) {
    const mg = snap?.caffeine_mg ?? null;
    if (mg !== null) {
      push({
        title: mg >= 40 && mg <= 200 ? 'Caffeine optimal.' : 'Caffeine check.',
        body: mg >= 40 && mg <= 200
          ? `${mg}mg active — focus zone. A top-up after 2pm will cut into sleep.`
          : mg < 40
          ? `${mg}mg active. Afternoon dip coming — walk + water before reaching for coffee.`
          : `${mg}mg active — above optimal. Skip the afternoon coffee to protect your sleep score.`,
        url: '/?tab=health',
        buttons: [{ label: 'View Caffeine', url: '/?tab=health' }],
      });
    }
  }

  // ── 15:30 — Macro + schedule gap check ───────────────────────────────────
  if (localHour === 15) {
    const protein = snap?.protein_g ?? null;
    const target  = snap?.protein_target_g ?? 150;
    if (protein !== null && protein < target * 0.4) {
      push({
        title: 'Protein behind pace.',
        body: `${protein}g logged — ${target - protein}g short. Dinner alone won\'t cover it. Add a snack now.`,
        url: '/?tab=health',
        buttons: [{ label: 'Log Food', url: '/?tab=health' }, { label: 'Snap Meal', url: '/?tab=health' }],
      });
    }

    if (snap && !snap.workout_logged) {
      push({
        title: 'Workout window open.',
        body: 'No workout logged today. You have a clean 90-minute window before evening cuts in.',
        url: '/?tab=gym',
        buttons: [{ label: 'Open Gym', url: '/?tab=gym' }],
      });
    }
  }

  // ── 17:00 — Finance: spend pulse + savings rate + subscriptions ──────────
  if (localHour === 17) {
    // Daily spend
    if (snap?.daily_spend != null) {
      const avg  = snap.daily_spend_avg ?? snap.daily_spend;
      const over = snap.daily_spend > avg * 1.3;
      push({
        title: over ? 'Spend running high.' : 'Daily spend pulse.',
        body: over
          ? `CHF ${snap.daily_spend.toFixed(0)} today — ${Math.round((snap.daily_spend / avg - 1) * 100)}% above your daily average of CHF ${avg.toFixed(0)}.`
          : `Today: CHF ${snap.daily_spend.toFixed(0)}. Tracking near your daily average.`,
        url: '/?tab=finance',
        buttons: [{ label: 'View Finance', url: '/?tab=finance' }],
      });
    }

    // Savings rate warning
    if (snap?.savings_rate_pct != null && snap.savings_rate_pct < 15) {
      push({
        title: 'Savings rate low.',
        body: `You\'re saving ${snap.savings_rate_pct}% of income this month — below your target. ${30 - new Date().getDate()} days left to course-correct.`,
        url: '/?tab=finance',
        buttons: [{ label: 'View Savings', url: '/?tab=finance' }],
      });
    }

    // Unusual spend: today 2x average
    if (snap?.daily_spend != null && snap?.daily_spend_avg != null && snap.daily_spend > snap.daily_spend_avg * 2) {
      push({
        title: 'Unusual spend today.',
        body: `CHF ${snap.daily_spend.toFixed(0)} today is more than double your daily average. Pattern or one-off?`,
        url: '/?tab=finance',
        buttons: [{ label: 'Review Expenses', url: '/?tab=finance' }],
      });
    }
  }

  // ── 19:00 — Dynamic JARVIS evening pulse ─────────────────────────────────
  if (localHour === 19) {
    const pulse = await buildJarvisPulse(snap, recent, localHour);
    if (pulse) {
      push({
        title: 'JARVIS — evening',
        body: pulse,
        url: '/?tab=jarvis',
        buttons: [{ label: 'Open JARVIS', url: '/?tab=jarvis' }, { label: 'Log Journal', url: '/?tab=main' }],
      });
    }

    // Dinner macro alert
    const protein = snap?.protein_g ?? null;
    const target  = snap?.protein_target_g ?? 150;
    if (protein !== null && protein < target * 0.5) {
      push({
        title: 'Protein gap at dinner.',
        body: `${protein}g logged — ${target - protein}g short. Make dinner count: aim for ${Math.round((target - protein) * 0.8)}g+ this meal.`,
        url: '/?tab=health',
        buttons: [{ label: 'Snap Dinner', url: '/?tab=health' }],
      });
    }
  }

  // ── 20:00 — Caffeine sleep impact + tomorrow prep ─────────────────────────
  if (localHour === 20) {
    const mg = snap?.caffeine_mg ?? 0;
    if (mg > 30) {
      push({
        title: 'Caffeine still active.',
        body: `${mg}mg in your system. At your clearance rate, sleep quality may be affected until ~${Math.round(20 + mg / 40)}:00.`,
        url: '/?tab=health',
        buttons: [{ label: 'View Caffeine', url: '/?tab=health' }],
      });
    }

    // Tomorrow prep: unfinished tasks + goals
    const remaining = snap?.tasks_remaining ?? 0;
    if (remaining >= 3) {
      push({
        title: 'Tomorrow prep.',
        body: `${remaining} tasks still open today. 5-minute review now means a cleaner morning start.`,
        url: '/?tab=main',
        buttons: [{ label: 'View Tasks', url: '/?tab=main' }],
      });
    }

    // Daily debrief unlock
    push({
      title: 'JARVIS Weekly Debrief ready.',
      body: 'Your sleep trend, macro average, and focus pattern are ready to review.',
      url: '/?tab=jarvis',
      buttons: [{ label: 'View Debrief', url: '/?tab=jarvis' }],
    });
  }

  // ── 21:00 — Journal streak + net worth milestone ──────────────────────────
  if (localHour === 21) {
    if (snap && !snap.journal_written) {
      push({
        title: 'Journal streak at risk.',
        body: 'You haven\'t written today. It resets at midnight — takes 2 minutes.',
        url: '/?tab=main',
        buttons: [{ label: 'Write Now', url: '/?tab=main' }],
      });
    }

    // Net worth milestone: new high vs last 30 days
    if (snap?.net_worth != null && recent.length > 1) {
      const maxPrev = Math.max(...recent.slice(1).map(r => r.net_worth ?? 0));
      if (snap.net_worth > maxPrev && maxPrev > 0) {
        push({
          title: 'New net worth high.',
          body: `Your net worth hit a new 30-day high today. JARVIS logged it.`,
          url: '/?tab=finance',
          buttons: [{ label: 'View Net Worth', url: '/?tab=finance' }],
        });
      }
    }
  }

  // ── Sunday 20:00 — Weekly goal review ────────────────────────────────────
  if (localHour === 20 && dayOfWeek === 0) {
    push({
      title: 'Weekly goal review.',
      body: 'Sunday check-in: which goals moved this week, and which didn\'t? 5 minutes sets your week.',
      url: '/?tab=main',
      buttons: [{ label: 'Review Goals', url: '/?tab=main' }, { label: 'Open JARVIS', url: '/?tab=jarvis' }],
    });
  }

  // ── Any time — streak milestone (7 / 14 / 30 days) ───────────────────────
  if (localHour === 21 && snap?.gym_streak != null) {
    const s = snap.gym_streak;
    if ([7, 14, 21, 30, 60, 90].includes(s)) {
      push({
        title: `${s}-day gym streak.`,
        body: `${s} consecutive days of training logged. JARVIS recorded it.`,
        url: '/?tab=gym',
        buttons: [{ label: 'View Streak', url: '/?tab=gym' }],
      });
    }
  }

  // Wait for all pushes to settle
  await Promise.allSettled(results);
  return results.length;
}

// ─── Vercel handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const cronHeader = req.headers['x-vercel-cron'];
  const auth       = req.headers['authorization'];
  if (!cronHeader && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const count = await handleCron();
    return res.status(200).json({ ok: true, sent: count });
  } catch (err) {
    console.error('notify error:', err);
    return res.status(500).json({ error: err.message });
  }
}
