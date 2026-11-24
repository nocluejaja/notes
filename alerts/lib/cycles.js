// Shared cycle data + math. Loaded by popup.html and background.js.
// Prices are approximate USD (intraday highs/lows). Edit here if you want to tweak.

const DAY = 86400000;

const CYCLES = [
  {
    id: "2016",
    label: "2016 halving → 2017 top",
    halving: "2016-07-09", halvingPrice: 650,
    peakDate: "2017-12-17", peak: 19783,
    bottomDate: "2018-12-15", bottom: 3150,
    sameDayPrice: 3650 // price ~946 days after the halving (Feb 2019)
  },
  {
    id: "2020",
    label: "2020 halving → 2021 top",
    halving: "2020-05-11", halvingPrice: 8600,
    peakDate: "2021-11-10", peak: 69000,
    bottomDate: "2022-11-21", bottom: 15480,
    sameDayPrice: 17800 // ~946 days after the halving (Dec 2022)
  }
];

// The cycle we're in now. Peak/low are updated automatically by background.js
// whenever the live price makes a new high or a new post-peak low.
const CURRENT_DEFAULT = {
  id: "2024",
  label: "2024 halving → 2025 top (now)",
  halving: "2024-04-20", halvingPrice: 64000,
  peakDate: "2025-10-06", peak: 126200,
  lowDate: "2026-11-21", low: 55100
};

const NEXT_HALVING_BLOCK = 1050000;
const NEXT_HALVING_FALLBACK = "2028-04-15";

function d(s) { return new Date(s + "T00:00:00Z"); }
function daysBetween(a, b) { return Math.round((b - a) / DAY); }

function enrich(c) {
  const h = d(c.halving), p = d(c.peakDate), b = d(c.bottomDate);
  return {
    ...c,
    haltToPeak: daysBetween(h, p),
    peakToBottom: daysBetween(p, b),
    haltToBottom: daysBetween(h, b),
    drawdown: c.bottom / c.peak - 1,
    peakMultiple: c.peak / c.halvingPrice
  };
}

// Plain-English read of where we are, based on what happened at the same
// point in past cycles. Descriptive, NOT a buy/sell instruction.
function cyclePhase({ daysSincePeak, drawdown, aboveMA365 }) {
  if (daysSincePeak <= 3 && drawdown > -0.05)
    return { key: "discovery", color: "#16a34a", name: "New highs / price discovery",
      note: "Price is at or near its all-time high. Past cycle tops came ~526–548 days after a halving." };
  if (aboveMA365 === true && daysSincePeak > 300)
    return { key: "recovery", color: "#22c55e", name: "Recovery",
      note: "Back above the 365-day average after a long bear. In 2019 and 2023 this marked the end of the bear market." };
  if (daysSincePeak < 180)
    return { key: "early-bear", color: "#ef4444", name: "Early bear market",
      note: "Within 6 months of the top. Historically the steepest declines were still ahead at this stage." };
  if (daysSincePeak < 330)
    return { key: "mid-bear", color: "#f97316", name: "Mid bear market",
      note: "Past bears kept grinding lower for several more months from here." };
  if (daysSincePeak <= 420)
    return { key: "bottom-window", color: "#eab308", name: "Historical bottoming window",
      note: "Past cycle lows came 363 (2018) and 376 (2022) days after the top. This window is where they formed." };
  return { key: "late", color: "#a855f7", name: "Past the usual bottom timing",
    note: "Longer than any past bear lasted. Either the bottom is in, or this cycle is breaking the pattern." };
}

// Realized price = average price at which all coins last moved (CryptoQuant ~ $56K, Nov 2026).
// Past bear-market lows formed at or below it. Update occasionally.
const REALIZED_PRICE = 56000;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// VALUE score: how closely today resembles past cycle BOTTOMS (100) vs TOPS (0).
function valueScore({ price, daysSincePeak, drawdown, realized = REALIZED_PRICE }) {
  let t;
  if (daysSincePeak < 180) t = 0;
  else if (daysSincePeak < 330) t = (daysSincePeak - 180) / 150;
  else if (daysSincePeak <= 450) t = 1;
  else t = Math.max(0.5, 1 - (daysSincePeak - 450) / 300);
  const parts = {
    timing: t * 35,                                        // past lows: 363-376 days after top
    depth: clamp01(-drawdown / 0.8) * 35,                  // past lows: -77% to -84%
    realized: clamp01((1.5 - price / realized) / 0.5) * 30 // at/below realized price = 30
  };
  return { score: Math.round(parts.timing + parts.depth + parts.realized), parts };
}

