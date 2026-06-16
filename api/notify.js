// Life Arc MAXXING — JARVIS Notification Engine
// Vercel Cron calls this endpoint on the schedule defined in vercel.json.
// Each cron hit checks the current hour and fires the right notification(s).
// For the 12:00 and 19:00 slots it builds a dynamic JARVIS pulse via Gemini.

const ONESIGNAL_APP_ID  = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;

// Send a push notification to ALL subscribers (the whole app is one user for now)
async function sendPush({ title, body, url = '/', data = {} }) {
  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${ONESIGNAL_API_KEY}`,
    },
    body: JSON.stringify({
      app_id:             ONESIGNAL_APP_ID,
      included_segments:  ['All'],
      headings:           { en: title },
      contents:           { en: body },
      url:                `https://maximusk.vercel.app${url}`,
      chrome_web_icon:    'https://maximusk.vercel.app/apple-touch-icon.png',
      data,
    }),
  });
  return res.json();
}

// Pull today's snapshot from Supabase (written by the app daily)
async function getTodaySnapshot() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/daily_snapshots?date=eq.${today}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : null;
  } catch { return null; }
}

// Ask Gemini to generate a single JARVIS directive notification
async function buildJarvisPulse(snap, hour) {
  if (!GEMINI_API_KEY) return null;
  const session = hour < 14 ? 'midday' : 'evening';

  const bundle = snap ? `
Current time: ${hour}:00 — ${session} check-in.
Sleep last night: ${snap.sleep_h ?? 'unknown'}h
Focus score today: ${snap.focus_score ?? 'unknown'}/100
Caffeine active now: ${snap.caffeine_mg ?? 'unknown'}mg
Protein logged today: ${snap.protein_g ?? 'unknown'}g of target ${snap.protein_target_g ?? 150}g
Workout logged today: ${snap.workout_logged ? 'yes' : 'no'}
Meals logged today: ${snap.meals_logged ?? 'unknown'}
Journal written today: ${snap.journal_written ? 'yes' : 'no'}
Net worth change today: ${snap.net_worth_delta != null ? (snap.net_worth_delta >= 0 ? '+' : '') + snap.net_worth_delta : 'unknown'}
Savings rate this month: ${snap.savings_rate_pct ?? 'unknown'}%
Supplement stack logged: ${snap.stack_logged ? 'yes' : 'no'}
Tasks remaining today: ${snap.tasks_remaining ?? 'unknown'}
`.trim() : `Current time: ${hour}:00 — ${session} check-in. No detailed data available yet.`;

  const prompt = `You are JARVIS — the AI in Life Arc, a personal performance app. You speak directly, calmly, and honestly. No emojis, no fluff, no "Great job!".

Given this snapshot of the user's day:
${bundle}

Write ONE push notification (maximum 2 sentences). Tell the user the single most important action they should take RIGHT NOW. Be specific with numbers where available. Sound like a trusted advisor, not a chatbot.

Reply with ONLY the notification text — nothing else.`;

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
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text || null;
  } catch { return null; }
}

