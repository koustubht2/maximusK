// Life Arc MAXXING — JARVIS Notification Engine
// Morning notifications (brief → meal nudge) are ADAPTIVE — shift with wake time.
// All notifications from 12pm onwards are FIXED to real clock hours.
// Cron fires every hour at :30 UTC via 2 Vercel crons (Hobby plan limit).

const ONESIGNAL_APP_ID  = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const APP_URL           = 'https://maximusk.vercel.app';

const DEFAULT_WAKE_H = 7.0; // fallback until adaptive data builds up

// ─── Push helper ──────────────────────────────────────────────────────────────
async function sendPush({ title, body, url = '/', buttons = [] }) {
  const payload = {
    app_id:            ONESIGNAL_APP_ID,
    included_segments: ['All'],
    headings:          { en: title },
    contents:          { en: body },
    url:               `${APP_URL}${url}`,
    chrome_web_icon:   `${APP_URL}/apple-touch-icon.png`,
  };
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

// ─── Supabase ─────────────────────────────────────────────────────────────────
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

async function getRecentSnapshots(n = 14) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/daily_snapshots?order=date.desc&limit=${n}&user_id=eq.koustubh&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return (await res.json()) ?? [];
  } catch { return []; }
}

// ─── Adaptive wake hour ────────────────────────────────────────────────────────
// Averages avg_wake_h from last 7 snapshots. Falls back to DEFAULT_WAKE_H.
function getAdaptiveWake(recent) {
  const values = recent
    .filter(r => r.avg_wake_h != null)
    .map(r => r.avg_wake_h)
    .slice(0, 7);
  if (values.length < 3) return DEFAULT_WAKE_H;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ─── Dynamic JARVIS pulse via Gemini ──────────────────────────────────────────
async function buildJarvisPulse(snap, recent, session) {
  if (!GEMINI_API_KEY) return null;

  const todayBundle = snap ? `
Today (${session}):
- Sleep: ${snap.sleep_h ?? '?'}h | Readiness: ${snap.readiness_score ?? '?'}/100
- Caffeine active: ${snap.caffeine_mg ?? '?'}mg (limit: ${snap.caffeine_limit_mg ?? 400}mg)
- Protein: ${snap.protein_g ?? '?'}g of ${snap.protein_target_g ?? 150}g | Meals: ${snap.meals_logged ?? 0}
- Workout: ${snap.workout_logged ? 'done' : 'not yet'} | Days since gym: ${snap.days_since_gym ?? '?'}
- Tasks remaining: ${snap.tasks_remaining ?? '?'} | Journal: ${snap.journal_written ? 'done' : 'not written'}
- Stack: ${snap.stack_logged ? 'logged' : 'not logged'}
- Net worth delta: ${snap.net_worth_delta != null ? (snap.net_worth_delta >= 0 ? '+' : '') + snap.net_worth_delta.toFixed(0) : '?'}
- Savings rate: ${snap.savings_rate_pct ?? '?'}%`.trim()
  : `Today (${session}): no snapshot data yet.`;

  const historyBundle = recent.length > 1
    ? '\n\n7-day history:\n' + recent.slice(1, 8).map(r =>
        `${r.date}: sleep ${r.sleep_h ?? '?'}h | readiness ${r.readiness_score ?? '?'} | protein ${r.protein_g ?? '?'}g | ${r.workout_logged ? 'trained' : 'rest'} | savings ${r.savings_rate_pct ?? '?'}%`
      ).join('\n')
    : '';

  const prompt = `You are JARVIS — the AI inside Life Arc, a personal performance app. Direct, calm, honest. No emojis, no fluff, no "Great job!".

${todayBundle}${historyBundle}

Write ONE push notification (max 2 sentences). The single most important action right now. Use specific numbers. Trusted advisor voice.

Reply with ONLY the notification text.`;

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
  const offsetH    = parseFloat(process.env.TIMEZONE_OFFSET_H || '5.5');
  const now        = new Date();
  const utcDecimal = now.getUTCHours() + now.getUTCMinutes() / 60;
  const localH     = Math.floor((utcDecimal + offsetH) % 24);
  const today      = new Date(now.getTime() + offsetH * 3600000).toISOString().slice(0, 10);
  const dayOfWeek  = new Date(today).getDay(); // 0=Sun

  const [snap, recent] = await Promise.all([
    getSnapshot(today),
    getRecentSnapshots(14),
  ]);

  // Adaptive wake — only affects morning slots (pre-12pm)
  const wakeH       = getAdaptiveWake(recent);
  const wakeFloor   = Math.floor(wakeH);
  const adaptive    = recent.filter(r => r.avg_wake_h != null).length >= 3;

  // Morning adaptive slots (all before 12pm)
  const T_BRIEF     = wakeFloor;          // e.g. 7am
  const T_STACK     = wakeFloor + 1;      // wake + 1h
  const T_GYM       = wakeFloor + 2;      // wake + 2h
  const T_MEAL      = wakeFloor + 3;      // wake + 3h

  console.log(`JARVIS: localH=${localH}, wake=${wakeH.toFixed(1)} (${adaptive ? 'adaptive' : 'default'})`);

  const fired = [];
  const push  = async (opts) => { fired.push(await sendPush(opts)); };

  // ═══════════════════════════════════════════════════════════════════════════
  // MORNING — adaptive (relative to wake time, all before 12pm)
  // ═══════════════════════════════════════════════════════════════════════════

  // Morning Brief + sleep debt
  if (localH === T_BRIEF) {
    await push({
      title: 'Good morning.',
      body: snap?.readiness_score
        ? `Readiness ${snap.readiness_score}/100. JARVIS has your morning brief ready.`
        : 'JARVIS has your morning brief ready.',
      url: '/?tab=jarvis',
      buttons: [{ label: 'Open Brief', url: '/?tab=jarvis' }],
    });
    const sleepHistory = recent.filter(r => r.sleep_h != null).slice(0, 5);
    const underSlept   = sleepHistory.filter(r => r.sleep_h < 6.5).length;
    if (underSlept >= 3) {
      await push({
        title: 'Sleep debt building.',
        body: `${underSlept} of your last ${sleepHistory.length} nights under 6.5h. Recovery is compounding.`,
        url: '/?tab=health',
        buttons: [{ label: 'View Health', url: '/?tab=health' }],
      });
    }
  }

  // Stack + caffeine timing coach
  if (localH === T_STACK) {
    if (snap && !snap.stack_logged) {
      await push({
        title: 'Morning stack not logged.',
        body: 'Your supplement stack hasn\'t been logged. Keep the streak alive.',
        url: '/?tab=main',
        buttons: [{ label: 'Log Stack', url: '/?tab=main' }],
      });
    }
    if (!snap?.caffeine_mg) {
      const goodTime = wakeFloor + 1.5;
      await push({
        title: 'Caffeine timing.',
        body: `Cortisol peaks ~90min after waking. Your coffee hits harder after ${Math.floor(goodTime)}:${goodTime % 1 >= 0.5 ? '30' : '00'}am.`,
        url: '/?tab=health',
      });
    }
    // Gym streak milestone
    if (snap?.gym_streak && [7, 14, 21, 30, 60, 90].includes(snap.gym_streak)) {
      await push({
        title: `${snap.gym_streak}-day gym streak.`,
        body: `${snap.gym_streak} consecutive days of training logged. JARVIS recorded it.`,
        url: '/?tab=gym',
        buttons: [{ label: 'View Streak', url: '/?tab=gym' }],
      });
    }
  }

  // Gym streak at risk
  if (localH === T_GYM) {
    if (snap && !snap.workout_logged && (snap.days_since_gym ?? 0) >= 2) {
      await push({
        title: 'Gym streak at risk.',
        body: `${snap.days_since_gym} days since your last workout. A session today keeps it alive.`,
        url: '/?tab=gym',
        buttons: [{ label: 'Open Gym', url: '/?tab=gym' }],
      });
    }
  }

  // First meal nudge
  if (localH === T_MEAL) {
    if (snap && (snap.meals_logged ?? 0) === 0) {
      await push({
        title: 'No meals logged yet.',
        body: 'A protein-first meal now sets your macro pace for the day.',
        url: '/?tab=health',
        buttons: [{ label: 'Snap Meal', url: '/?tab=health' }, { label: 'Log Food', url: '/?tab=health' }],
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AFTERNOON + EVENING — fixed clock times (IST)
  // ═══════════════════════════════════════════════════════════════════════════

  // 12:00pm — JARVIS midday pulse
  if (localH === 12) {
    const pulse = await buildJarvisPulse(snap, recent, 'midday');
    if (pulse) {
      await push({
        title: 'JARVIS — midday',
        body: pulse,
        url: '/?tab=jarvis',
        buttons: [{ label: 'Open JARVIS', url: '/?tab=jarvis' }],
      });
    }
  }

  // 14:00 — Afternoon caffeine gate
  if (localH === 14) {
    const mg = snap?.caffeine_mg ?? null;
    if (mg !== null) {
      await push({
        title: mg >= 40 && mg <= 200 ? 'Caffeine optimal.' : 'Caffeine check.',
        body: mg >= 40 && mg <= 200
          ? `${mg}mg active — focus zone. A top-up after 2pm will cut into tonight's sleep.`
          : mg < 40
          ? `${mg}mg active. Afternoon dip coming — walk first before another coffee.`
          : `${mg}mg still active — above optimal. Skip the next coffee to protect sleep.`,
        url: '/?tab=health',
        buttons: [{ label: 'View Caffeine', url: '/?tab=health' }],
      });
    }
  }

  // 15:00 — Macro check + workout window
  if (localH === 15) {
    const protein = snap?.protein_g ?? null;
    const target  = snap?.protein_target_g ?? 150;
    if (protein !== null && protein < target * 0.4) {
      await push({
        title: 'Protein behind pace.',
        body: `${protein}g logged — ${target - protein}g short. Add a snack now, dinner alone won't cover it.`,
        url: '/?tab=health',
        buttons: [{ label: 'Snap Meal', url: '/?tab=health' }],
      });
    }
    if (snap && !snap.workout_logged) {
      await push({
        title: 'Workout window open.',
        body: 'No workout logged today. You have a clean window before evening cuts in.',
        url: '/?tab=gym',
        buttons: [{ label: 'Open Gym', url: '/?tab=gym' }],
      });
    }
  }

  // 17:00 — Daily spend pulse + savings rate
  if (localH === 17) {
    if (snap?.daily_spend != null) {
      const avg  = snap.daily_spend_avg ?? snap.daily_spend;
      const over = snap.daily_spend > avg * 1.3;
      await push({
        title: over ? 'Spend running high.' : 'Daily spend pulse.',
        body: over
          ? `CHF ${snap.daily_spend.toFixed(0)} today — ${Math.round((snap.daily_spend / avg - 1) * 100)}% above your daily average.`
          : `Today: CHF ${snap.daily_spend.toFixed(0)}. Tracking near average.`,
        url: '/?tab=finance',
        buttons: [{ label: 'View Finance', url: '/?tab=finance' }],
      });
    }
    if (snap?.savings_rate_pct != null && snap.savings_rate_pct < 15) {
      await push({
        title: 'Savings rate low.',
        body: `Saving ${snap.savings_rate_pct}% of income this month. ${30 - new Date().getDate()} days left to course-correct.`,
        url: '/?tab=finance',
        buttons: [{ label: 'View Savings', url: '/?tab=finance' }],
      });
    }
  }

  // 19:00 — JARVIS evening pulse + dinner macro
  if (localH === 19) {
    const pulse = await buildJarvisPulse(snap, recent, 'evening');
    if (pulse) {
      await push({
        title: 'JARVIS — evening',
        body: pulse,
        url: '/?tab=jarvis',
        buttons: [{ label: 'Open JARVIS', url: '/?tab=jarvis' }, { label: 'Log Journal', url: '/?tab=main' }],
      });
    }
    const protein = snap?.protein_g ?? null;
    const target  = snap?.protein_target_g ?? 150;
    if (protein !== null && protein < target * 0.5) {
      await push({
        title: 'Protein gap at dinner.',
        body: `${protein}g logged — ${target - protein}g short. Make dinner count.`,
        url: '/?tab=health',
        buttons: [{ label: 'Snap Dinner', url: '/?tab=health' }],
      });
    }
    // Sunday weekly goal review
    if (dayOfWeek === 0) {
      await push({
        title: 'Weekly goal review.',
        body: 'Sunday check-in: which goals moved this week? 5 minutes sets your week.',
        url: '/?tab=main',
        buttons: [{ label: 'Review Goals', url: '/?tab=main' }, { label: 'Open JARVIS', url: '/?tab=jarvis' }],
      });
    }
  }

  // 20:00 — Caffeine sleep impact + journal streak + tomorrow prep
  if (localH === 20) {
    const mg = snap?.caffeine_mg ?? 0;
    if (mg > 30) {
      await push({
        title: 'Caffeine still active.',
        body: `${mg}mg in your system. Sleep quality may be affected — avoid any more caffeine tonight.`,
        url: '/?tab=health',
        buttons: [{ label: 'View Caffeine', url: '/?tab=health' }],
      });
    }
    if (snap && !snap.journal_written) {
      await push({
        title: 'Journal streak at risk.',
        body: 'You haven\'t written today. It resets at midnight — takes 2 minutes.',
        url: '/?tab=main',
        buttons: [{ label: 'Write Now', url: '/?tab=main' }],
      });
    }
    if ((snap?.tasks_remaining ?? 0) >= 2) {
      await push({
        title: 'Tomorrow prep.',
        body: `${snap.tasks_remaining} tasks still open. 5-minute review now means a cleaner morning.`,
        url: '/?tab=main',
        buttons: [{ label: 'View Tasks', url: '/?tab=main' }],
      });
    }
    // Net worth milestone
    if (snap?.net_worth != null && recent.length > 1) {
      const maxPrev = Math.max(...recent.slice(1).map(r => r.net_worth ?? 0));
      if (snap.net_worth > maxPrev && maxPrev > 0) {
        await push({
          title: 'New net worth high.',
          body: 'Your net worth hit a new 30-day high today. JARVIS logged it.',
          url: '/?tab=finance',
          buttons: [{ label: 'View Net Worth', url: '/?tab=finance' }],
        });
      }
    }
  }

  // 21:00 — JARVIS Debrief + wind-down
  if (localH === 21) {
    await push({
      title: 'JARVIS Debrief ready.',
      body: 'Your sleep trend, macro average, and focus pattern from today are ready to review.',
      url: '/?tab=jarvis',
      buttons: [{ label: 'View Debrief', url: '/?tab=jarvis' }],
    });
    await push({
      title: 'Wind down.',
      body: 'Dim the lights, put the phone away. Screens off in 30 minutes protects your sleep quality.',
      url: '/?tab=jarvis',
    });
  }

  // 22:00 — Sleep nudge
  if (localH === 22) {
    await push({
      title: 'Time to sleep.',
      body: 'JARVIS recommends lights out now. A consistent sleep time is the single biggest lever on tomorrow\'s readiness.',
      url: '/?tab=health',
      buttons: [{ label: 'Log Sleep', url: '/?tab=health' }],
    });
  }

  return fired.length;
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
};