// TREND score: has the downtrend turned? 100 = strong uptrend, 0 = strong downtrend.
function trendScore({ price, ma365, history }) {
  if (!ma365 || !history || history.length < 50) return null;
  const closes = history.map((p) => p[1]);
  const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const ago30 = closes[closes.length - 31] || closes[0];
  const chg30 = price / ago30 - 1;
  const parts = {
    ma365: clamp01((price / ma365 - 0.7) / 0.3) * 40,  // reclaiming the 365d avg ended past bears
    ma50: clamp01((price / ma50 - 0.85) / 0.15) * 30,
    momentum: clamp01((chg30 + 0.2) / 0.4) * 30
  };
  return { score: Math.round(parts.ma365 + parts.ma50 + parts.momentum), parts, ma50, chg30 };
}

// Plain-language signal from both scores + a 6-point checklist.
// It is a rule applied to history, NOT an order and NOT advice. Nothing here can trade.
function marketSignal({ price, daysSincePeak, drawdown, ma365, value, trend, t, realized = REALIZED_PRICE }) {
  const checks = [
    ["Bear market at least ~11 months old", daysSincePeak >= 330, "past lows: 12 months after the top"],
    ["Down 50%+ from the top", drawdown <= -0.5, "past lows: -77% to -84%"],
    ["Within 10% of realized price (~$" + Math.round(realized / 1000) + "K)", price <= realized * 1.1, "where past lows formed"],
    ["Above its 50-day average", t ? price > t.ma50 : null, "short-term trend turning"],
    ["Above its 365-day average", ma365 ? price > ma365 : null, "ended the last two bears"],
    ["Up over the last 30 days", t ? t.chg30 > 0 : null, "momentum"]
  ];
  const met = checks.filter((c) => c[1] === true).length;
  let s;
  if (trend == null) s = { key: "wait", label: "LOADING", color: "#6b7280", text: "Waiting for price history." };
  else if (value >= 70 && trend >= 40) s = { key: "buy", label: "BUY ZONE", color: "#16a34a",
    text: "Cheap vs history AND the trend has turned up. In past cycles this was the strongest time to buy." };
  else if (value >= 70) s = { key: "scale", label: "EARLY — SMALL BUYS ONLY", color: "#ca8a04",
    text: "Cheap vs history but still falling. Past cycles dropped another 15–30% from here first. If buying at all, small amounts spread over weeks. Wait for Trend 40+ for the stronger signal." };
  else if (value < 40 && trend >= 60) s = { key: "sell", label: "TAKE-PROFIT ZONE", color: "#ea580c",
    text: "Expensive vs history with a hot uptrend. Past cycle tops formed here — the time to sell in pieces, not buy." };
  else if (value < 40) s = { key: "avoid", label: "SELL / AVOID", color: "#dc2626",
    text: "Expensive vs history and the trend is rolling over. Historically the worst time to buy." };
  else s = { key: "hold", label: "HOLD / WAIT", color: "#6b7280",
    text: "No clear edge either way. History says sit tight." };
  return { ...s, checks, met };
}

if (typeof self !== "undefined") {
  self.marketSignal = marketSignal;
  self.REALIZED_PRICE = REALIZED_PRICE; self.valueScore = valueScore; self.trendScore = trendScore;
  self.CYCLES = CYCLES; self.CURRENT_DEFAULT = CURRENT_DEFAULT; self.enrich = enrich;
  self.cyclePhase = cyclePhase; self.d = d; self.daysBetween = daysBetween;
  self.NEXT_HALVING_BLOCK = NEXT_HALVING_BLOCK; self.NEXT_HALVING_FALLBACK = NEXT_HALVING_FALLBACK;
}
