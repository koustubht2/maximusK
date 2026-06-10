// Proxies Yahoo Finance v8 chart endpoint — no API key needed
export default async function handler(req, res) {
  const symbols = ['^NSEI', '^BSESN', 'BTC-USD', 'GC=F', 'USDINR=X'];
  const labels  = ['NIFTY', 'SENSEX', 'BTC', 'GOLD', 'USD/INR'];

  try {
    const results = await Promise.all(symbols.map(async (sym, i) => {
      try {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const d = await r.json();
        const meta = d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
        if (!meta) return { label: labels[i], price: null, change: null };
        const price  = meta.regularMarketPrice;
        const prev   = meta.chartPreviousClose || meta.previousClose;
        const change = prev ? ((price - prev) / prev * 100) : null;
        return { label: labels[i], price, change: change ? +change.toFixed(2) : null, currency: meta.currency };
      } catch(e) {
        return { label: labels[i], price: null, change: null };
      }
    }));
    res.setHeader('Cache-Control', 's-maxage=300');
    res.status(200).json({ tickers: results, ts: Math.floor(Date.now() / 1000) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
