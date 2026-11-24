// Weekly forecast journal: makes a 7-day price RANGE, grades it a week later,
// explains misses, and recalibrates how wide its ranges are.
// Shared by background.js (importScripts) and popup.html.

const WEEK = 7 * 86400000;
const TARGET_HIT = 0.68; // aim for ~2 of 3 weeks inside the range

// Research saved with the first forecast (from the Nov 22, 2026 review).
const SEED_NOTE =
  "Nov 22 2026 research: BTC hit ~$55.1K on Nov 21 (lowest since Sep 2024), bounced to ~$59-60K. " +
  "Drivers: AI-stock sell-off (Nasdaq erased 2026 gains; heavy Hacker News coverage), record spot-ETF outflows " +
  "(IBIT record single-day redemption), Fed rate-hike fears before the December meeting, ~$2.5B leveraged liquidations. " +
  "Binance $6.3B hack (~Oct 30, compromised DevOps laptop; covered on Security Now #1103) - custody risk, no clear price effect; " +
  "BTC was already falling before it. Security Now #1104/#1105: nothing about Bitcoin itself. " +
  "Watch: Nasdaq/AI stocks, ETF flows, December FOMC, realized price ~$56K.";

function logReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

function makeForecast({ price, history, k, trend, value, ma365 }) {
  const closes = history.map((p) => p[1]).slice(-31);
  const r = logReturns(closes);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
  const weekVol = sd * Math.sqrt(7);
  const half = k * weekVol;
  return {
    madeAt: Date.now(), dueAt: Date.now() + WEEK,
    start: price, low: price * Math.exp(-half), high: price * Math.exp(half),
    weekVol, k,
    direction: trend != null && trend >= 50 ? "up" : "down",
    scoresThen: { value, trend }, ma365Then: ma365 || null,
    note: "", graded: false
  };
}

function gradeForecast(f, { price, history, value, trend, ma365 }) {
  const hit = price >= f.low && price <= f.high;
  const moved = price / f.start - 1;
  const dirOk = (f.direction === "up") === (moved > 0);
  // biggest single-day move inside the forecast week
  const wk = history.filter((p) => p[0] >= f.madeAt - 86400000 && p[0] <= f.dueAt + 86400000);
  let big = 0, bigAt = null;
  for (let i = 1; i < wk.length; i++) {
    const m = wk[i][1] / wk[i - 1][1] - 1;
    if (Math.abs(m) > Math.abs(big)) { big = m; bigAt = wk[i][0]; }
  }
  const p = (x) => (x * 100).toFixed(1) + "%";
  const expected = Math.exp(f.k * f.weekVol) - 1;
  let why;
  if (hit) why = `Stayed inside the expected ±${p(expected)} range (moved ${p(moved)}).`;
  else why = `Moved ${p(moved)} vs expected ±${p(expected)} - ${price > f.high ? "broke above" : "broke below"} the range.`;
  if (bigAt) why += ` Largest one-day move: ${p(big)} on ${new Date(bigAt).toLocaleDateString()}.`;
  if (f.scoresThen.trend != null && trend != null)
    why += ` Trend score ${f.scoresThen.trend} → ${trend}; value score ${f.scoresThen.value} → ${value}.`;
  if (f.ma365Then && ma365) {
    const wasAbove = f.start > f.ma365Then, isAbove = price > ma365;
    if (wasAbove !== isAbove) why += isAbove ? " Price reclaimed the 365-day average." : " Price lost the 365-day average.";
  }
  const rHit = f.rLow && f.rHigh ? price >= f.rLow && price <= f.rHigh : null;
  if (rHit !== null) why += ` Research range ${Math.round(f.rLow).toLocaleString()}-${Math.round(f.rHigh).toLocaleString()}: ${rHit ? "HIT" : "MISS"}.`;
  return { ...f, graded: true, actual: price, hit, rHit, dirOk, moved, why };
}

// Widen ranges after misses, tighten after too many easy hits.
function recalibrate(k, graded) {
  const recent = graded.slice(-8);
  if (recent.length < 4) return k;
  const rate = recent.filter((g) => g.hit).length / recent.length;
  if (rate < TARGET_HIT - 0.1) return Math.min(k * 1.1, 3);
  if (rate > TARGET_HIT + 0.15) return Math.max(k * 0.92, 0.5);
  return k;
}

if (typeof self !== "undefined") {
  self.makeForecast = makeForecast; self.gradeForecast = gradeForecast;
  self.recalibrate = recalibrate; self.SEED_NOTE = SEED_NOTE;
}
