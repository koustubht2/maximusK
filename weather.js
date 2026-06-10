export default async function handler(req, res) {
  const { lat, lng } = req.query;
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENWEATHER_API_KEY not set' });

  const [weatherRes, aqiRes] = await Promise.all([
    fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${key}`),
    fetch(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lng}&appid=${key}`)
  ]);

  const weather = await weatherRes.json();
  const aqi     = await aqiRes.json();

  if (!weatherRes.ok) return res.status(weatherRes.status).json({ error: weather.message });

  const w = weather;
  const aqiIndex = aqi.list && aqi.list[0] && aqi.list[0].main && aqi.list[0].main.aqi;
  const aqiLabel = ['','Good','Fair','Moderate','Poor','Very Poor'][aqiIndex] || 'Unknown';

  res.status(200).json({
    temp:        Math.round(w.main.temp),
    feels_like:  Math.round(w.main.feels_like),
    humidity:    w.main.humidity,
    wind_kph:    Math.round((w.wind && w.wind.speed || 0) * 3.6),
    description: w.weather && w.weather[0] && w.weather[0].description || '',
    icon:        w.weather && w.weather[0] && w.weather[0].main || '',
    city:        w.name || '',
    sunrise:     w.sys && w.sys.sunrise,
    sunset:      w.sys && w.sys.sunset,
    aqi:         aqiIndex || 0,
    aqi_label:   aqiLabel
  });
}
