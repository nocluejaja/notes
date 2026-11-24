// Extra market drivers for the dashboard + alerts. Every function fails soft (returns null).
const UA = { "User-Agent": "Mozilla/5.0 (compatible; notes-checker/1.0)" };
async function text(url) { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(url + " -> " + r.status); return r.text(); }
async function json(url) { return JSON.parse(await text(url)); }

// Weekly closes (weeks end Sunday 23:59 UTC) from daily [ms, close] rows, oldest first.
export function weekly(daily) {
  const weeks = new Map();
  for (const [ms, close] of daily) {
    const dt = new Date(ms), dow = (dt.getUTCDay() + 6) % 7; // Mon=0
    const monday = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - dow)).toISOString().slice(0, 10);
    weeks.set(monday, { week: monday, close, lastDay: dow });
  }
  const all = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
  const done = all.filter((w) => w.lastDay === 6);
  let streak = 0, dir = null;
  for (let i = done.length - 1; i > 0; i--) {
    const d = done[i].close < done[i - 1].close ? "red" : "green";
    if (dir === null) dir = d;
    if (d !== dir) break;
    streak++;
  }
  const last = done.slice(-9).map((w, i, arr) => ({ week: w.week, close: Math.round(w.close), chg: i ? w.close / arr[i - 1].close - 1 : null })).slice(-8);
  return { streak, dir, weeks: last, latest: done[done.length - 1]?.week };
}

// Spot BTC ETF daily net flows (US$ millions) from Farside's public table.
export async function etfFlows() {
  try {
    const html = await text("https://farside.co.uk/bitcoin-etf-flow-all-data/");
    const rows = [];
    const re = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let m;
    while ((m = re.exec(html))) {
      const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((x) => x[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
      if (cells.length < 3 || !/^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(cells[0])) continue;
      const raw = cells[cells.length - 1].replace(/,/g, "");
      if (raw === "" || raw === "-") continue;
      const v = /^\(.*\)$/.test(raw) ? -parseFloat(raw.slice(1, -1)) : parseFloat(raw);
      if (!isNaN(v)) rows.push({ date: new Date(cells[0] + " UTC").toISOString().slice(0, 10), total: v });
    }
    if (!rows.length) { console.log("etf: no rows parsed; first 300 chars:", html.slice(0, 300).replace(/\s+/g, " ")); return null; }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const last5 = rows.slice(-5);
    return { days: last5, sum5: last5.reduce((a, r) => a + r.total, 0), latest: rows[rows.length - 1] };
  } catch (e) { console.log("etf failed:", e.message); return null; }
}

// Nasdaq-100 vs BTC: day move and 30-day correlation of daily returns.
export async function techLink(daily) {
  try {
    const csv = await text("https://stooq.com/q/d/l/?s=%5Endx&i=d");
    const ndx = new Map(csv.trim().split("\n").slice(1).map((l) => l.split(",")).filter((c) => c.length >= 5 && !isNaN(+c[4])).map((c) => [c[0], +c[4]]));
    if (ndx.size < 40) { console.log("tech: too little data:", csv.slice(0, 120)); return null; }
    const btc = new Map(daily.map(([ms, c]) => [new Date(ms).toISOString().slice(0, 10), c]));
    const dates = [...ndx.keys()].filter((d) => btc.has(d)).sort();
    const pairs = [];
    for (let i = 1; i < dates.length; i++) pairs.push([ndx.get(dates[i]) / ndx.get(dates[i - 1]) - 1, btc.get(dates[i]) / btc.get(dates[i - 1]) - 1]);
    const p = pairs.slice(-30), n = p.length;
    const mx = p.reduce((a, x) => a + x[0], 0) / n, my = p.reduce((a, x) => a + x[1], 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
    const nd = [...ndx.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const [lastD, lastV] = nd[nd.length - 1], prevV = nd[nd.length - 2][1], wkV = nd[nd.length - 6][1], moV = nd[Math.max(0, nd.length - 22)][1];
    const bLast = pairs.length ? pairs[pairs.length - 1] : [null, null];
    return { date: lastD, ndxDay: lastV / prevV - 1, ndxWeek: lastV / wkV - 1, ndxMonth: lastV / moV - 1, btcDay: bLast[1], corr30: sxy / Math.sqrt(sxx * syy) };
  } catch (e) { console.log("tech failed:", e.message); return null; }
}

// Perpetual futures funding rate (per 8h). Positive = longs pay (bullish crowd), negative = shorts pay.
export async function funding() {
  const tries = [
    async () => { const d = (await json("https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=21")).data; return { src: "OKX", rates: d.map((x) => +x.realizedRate || +x.fundingRate).reverse() }; },
    async () => { const d = (await json("https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=21")).result.list; return { src: "Bybit", rates: d.map((x) => +x.fundingRate).reverse() }; },
    async () => { const d = await json("https://www.bitmex.com/api/v1/funding?symbol=XBTUSD&count=21&reverse=true"); return { src: "BitMEX", rates: d.map((x) => +x.fundingRate).reverse() }; }
  ];
  for (const t of tries) {
    try { const r = await t(); if (r.rates.length >= 3 && r.rates.every((x) => !isNaN(x))) {
      const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
      return { src: r.src, last: r.rates[r.rates.length - 1], avg1d: avg(r.rates.slice(-3)), avg7d: avg(r.rates) };
    } } catch (e) { console.log("funding try failed:", e.message); }
  }
  return null;
}
