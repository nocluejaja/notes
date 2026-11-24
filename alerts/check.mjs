// Hourly checker: sends push notifications to the home-screen app. Read-only - never trades.
// Runs on GitHub Actions. Sends web push to the home-screen app (PUSH_SUB + VAPID_PRIVATE secrets).
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { weekly, etfFlows, techLink, funding } from "./drivers.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
for (const f of ["lib/cycles.js", "lib/forecast.js"]) vm.runInThisContext(fs.readFileSync(path.join(here, f), "utf8"));

const STATE = path.join(here, "state.json");
const MARKET = path.join(here, "market.json");
const CONFIG = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));
const PUSH_SUB = process.env.PUSH_SUB;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_PUBLIC = "BAsCDleygp5gr1UpTYrC9mAy2FgxzCRNb5q1CwSmBo777ANXFPy0XGP2l-UbBzgrk7FWqkms7mboxAEuqlPZel8";
let webpush = null;
if (PUSH_SUB && VAPID_PRIVATE) {
  try {
    const { createRequire } = await import("node:module");
    webpush = createRequire(import.meta.url)("web-push");
    webpush.setVapidDetails(CONFIG.appUrl, VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (e) { console.log("web-push unavailable:", e.message); webpush = null; }
}
const DRY = process.env.DRY_RUN === "1";
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "btc-cycle-checker" } });
  if (!r.ok) throw new Error(url + " -> " + r.status);
  return r.json();
}

async function push(title, message, tags = [], priority = 3) {
  console.log("NOTIFY:", title, "|", message);
  if (DRY) return;
  if (webpush) {
    try {
      await webpush.sendNotification(JSON.parse(PUSH_SUB), JSON.stringify({ title, body: message, url: CONFIG.appUrl }), { TTL: 6 * 3600, urgency: priority >= 4 ? "high" : "normal" });
      console.log("web push sent");
    } catch (e) { console.log("web push failed:", e.statusCode, e.body || e.message, e.statusCode === 410 ? "(subscription expired - tap Enable notifications again and update PUSH_SUB)" : ""); }
  }
}

// Daily closes for ~1 year from Coinbase (two 300-candle pages), oldest first.
async function dailyHistory() {
  const base = "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400";
  const end = Date.now(), DAYMS = 86400000;
  const pages = [];
  for (let k = 0; k < 5; k++) pages.push([end - (299 + 300 * k) * DAYMS, end - 300 * k * DAYMS]);
  const rows = [];
  for (const [a, b] of pages) {
    const data = await getJSON(`${base}&start=${new Date(a).toISOString()}&end=${new Date(b).toISOString()}`);
    rows.push(...data);
  }
  const byDay = new Map(rows.map((r) => [r[0] * 1000, r[4]])); // [time, low, high, open, close, vol]
  return [...byDay.entries()].sort((x, y) => x[0] - y[0]);
}

const s = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const first = !s.cycle;
s.cycle = s.cycle || { ...CURRENT_DEFAULT };

const price = parseFloat((await getJSON("https://api.coinbase.com/v2/prices/BTC-USD/spot")).data.amount);
const all = await dailyHistory();
const year = all.slice(-365);
const ma200w = all.length >= 1400 ? all.slice(-1400).reduce((a, p) => a + p[1], 0) / 1400 : null;
let fng = null;
try { const f = (await getJSON("https://api.alternative.me/fng/?limit=2")).data; fng = { value: +f[0].value, label: f[0].value_classification, prev: +f[1].value, at: +f[0].timestamp * 1000 }; } catch (e) { console.log("fng failed", e.message); }
const ma365 = year.reduce((a, p) => a + p[1], 0) / year.length;
const history = year.slice(-120);

const now = new Date(), today = now.toISOString().slice(0, 10), c = s.cycle;
let newLow = false;
if (price > c.peak) { c.peak = price; c.peakDate = today; c.low = price; c.lowDate = today; }
else if (price < c.low) { c.low = price; c.lowDate = today; newLow = true; }

const daysSincePeak = daysBetween(d(c.peakDate), now);
const drawdown = price / c.peak - 1;
const value = valueScore({ price, daysSincePeak, drawdown }).score;
const t = trendScore({ price, ma365, history });
const trend = t ? t.score : null;
const sig = marketSignal({ price, daysSincePeak, drawdown, ma365, value, trend, t });
const line = `${money(price)} · ${sig.met}/6 conditions`;
console.log(line, "| value", value, "trend", trend, "|", sig.label);

