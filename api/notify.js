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

// No hardcoded default — if no Oura data and no adaptive history, morning
// notifications simply don't fire that day rather than firing at a wrong time.
const NO_WAKE_SENTINEL = null;

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

// ─── Wake hour resolution ──────────────────────────────────────────────────────
// Priority: 1) today's Oura actual_wake_h  2) avg_wake_h from recent history
// Returns null if neither is available — morning slots will be skipped that day.
function resolveWakeH(snap, recent) {
  // Today's Oura bedtime_end is the most accurate signal
  if (snap?.actual_wake_h != null) return snap.actual_wake_h;
  // Fall back to rolling average from past snapshots
  const values = recent
    .filter(r => r.avg_wake_h != null)
    .map(r => r.avg_wake_h)
    .slice(0, 7);
  if (values.length < 3) return null;
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

  // Wake hour: Oura actual → rolling avg → null (skip morning slots)
  const wakeH     = resolveWakeH(snap, recent);
  const wakeFloor = wakeH != null ? Math.round(wakeH) : null;
  const source    = snap?.actual_wake_h != null ? 'oura' : wakeH != null ? 'adaptive' : 'none';

  // Morning adaptive slots (all before 12pm) — only defined when wake is known
  const T_BRIEF = wakeFloor;          // wake hour
  const T_STACK = wakeFloor != null ? wakeFloor + 1 : null;
  const T_GYM   = wakeFloor != null ? wakeFloor + 2 : null;
  const T_MEAL  = wakeFloor != null ? wakeFloor + 3 : null;

  console.log(`JARVIS: localH=${localH}, wake=${wakeH != null ? wakeH.toFixed(1) : 'unknown'} (${source})`);

  const fired = [];
  const push  = async (opts) => { fired.push(await sendPush(opts)); };

  // ═══════════════════════════════════════════════════════════════════════════
  // MORNING — adaptive (relative to wake time, all before 12pm)
  // ═══════════════════════════════════════════════════════════════════════════

  // Morning Brief + sleep debt
  if (T_BRIEF != null && localH === T_BRIEF) {
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
  if (T_STACK != null && localH === T_STACK) {
    if (snap && !snap.stack_logged) {
      await push({
        title: 'Morning stack not logged.',
        body: 'Your supplement stack hasn\'t been logged. Keep the streak alive.',
        url: '/?tab=main',
        buttons: [{ label: 'Log Stack', url: '/?tab=main' }],
      });
    }
    if (!snap?.caffeine_mg && wakeFloor != null) {
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
  if (T_GYM != null && localH === T_GYM) {
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
  if (T_MEAL != null && localH === T_MEAL) {
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

  // 12:00pm — JARVIS midday pulse (fallback if Gemini unavailable)
  if (localH === 12) {
    const pulse = await buildJarvisPulse(snap, recent, 'midday');
    await push({
      title: 'JARVIS — midday',
      body: pulse || (snap
        ? `${snap.tasks_remaining ?? '?'} tasks remaining. Protein at ${snap.protein_g ?? 0}g of ${snap.protein_target_g ?? 150}g. Halfway through the day.`
        : 'Midday check-in. Open Life Arc to review your progress.'),
      url: '/?tab=jarvis',
      buttons: [{ label: 'Open JARVIS', url: '/?tab=jarvis' }],
    });
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
          ? `₹${snap.daily_spend.toFixed(0)} today — ${Math.round((snap.daily_spend / avg - 1) * 100)}% above your daily average.`
          : `Today: ₹${snap.daily_spend.toFixed(0)}. Tracking near average.`,
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
    await push({
      title: 'JARVIS — evening',
      body: pulse || (snap
        ? `${snap.workout_logged ? 'Workout done.' : 'No workout logged.'} Protein: ${snap.protein_g ?? 0}g of ${snap.protein_target_g ?? 150}g. Journal ${snap.journal_written ? 'written' : 'not written'}.`
        : 'Evening check-in. How did today go?'),
      url: '/?tab=jarvis',
      buttons: [{ label: 'Open JARVIS', url: '/?tab=jarvis' }, { label: 'Log Journal', url: '/?tab=main' }],
    });
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

  // 9:00 — Personal record alerts (fixed slot so they fire at most once per day)
  if (localH === 9) {
    if (snap?.sleep_score != null && recent.length > 1) {
      const prevBest = Math.max(...recent.slice(1).map(r => r.sleep_score ?? 0));
      if (snap.sleep_score > prevBest && prevBest > 0) {
        await push({
          title: 'Best sleep in 30 days.',
          body: `Sleep score ${snap.sleep_score} — your highest this month. JARVIS logged it.`,
          url: '/?tab=health',
          buttons: [{ label: 'View Health', url: '/?tab=health' }],
        });
      }
    }
    if (snap?.readiness_score != null && recent.length > 1) {
      const prevBestR = Math.max(...recent.slice(1).map(r => r.readiness_score ?? 0));
      if (snap.readiness_score > prevBestR && prevBestR > 0) {
        await push({
          title: 'Peak readiness today.',
          body: `Readiness score ${snap.readiness_score} — new 30-day high. Use it.`,
          url: '/?tab=jarvis',
          buttons: [{ label: 'Open JARVIS', url: '/?tab=jarvis' }],
        });
      }
    }
  }

  // Sunday 20:00 — Weekly goal review (dedicated slot, not bundled with evening pulse)
  if (localH === 20 && dayOfWeek === 0) {
    await push({
      title: 'Weekly goal review.',
      body: 'Sunday wind-down: which goals moved this week, which ones didn\'t? 5 minutes sets your pace for next week.',
      url: '/?tab=main',
      buttons: [{ label: 'Review Goals', url: '/?tab=main' }, { label: 'Open JARVIS', url: '/?tab=jarvis' }],
    });
  }

  // 22:00 — Goal deadline creep + sleep nudge (merged into one block)
  if (localH === 22) {
    if (snap && (snap.tasks_remaining ?? 0) > 0) {
      await push({
        title: 'Goals still open.',
        body: `${snap.tasks_remaining} task${snap.tasks_remaining > 1 ? 's' : ''} unfinished today. Move or close them before midnight so tomorrow starts clean.`,
        url: '/?tab=main',
        buttons: [{ label: 'View Goals', url: '/?tab=main' }],
      });
    }
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
  // Open endpoint — security by obscurity is fine for a personal app.
  // The URL is not publicly listed and the worst case is a duplicate notification.
  try {
    const count = await handleCron();
    return res.status(200).json({ ok: true, sent: count });
  } catch (err) {
    console.error('notify error:', err);
    return res.status(500).json({ error: err.message });
  }
};
