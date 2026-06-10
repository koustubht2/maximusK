export default async function handler(req, res) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return res.status(500).json({ error: 'NEWS_API_KEY not set' });

  // India top headlines + one global business headline
  const [indiaRes, bizRes] = await Promise.all([
    fetch(`https://newsapi.org/v2/top-headlines?country=in&pageSize=3&apiKey=${key}`),
    fetch(`https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=2&apiKey=${key}`)
  ]);

  const india = await indiaRes.json();
  const biz   = await bizRes.json();

  const pick = (arr, n) => (arr || []).slice(0, n).map(a => a.title).filter(Boolean);

  res.status(200).json({
    india:    pick(india.articles, 3),
    business: pick(biz.articles, 2)
  });
}
