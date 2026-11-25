const express = require('express');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const INSTRUMENTS = {
  "XAU/USD": {
    symbol: "XAU/USD",
    decimals: 2,
    intervalM15: "15min",
    intervalH1: "1h",
    scoreThreshold: 4.0,
    relaxedScoreThreshold: 5.0,
    slAtrMult: 1.5,
    rrRatio: 1.6,
    cacheSeconds: 90,
    sessionStartUtc: 7,
    sessionEndUtc: 20,
    contractSize: 100
  }
};

const cachedMarketBySymbol = {};
const cachedAtMsBySymbol = {};
const historyFile = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'history.json')
  : path.join(__dirname, 'history.json');

function roundTo(num, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(num * factor) / factor;
}

async function loadHistory() {
  try {
    const data = await fs.readFile(historyFile, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveHistory(symbol, history) {
  const all = await loadHistory();
  all[symbol] = history;
  await fs.writeFile(historyFile, JSON.stringify(all, null, 2));
}

async function getHistory(symbol) {
  const all = await loadHistory();
  return all[symbol] || [];
}

function calcSMA(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function calcEMA(values, period) {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(values, period = 14) {
  if (values.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMACD(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (values.length < slow + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
  let ef = values[0], es = values[0];
  const kFast = 2 / (fast + 1), kSlow = 2 / (slow + 1);
  const macdLine = [];
  for (let i = 0; i < values.length; i++) {
    ef = values[i] * kFast + ef * (1 - kFast);
    es = values[i] * kSlow + es * (1 - kSlow);
    macdLine.push(ef - es);
  }
  let signal = macdLine[0];
  const kSignal = 2 / (signalPeriod + 1);
  for (let i = 1; i < macdLine.length; i++) {
    signal = macdLine[i] * kSignal + signal * (1 - kSignal);
  }
  const currentMacd = macdLine[macdLine.length - 1];
  return { macd: currentMacd, signal, histogram: currentMacd - signal };
}

function calcATRSeries(candles, period = 14) {
  const trs = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) trs.push(c.high - c.low);
    else {
      const prevClose = candles[i - 1].close;
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
    }
  }
  const atrSeries = [];
  let atr = calcSMA(trs.slice(0, period));
  for (let i = 0; i < trs.length; i++) {
    if (i < period) atrSeries.push(atr);
    else {
      atr = (atr * (period - 1) + trs[i]) / period;
      atrSeries.push(atr);
    }
  }
  return atrSeries;
}

let lastApiCall = 0;
const MIN_API_INTERVAL_MS = 8000;

async function fetchTwelveDataCandles(apiKey, symbol, interval) {
  const now = Date.now();
  if (now - lastApiCall < MIN_API_INTERVAL_MS) {
    throw new Error("Rate limit: Çok sık istek.");
  }
  lastApiCall = now;
  const endpoint = `https://api.twelvedata.com/time_series?symbol=\( {encodeURIComponent(symbol)}&interval= \){interval}&outputsize=80&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(endpoint);
  const json = await res.json();
  if (!res.ok || !Array.isArray(json.values) || json.values.length === 0) {
    throw new Error(`Twelve Data hatası: ${json?.message || json?.code || res.status}`);
  }
  return json.values.map(v => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close)
  })).reverse();
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
    });
    return res.ok;
  } catch { return false; }
}

function updateOpenTrades(history, currentPrice) {
  return history.map(trade => {
    if (trade.status !== "OPEN") return trade;
    if (trade.side === "BUY") {
      if (currentPrice >= trade.tp) return { ...trade, status: "TP", exitPrice: currentPrice, closedAt: new Date().toISOString() };
      if (currentPrice <= trade.sl) return { ...trade, status: "SL", exitPrice: currentPrice, closedAt: new Date().toISOString() };
    } else if (trade.side === "SELL") {
      if (currentPrice <= trade.tp) return { ...trade, status: "TP", exitPrice: currentPrice, closedAt: new Date().toISOString() };
      if (currentPrice >= trade.sl) return { ...trade, status: "SL", exitPrice: currentPrice, closedAt: new Date().toISOString() };
    }
    return trade;
  });
}

async function evaluateMarket(cfg, sizing = {}) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error("TWELVE_DATA_API_KEY tanımlı değil");

  const sym = cfg.symbol;
  const dec = cfg.decimals;
  const nowMs = Date.now();
  const cacheTtlMs = cfg.cacheSeconds * 1000;

  let m15Candles, h1Candles;
  const cached = cachedMarketBySymbol[sym];
  if (cached && nowMs - (cachedAtMsBySymbol[sym] || 0) < cacheTtlMs) {
    m15Candles = cached.m15Candles;
    h1Candles = cached.h1Candles;
  } else {
    m15Candles = await fetchTwelveDataCandles(apiKey, sym, cfg.intervalM15);
    h1Candles = await fetchTwelveDataCandles(apiKey, sym, cfg.intervalH1);
    cachedMarketBySymbol[sym] = { m15Candles, h1Candles };
    cachedAtMsBySymbol[sym] = nowMs;
  }

  const latestM15 = m15Candles[m15Candles.length - 1];
  const price = latestM15.close;

  const atrSeries = calcATRSeries(m15Candles, 14);
  const atr = atrSeries[atrSeries.length - 1];
  const sma20Atr = calcSMA(atrSeries.slice(-20));
  const volThreshold = roundTo(sma20Atr * 0.95, dec);
  const volOk = atr >= volThreshold;

  const h1Closes = h1Candles.map(c => c.close);
  const ema21H1 = calcEMA(h1Closes, 21);
  const ema50H1 = calcEMA(h1Closes, 50);
  const macdH1 = calcMACD(h1Closes);

  let h1Trend = "NEUTRAL", h1Aligned = false, directionHint = null;
  if (ema21H1 > ema50H1 && macdH1.histogram > 0) {
    h1Trend = "BULLISH"; h1Aligned = true; directionHint = "BUY";
  } else if (ema21H1 < ema50H1 && macdH1.histogram < 0) {
    h1Trend = "BEARISH"; h1Aligned = true; directionHint = "SELL";
  }

  const m15Closes = m15Candles.map(c => c.close);
  const ema9M15 = calcEMA(m15Closes, 9);
  const ema21M15 = calcEMA(m15Closes, 21);
  const rsi14 = calcRSI(m15Closes, 14);
  const macdM15 = calcMACD(m15Closes);

  const prevLookback = m15Candles[Math.max(0, m15Candles.length - 4)].close;
  const last3Change = (price - prevLookback) / Math.max(atr, 0.0001);
  const absMom = Math.min(2.5, Math.max(0, Math.abs(last3Change) * 1.4));
  const emaSpreadScore = Math.min(1.5, Math.abs(ema9M15 - ema21M15) / Math.max(atr * 0.25, 0.0001));
  const rsiScore = rsi14 > 55 || rsi14 < 45 ? 1.0 : 0.4;
  const macdScore = Math.abs(macdM15.histogram) > 0 ? 1.0 : 0.0;
  const score = +(absMom + emaSpreadScore + rsiScore + macdScore).toFixed(1);

  if (!directionHint) directionHint = price < ema21M15 || rsi14 < 50 ? "SELL" : "BUY";

  let signal = "NONE", reason = "", modeUsed = "STANDART";
  if (!volOk) reason = "Volatilite filtresi sağlanmadı";
  else if (h1Aligned && score >= cfg.scoreThreshold) {
    signal = directionHint; modeUsed = "H1+MACD HİZALI";
    reason = `Tam hizalama + Skor ${score}`;
  } else if (!h1Aligned && score >= cfg.relaxedScoreThreshold) {
    signal = directionHint; modeUsed = "ESNETİLMİŞ";
    reason = `Yüksek skor (${score})`;
  } else reason = `Koşullar oluşmadı (H1: ${h1Trend}, Skor: ${score})`;

  const slDist = roundTo(atr * cfg.slAtrMult, dec);
  const tpDist = roundTo(slDist * cfg.rrRatio, dec);
  const sl = signal === "BUY" ? roundTo(price - slDist, dec) : signal === "SELL" ? roundTo(price + slDist, dec) : null;
  const tp = signal === "BUY" ? roundTo(price + tpDist, dec) : signal === "SELL" ? roundTo(price - tpDist, dec) : null;

  const effectiveBalance = Math.max(1, sizing.balance || 10);
  const effectiveRiskPct = Math.min(5, Math.max(0.1, sizing.riskPct || 0.5));
  const riskUsd = +((effectiveBalance * effectiveRiskPct) / 100).toFixed(2);
  const lotSize = slDist > 0 ? Math.max(0.01, +(riskUsd / (slDist * cfg.contractSize)).toFixed(2)) : 0.01;

  let history = await getHistory(sym);
  history = updateOpenTrades(history, price);

  if (signal !== "NONE" && sl && tp) {
    const tradeId = `\( {sym}_ \){latestM15.datetime}_${signal}`;
    if (!history.some(item => item.id === tradeId)) {
      history = [{
        id: tradeId, symbol: sym, candleUtc: latestM15.datetime, side: signal,
        mode: modeUsed, score, entry: roundTo(price, dec), sl, tp, lot: lotSize,
        status: "OPEN", exitPrice: null, closedAt: null
      }, ...history].slice(0, 25);
      await saveHistory(sym, history);
      await sendTelegram(`🚨 <b>${sym} ${signal}</b>\nGiriş: ${price}\nSL: ${sl} | TP: ${tp}\nSkor: ${score} | Lot: ${lotSize}`);
    }
  } else {
    await saveHistory(sym, history);
  }

  return { symbol: sym, price: roundTo(price, dec), signal, score, reason, modeUsed, h1Trend, atr: +atr.toFixed(dec), volThreshold, sl, tp, lotSize, riskUsd, history, rsi: +rsi14.toFixed(1) };
}

function renderHtml(data) {
  if (data.error) return `<html><body style="background:#111;color:#fff;padding:20px"><h3>Hata</h3><p>${data.error}</p></body></html>`;
  const rows = (data.history || []).map(t => `<tr><td>\( {t.candleUtc}</td><td> \){t.side}</td><td>\( {t.entry}</td><td> \){t.sl}</td><td>\( {t.tp}</td><td> \){t.lot}</td><td>${t.status}</td></tr>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>XAU/USD</title>
  <style>body{font-family:system-ui;background:#090d16;color:#f1f5f9;margin:0;padding:16px}.card{background:#111827;border-radius:12px;padding:16px;margin-bottom:12px}.price{font-size:28px;font-weight:700}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #1e293b;text-align:left}</style></head>
  <body><div class="card"><div>XAU/USD Sinyal</div><div class="price">\( {data.price}</div><div>Sinyal: <b> \){data.signal}</b> | Skor: \( {data.score}</div><div style="font-size:13px;color:#94a3b8"> \){data.reason}</div>
  <div>SL/TP: ${data.sl ?? "-"} / ${data.tp ?? "-"} | Lot: ${data.lotSize}</div></div>
  <div class="card"><table><thead><tr><th>Mum</th><th>Yön</th><th>Giriş</th><th>SL</th><th>TP</th><th>Lot</th><th>Durum</th></tr></thead><tbody>${rows || "<tr><td colspan=7>Henüz sinyal yok</td></tr>"}</tbody></table></div></body></html>`;
}

app.get("/", async (req, res) => {
  try {
    const state = await evaluateMarket(INSTRUMENTS["XAU/USD"], { balance: parseFloat(req.query.balance) || 10, riskPct: parseFloat(req.query.risk) || 0.5 });
    res.send(renderHtml(state));
  } catch (err) {
    res.status(500).send(renderHtml({ error: err.message }));
  }
});

app.get("/json", async (req, res) => {
  try {
    const state = await evaluateMarket(INSTRUMENTS["XAU/USD"], {});
    res.json(state);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Running on ${PORT}`));
