/**
 * Сбор данных для панели администратора.
 *
 * Принцип: панель не должна стоить кредитов Twelve Data. Свечи берутся
 * из общего кэша — того же, что наполняют команды бота, — поэтому
 * обновление страницы расход не увеличивает. Единственный запрос
 * к Twelve Data, который делается всегда, — api_usage: он сам
 * кредитов не стоит и показывает, сколько их осталось.
 */
import { computeIndicators, describeRsi, detectTrend } from './indicators.js';
import { calculatePivotPoints, findNearestLevels, previousClosedCandle } from './levels.js';
import { getCandlesCached } from './prices.js';
import { getRealYield, describeRealYield } from './macro.js';
import { getActiveSessions, isMarketOpen } from './sessions.js';
import { listAllAlerts, listSubscribers, listUsers, pingStorage } from './storage.js';
import { createApi } from './telegram.js';
import { getPricesConfig } from './config.js';

const TIMEOUT_MS = 5000;

/**
 * Выполняет обещание, но не даёт ему подвесить всю панель.
 * Один недоступный сервис не должен лишать нас остальных разделов.
 */
async function settle(label, promise) {
  try {
    const value = await Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('превышено время ожидания')), TIMEOUT_MS),
      ),
    ]);
    return { ok: true, value };
  } catch (error) {
    console.error(`[admin] ${label}:`, error.message);
    return { ok: false, error: error.message };
  }
}

/** Расход кредитов Twelve Data. */
async function fetchApiUsage() {
  const { apiKey } = getPricesConfig();
  const response = await fetch(`https://api.twelvedata.com/api_usage?apikey=${apiKey}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  return {
    dailyUsed: payload.daily_usage ?? null,
    dailyLimit: payload.plan_daily_limit ?? null,
    minuteUsed: payload.current_usage ?? null,
    minuteLimit: payload.plan_limit ?? null,
    plan: payload.plan_category ?? null,
  };
}

/** Состояние вебхука по данным Telegram. */
async function fetchWebhook() {
  const info = await createApi().getWebhookInfo();
  return {
    url: info.url || null,
    pending: info.pending_update_count ?? 0,
    lastError: info.last_error_message ?? null,
    lastErrorAt: info.last_error_date ? info.last_error_date * 1000 : null,
  };
}

/** Рыночный блок — целиком из кэша свечей. */
async function fetchMarket() {
  const candles = await getCandlesCached({ timeframe: '1h', limit: 300 });
  const indicators = computeIndicators(candles);
  const reference = previousClosedCandle(candles);

  return {
    symbol: getPricesConfig().symbol,
    price: indicators.price,
    indicators,
    trend: detectTrend(indicators),
    rsiState: describeRsi(indicators.rsi14),
    levels: reference
      ? findNearestLevels(calculatePivotPoints(reference), indicators.price)
      : null,
    pivots: reference ? calculatePivotPoints(reference) : null,
    candleTime: candles.at(-1)?.time ?? null,
    sessions: getActiveSessions(),
    marketOpen: isMarketOpen(),
  };
}

/** Макроблок. */
async function fetchMacro() {
  const data = await getRealYield();
  return { ...data, state: describeRealYield(data) };
}

/**
 * Собирает всё для панели. Разделы запрашиваются параллельно,
 * отказ одного не ломает остальные.
 */
export async function collectAdminData() {
  const [storage, users, subscribers, alerts, usage, webhook, market, macro] = await Promise.all([
    settle('хранилище', pingStorage()),
    settle('пользователи', listUsers()),
    settle('подписчики', listSubscribers()),
    settle('алерты', listAllAlerts()),
    settle('расход API', fetchApiUsage()),
    settle('вебхук', fetchWebhook()),
    settle('рынок', fetchMarket()),
    settle('макро', fetchMacro()),
  ]);

  const price = market.ok ? market.value.price : null;

  return {
    generatedAt: Date.now(),
    storage: storage.ok ? storage.value : { ok: false, error: storage.error },
    users: users.ok ? users.value : [],
    subscribers: subscribers.ok ? subscribers.value : [],
    alerts: alerts.ok ? flattenAlerts(alerts.value, price) : [],
    usage: usage.ok ? usage.value : null,
    webhook: webhook.ok ? webhook.value : null,
    market: market.ok ? market.value : null,
    macro: macro.ok ? macro.value : null,
    errors: Object.entries({
      storage, users, subscribers, alerts, usage, webhook, market, macro,
    })
      .filter(([, result]) => !result.ok)
      .map(([name, result]) => ({ section: name, error: result.error })),
  };
}

/**
 * Разворачивает алерты всех чатов в плоский список и считает,
 * насколько каждый далёк от текущей цены.
 */
export function flattenAlerts(chats, price) {
  const rows = [];

  for (const chat of chats) {
    for (const alert of chat.items) {
      const distance =
        price === null || !Number.isFinite(price) ? null : alert.price - price;
      rows.push({
        chatId: chat.chatId,
        ...alert,
        distance: distance === null ? null : Math.round(distance * 100) / 100,
        distancePercent:
          distance === null ? null : Math.round((distance / price) * 10000) / 100,
      });
    }
  }

  // Ближайшие к срабатыванию — наверх.
  return rows.sort((a, b) => Math.abs(a.distance ?? 1e9) - Math.abs(b.distance ?? 1e9));
}