if (process.env.TEST === "1") await push("Test alert ✓", `Right now: ${sig.label}. ${line}`, ["bell"]);
if (first) await push("BTC alerts connected ✓", `You'll get alerts here. Right now: ${sig.label}. ${line}`, ["white_check_mark"]);

// 1) Signal changed
if (s.lastSignal && s.lastSignal !== sig.key)
  await push(`Signal: ${sig.label}`, `${sig.text}\n${line}\nNever places orders - you decide.`, ["rotating_light"], 4);
s.lastSignal = sig.key;

// 2) Trend crosses 40
if (trend != null) {
  const up = trend >= 40;
  if (s.trendUp === false && up) await push("Trend crossed 40 ↑", `The downtrend may be turning. ${line}`, ["chart_with_upwards_trend"], 4);
  if (s.trendUp === true && !up) await push("Trend fell below 40 ↓", `Momentum faded again. ${line}`, ["chart_with_downwards_trend"]);
  s.trendUp = up;
}

// 3) Price levels crossed
s.levels = s.levels || {};
for (const lvl of CONFIG.levels) {
  const above = price >= lvl;
  const was = s.levels[lvl];
  if (was === true && !above) await push(`BTC fell below ${money(lvl)}`, line, ["small_red_triangle_down"], 4);
  if (was === false && above) await push(`BTC rose above ${money(lvl)}`, line, ["small_red_triangle"], 4);
  s.levels[lvl] = above;
}
if (newLow && !first) await push(`New cycle low: ${money(price)}`, `Lowest since the ${money(c.peak)} top (${(drawdown * 100).toFixed(0)}%). ${line}`, ["warning"]);

// Extra drivers
const wk = weekly(all);
const [etf, tech, fund] = await Promise.all([etfFlows(), techLink(all), funding()]);
const ord = (n) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

// 3a) Sunday weekly close summary
if (wk.latest && s.lastWeekReported !== wk.latest) {
  const w = wk.weeks[wk.weeks.length - 1];
  if (s.lastWeekReported && w && w.chg != null)
    await push(`Week closed ${money(w.close)} (${(w.chg * 100).toFixed(1)}%)`,
      `${ord(wk.streak)} ${wk.dir} week in a row.` + (wk.dir === "red" && wk.streak >= 6 ? " Long red streaks have ended near bottoms before." : "") + ` Right now: ${sig.label}. ${line}`, ["calendar"]);
  s.lastWeekReported = wk.latest;
}

// 3d) Buy-day reminder (no amounts sent - the plan lives on your phone)
if (CONFIG.buyDay) {
  const ct = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const dayName = ct.toLocaleDateString("en-US", { weekday: "long" });
  const key = ct.toDateString();
  if (dayName === CONFIG.buyDay.weekday && ct.getHours() >= CONFIG.buyDay.hourCT && s.buyDaySent !== key) {
    await push("Buy day", `Your weekly amount is in the app's Buy plan. Right now: ${sig.label}. ${line}. You place any order yourself.`, ["moneybag"]);
    s.buyDaySent = key;
  }
}

// 3e) Near your limit-order levels
s.nearSent = s.nearSent || {};
for (const lvl of CONFIG.orderLevels || []) {
  const dist = price / lvl - 1, near = dist >= 0 && dist <= (CONFIG.orderNearPct || 2) / 100;
  if (near && !s.nearSent[lvl]) await push(`Near your ${money(lvl)} level`, `BTC is ${(dist * 100).toFixed(1)}% above it. Right now: ${sig.label}. ${line}`, ["dart"], 4);
  s.nearSent[lvl] = near || (s.nearSent[lvl] && dist <= 0.05); // re-arm after moving 5% away
}

// 3f) Big ETF flow day
if (etf && etf.latest && s.etfSeen !== etf.latest.date) {
  if (s.etfSeen && Math.abs(etf.latest.total) >= (CONFIG.etfAlertUsdM || 500))
    await push(`ETF ${etf.latest.total < 0 ? "outflow" : "inflow"}: $${Math.abs(etf.latest.total).toFixed(0)}M`, `Spot BTC ETFs on ${etf.latest.date}. 5-day total: ${etf.sum5 >= 0 ? "+" : "−"}$${Math.abs(etf.sum5).toFixed(0)}M. ${line}`, ["bank"]);
  s.etfSeen = etf.latest.date;
}

// 3g) Funding turns negative / positive (3 readings ≈ 1 day)
if (fund) {
  const neg = fund.avg1d < 0;
  if (s.fundNeg === false && neg) await push("Traders now betting on a drop", `Funding turned negative (${(fund.avg1d * 100).toFixed(4)}%). Crowded short bets have often come near bottoms. ${line}`, ["scales"]);
  if (s.fundNeg === true && !neg) await push("Funding back positive", `Traders are leaning long again. ${line}`, ["scales"]);
  s.fundNeg = neg;
}