// Decide which notification(s) to send based on current UTC hour.
// Vercel crons run in UTC — adjust offsets for your timezone (IST = UTC+5:30, so
// set TIMEZONE_OFFSET_H=5.5 in Vercel env vars, or hardcode below).
async function handleCron() {
  const offsetH   = parseFloat(process.env.TIMEZONE_OFFSET_H || '5.5'); // IST default
  const utcHour   = new Date().getUTCHours();
  const localHour = (utcHour + offsetH) % 24;
  const h         = Math.floor(localHour);

  const snap = await getTodaySnapshot();
  const results = [];

  // --- 6:00am — Morning Brief ready ---
  if (h === 6) {
    const readiness = snap?.focus_score ?? null;
    results.push(await sendPush({
      title: 'Good morning.',
      body: readiness
        ? `Your readiness score is ${readiness}. JARVIS has your morning brief ready.`
        : 'JARVIS has your morning brief ready. Start the day with intention.',
      url: '/?tab=jarvis',
    }));
  }

  // --- 9:00am — Supplement stack + gym streak ---
  if (h === 9) {
    if (snap && !snap.stack_logged) {
      results.push(await sendPush({
        title: 'Morning stack not logged.',
        body: 'Your supplement stack hasn\'t been logged yet. Keep the streak alive.',
        url: '/?tab=main',
      }));
    }
    if (snap && !snap.workout_logged && (snap.days_since_gym ?? 0) >= 2) {
      results.push(await sendPush({
        title: 'Gym streak at risk.',
        body: `${snap.days_since_gym} days since your last workout. A short session today keeps the streak.`,
        url: '/?tab=gym',
      }));
    }
  }

  // --- 11:30am — First meal nudge ---
  if (h === 11) {
    if (snap && (snap.meals_logged ?? 0) === 0) {
      results.push(await sendPush({
        title: 'No meals logged yet.',
        body: 'Starting with a protein-first meal sets your macro pace for the day.',
        url: '/?tab=health',
      }));
    }
  }

  // --- 12:00pm — Dynamic JARVIS pulse ---
  if (h === 12) {
    const pulse = await buildJarvisPulse(snap, h);
    if (pulse) {
      results.push(await sendPush({
        title: 'JARVIS — midday check-in',
        body: pulse,
        url: '/?tab=jarvis',
      }));
    }
  }

  // --- 14:00 — Afternoon caffeine gate ---
  if (h === 14) {
    const activeMg = snap?.caffeine_mg ?? null;
    if (activeMg !== null) {
      const optimal = activeMg >= 40 && activeMg <= 200;
      results.push(await sendPush({
        title: optimal ? 'Caffeine in optimal zone.' : 'Caffeine check.',
        body: optimal
          ? `${activeMg}mg active — you're in the focus zone. A top-up after 2pm will affect sleep.`
          : activeMg < 40
          ? `Only ${activeMg}mg caffeine active. Afternoon dip incoming — walk + water beats another coffee.`
          : `${activeMg}mg still active — above optimal. Skip the afternoon coffee to protect sleep.`,
        url: '/?tab=health',
      }));
    }
  }

  // --- 15:00 — Macro checkpoint ---
  if (h === 15) {
    const protein = snap?.protein_g ?? null;
    const target  = snap?.protein_target_g ?? 150;
    if (protein !== null && protein < target * 0.4) {
      results.push(await sendPush({
        title: 'Macro check.',
        body: `${protein}g protein logged — ${target - protein}g still to go. Dinner is your biggest lever now.`,
        url: '/?tab=health',
      }));
    }
  }

  // --- 17:00 — Daily spend pulse ---
  if (h === 17) {
    if (snap?.daily_spend != null && snap?.daily_spend_avg != null) {
      const over = snap.daily_spend > snap.daily_spend_avg * 1.3;
      results.push(await sendPush({
        title: over ? 'Spend running high today.' : 'Daily spend pulse.',
        body: over
          ? `You've spent ${snap.daily_spend} today — ${Math.round((snap.daily_spend / snap.daily_spend_avg - 1) * 100)}% above your daily average.`
          : `Today's spend: ${snap.daily_spend}. Tracking close to your daily average.`,
        url: '/?tab=finance',
      }));
    }
  }

  // --- 19:00 — Dynamic JARVIS evening pulse ---
  if (h === 19) {
    const pulse = await buildJarvisPulse(snap, h);
    if (pulse) {
      results.push(await sendPush({
        title: 'JARVIS — evening review',
        body: pulse,
        url: '/?tab=jarvis',
      }));
    }
  }

  // --- 20:00 — Caffeine sleep impact warning ---
  if (h === 20) {
    const activeMg = snap?.caffeine_mg ?? 0;
    if (activeMg > 30) {
      results.push(await sendPush({
        title: 'Caffeine still active.',
        body: `${activeMg}mg caffeine still in your system. Sleep quality may be affected — log your sleep time.`,
        url: '/?tab=health',
      }));
    }
  }

  // --- 21:00 — Journal streak ---
  if (h === 21) {
    if (snap && !snap.journal_written) {
      results.push(await sendPush({
        title: 'Journal streak at risk.',
        body: 'You haven\'t written today. It resets at midnight — takes 2 minutes.',
        url: '/?tab=main',
      }));
    }
  }

  return results;
}

export default async function handler(req, res) {
  // Only allow Vercel cron or a secret token for manual testing
  const auth = req.headers['authorization'];
  const cronHeader = req.headers['x-vercel-cron'];
  if (!cronHeader && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const results = await handleCron();
    return res.status(200).json({ ok: true, sent: results.length, results });
  } catch (err) {
    console.error('notify error:', err);
    return res.status(500).json({ error: err.message });
  }
}
