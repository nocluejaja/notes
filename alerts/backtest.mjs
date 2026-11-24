// Backtest: replay the dashboard's signal rules on every day of BTC history and
// measure what happened next. Writes alerts/backtest.json for the dashboard.
// Note: historical realized price isn't freely available, so the backtest uses the
// 200-week average in its place for the "realized price" parts of the rules.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
for (const f of ["lib/cycles.js"]) vm.runInThisContext(fs.readFileSync(path.join(here, f), "utf8"));
const OUT = path.join(here, "backtest.json");
const DAYMS = 86400000;

async function history() {
  if (process.env.BT_FIXTURE) return JSON.parse(fs.readFileSync(process.env.BT_FIXTURE, "utf8"));
  // Yahoo daily BTC-USD back to 2014; Coinbase as backup.
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=max&interval=1d", { headers: { "User-Agent": "Mozilla/5.0" } });
    const j = await r.json(), res = j.chart.result[0], cl = res.indicators.quote[0].close;
    const rows = res.timestamp.map((t, i) => [Math.floor(t / 86400) * DAYMS, cl[i]]).filter((x) => x[1] != null);
    if (rows.length > 3000) return rows;
  } catch (e) { console.log("yahoo failed:", e.message); }
  const rows = new Map(), end = Date.now();
  for (let k = 0; k < 16; k++) {
    const b = end - 300 * k * DAYMS, a = b - 299 * DAYMS;
    const r = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(a).toISOString()}&end=${new Date(b).toISOString()}`, { headers: { "User-Agent": "notes" } });
    const d = await r.json(); if (!Array.isArray(d) || !d.length) break;
    d.forEach((c) => rows.set(c[0] * 1000, c[4]));
  }
  return [...rows.entries()].sort((x, y) => x[0] - y[0]);
}

const rows = (await history()).sort((a, b) => a[0] - b[0]);
console.log("days of history:", rows.length, new Date(rows[0][0]).toISOString().slice(0, 10), "→", new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10));
const closes = rows.map((r) => r[1]);
const prefix = [0]; for (const c of closes) prefix.push(prefix[prefix.length - 1] + c);
const avg = (i, n) => (i + 1 >= n ? (prefix[i + 1] - prefix[i + 1 - n]) / n : null);

const days = [];
let ath = 0, athIdx = 0;
for (let i = 0; i < rows.length; i++) {
  const price = closes[i];
  if (price >= ath) { ath = price; athIdx = i; }
  const ma365 = avg(i, 365);
  // 200-week average; before 4 years of data exist, use the average of all data so far (stand-in for realized price).
  const ma200w = avg(i, 1400) || (i >= 365 ? prefix[i + 1] / (i + 1) : null);
  if (!ma365 || !ma200w || i < 120) continue;
  const daysSincePeak = i - athIdx, drawdown = price / ath - 1;
  const history = rows.slice(i - 119, i + 1);
  const value = valueScore({ price, daysSincePeak, drawdown, realized: ma200w }).score;
  const t = trendScore({ price, ma365, history });
  const trend = t ? t.score : null;
  const sig = marketSignal({ price, daysSincePeak, drawdown, ma365, value, trend, t, realized: ma200w });
  const fwd = (n) => (i + n < closes.length ? closes[i + n] / price - 1 : null);
  let low12 = null;
  if (i + 365 < closes.length) { low12 = Infinity; for (let k = i + 1; k <= i + 365; k++) low12 = Math.min(low12, closes[k]); low12 = low12 / price - 1; }
  days.push({ date: new Date(rows[i][0]).toISOString().slice(0, 10), price, key: sig.key, label: sig.label, met: sig.met, r3: fwd(91), r6: fwd(182), r12: fwd(365), dd12: low12 });
}

const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const share = (a) => { const s = a.filter((x) => x != null); return s.length ? s.filter((x) => x > 0).length / s.length : null; };
function summarize(list) {
  const done = list.filter((d) => d.r12 != null);
  return { days: list.length, daysWith12m: done.length, med3: med(list.map((d) => d.r3)), med6: med(list.map((d) => d.r6)), med12: med(list.map((d) => d.r12)), win12: share(list.map((d) => d.r12)), medDrop12: med(list.map((d) => d.dd12)) };
}
const order = ["buy", "scale", "hold", "sell", "avoid"];
const labels = Object.fromEntries(days.map((d) => [d.key, d.label]));
const bySignal = order.filter((k) => labels[k]).map((k) => ({ key: k, label: labels[k], ...summarize(days.filter((d) => d.key === k)) }));
const all = { key: "all", label: "Any day (buy & hold)", ...summarize(days) };

// Episodes: each run of the same signal lasting 7+ days, with what happened from its first day.
const episodes = [];
for (let i = 0; i < days.length; ) {
  let j = i; while (j + 1 < days.length && days[j + 1].key === days[i].key) j++;
  if (j - i + 1 >= 7 && ["buy", "scale", "sell", "avoid"].includes(days[i].key))
    episodes.push({ key: days[i].key, label: days[i].label, start: days[i].date, end: days[j].date, days: j - i + 1, price: Math.round(days[i].price), r6: days[i].r6, r12: days[i].r12, dd12: days[i].dd12 });
  i = j + 1;
}
const today = days[days.length - 1];
// Weekly series of price + zone for the halving-cycle chart
const HALVINGS = ["2016-07-09", "2020-05-11", "2024-04-20"];
const series = days.filter((d, i) => i % 7 === 0 || i === days.length - 1).map((d) => [d.date, Math.round(d.price), d.key]);
const cycles = HALVINGS.map((h, k) => {
  const end = HALVINGS[k + 1] || "9999";
  const inC = days.filter((d) => d.date >= h && d.date < end);
  const counts = {}; inC.forEach((d) => (counts[d.key] = (counts[d.key] || 0) + 1));
  return { halving: h, end: HALVINGS[k + 1] || null, days: inC.length, counts };
});
const out = {
  updated: new Date().toISOString().slice(0, 10), from: days[0].date, to: today.date,
  note: "Same rules as the dashboard, run on every day since " + days[0].date.slice(0, 4) + ". Uses the 200-week average in place of realized price (no free history for it); before 2019 it uses the average of all prices so far. Past results don't guarantee future ones.",
  today: { label: today.label, met: today.met }, all, bySignal, episodes: episodes.slice(-14), halvings: HALVINGS, cycles, series
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const pct = (x) => (x == null ? "  n/a" : (x * 100).toFixed(0).padStart(5) + "%");
for (const r of [...bySignal, all]) console.log(r.label.padEnd(26), "days", String(r.days).padStart(5), "| 6m", pct(r.med6), "| 12m", pct(r.med12), "| up after 12m", pct(r.win12), "| typical drop within 12m", pct(r.medDrop12));