// 3b) Fear & Greed extremes
if (fng) {
  const [lo, hi] = CONFIG.fearGreedAlerts || [20, 80];
  const zone = fng.value <= lo ? "fear" : fng.value >= hi ? "greed" : "mid";
  if (s.fngZone && s.fngZone !== zone && zone !== "mid")
    await push(zone === "fear" ? `Extreme Fear: ${fng.value}/100` : `Extreme Greed: ${fng.value}/100`,
      (zone === "fear" ? "Crowd panic. Past bear-market lows often came with readings this low." : "Crowd euphoria. Past cycle tops came with readings this high.") + ` ${line}`, ["thermometer"]);
  s.fngZone = zone;
}

// 3c) Event reminders (~1 day before)
s.eventsSent = s.eventsSent || [];
for (const e of CONFIG.events || []) {
  const ms = Date.parse(e.date) - Date.now();
  if (ms > 0 && ms < 26 * 3600e3 && !s.eventsSent.includes(e.date + e.name)) {
    await push(`Tomorrow: ${e.name}`, `${new Date(e.date).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" })} CT. Big data/Fed days often move BTC sharply both ways. ${line}`, ["date"]);
    s.eventsSent.push(e.date + e.name);
  }
}
s.eventsSent = s.eventsSent.slice(-40);

// 4) Weekly forecast journal (graded every 7 days)
const j = s.journal || { k: 1.0, entries: [] };
const open = j.entries.find((e) => !e.graded);
if (open && Date.now() >= open.dueAt) {
  const g = gradeForecast(open, { price, history, value, trend, ma365 });
  j.entries[j.entries.indexOf(open)] = g;
  j.k = recalibrate(j.k, j.entries.filter((e) => e.graded));
  const gd = j.entries.filter((e) => e.graded), hits = gd.filter((e) => e.hit).length;
  await push(g.hit ? "Weekly forecast: HIT ✓" : "Weekly forecast: MISS ✗", `${g.why}\nTrack record: ${hits}/${gd.length} weeks in range.`, ["calendar"]);
}
if (!j.entries.find((e) => !e.graded)) {
  const f = makeForecast({ price, history, k: j.k, trend, value, ma365 });
  if (j.entries.length === 0) { f.note = SEED_NOTE; f.rLow = CONFIG.researchRange?.[0]; f.rHigh = CONFIG.researchRange?.[1]; }
  // Attach the latest Sunday research (alerts/research.json) if it's from the last 3 days
  try {
    const r = JSON.parse(fs.readFileSync(path.join(here, "research.json"), "utf8"));
    if (Date.now() - Date.parse(r.date) < 3 * 86400e3 && r.low < r.high) { f.rLow = r.low; f.rHigh = r.high; f.note = r.summary; }
  } catch (e) {}
  j.entries.push(f);
  if (!first) await push("New weekly forecast", `${money(f.low)} – ${money(f.high)} by ${new Date(f.dueAt).toDateString()} · lean ${f.direction}`, ["crystal_ball"]);
}
j.entries = j.entries.slice(-104);
s.journal = j;
s.lastRun = now.toISOString(); s.lastPrice = price;

// Shared market data for the dashboard (read from raw.githubusercontent.com)
const market = { updated: today, ma200w, fng, weekly: wk, etf, tech, funding: fund, buyDay: CONFIG.buyDay, orderLevels: CONFIG.orderLevels, events: (CONFIG.events || []).filter((e) => Date.parse(e.date) > Date.now() - 86400e3).slice(0, 6) };
const prevMarket = fs.existsSync(MARKET) ? fs.readFileSync(MARKET, "utf8") : "";
const mJson = JSON.stringify(market, null, 1);
const strip = (x) => x.replace(/"updated": "[^"]*",?/, "");
if (strip(prevMarket) !== strip(mJson) || !prevMarket.includes(today)) fs.writeFileSync(MARKET, mJson);

// Only keep "lastRun/lastPrice" out of the diff check so we don't commit every hour.
const { lastRun, lastPrice, ...meaningful } = s;
const prev = fs.existsSync(STATE) ? (({ lastRun, lastPrice, ...m }) => m)(JSON.parse(fs.readFileSync(STATE, "utf8"))) : null;
if (!prev || JSON.stringify(prev) !== JSON.stringify(meaningful)) fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
