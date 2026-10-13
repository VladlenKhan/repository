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

/**
 * Единый список людей: и пользователи бота, и аккаунты сайта.
 *
 * Это одни и те же люди: в личном чате идентификатор Telegram и
 * идентификатор чата совпадают, поэтому записи соединяются по нему.
 * Две отдельные таблицы заставляли сопоставлять их глазами.
 *
 * @param {{users: Array, accounts: Array, subscribers: Array, alerts: Array}} data
 */
export function mergePeople({ users = [], accounts = [], subscribers = [], alerts = [] }) {
  const byId = new Map();

  const touch = (id) => {
    // Проверяем до преобразования: Number(null) и Number('') дают ноль,
    // а не NaN, и запись без идентификатора превратилась бы в
    // пользователя с номером 0.
    if (id === null || id === undefined || id === '') return null;

    const key = Number(id);
    if (!Number.isInteger(key)) return null;
    if (!byId.has(key)) {
      byId.set(key, {
        telegramId: key,
        username: null,
        name: null,
        role: null,
        lang: null,
        subscribed: false,
        alerts: 0,
        usesBot: false,
        usesSite: false,
        firstSeen: null,
        lastSeen: null,
      });
    }
    return byId.get(key);
  };

  /** Берём более раннюю из двух дат, пропуская пустые. */
  const earlier = (a, b) => (!a ? b : !b ? a : Date.parse(a) <= Date.parse(b) ? a : b);
  const later = (a, b) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);

  for (const user of users) {
    const person = touch(user.chatId);
    if (!person) continue;
    person.usesBot = true;
    person.lang = user.lang ?? person.lang;
    person.username = user.username ?? person.username;
    person.name = user.name ?? person.name;
    person.lastSeen = later(person.lastSeen, user.updatedAt);
  }

  for (const account of accounts) {
    const person = touch(account.telegramId);
    if (!person) continue;
    person.usesSite = true;
    person.role = account.role ?? person.role;
    // Имя из аккаунта точнее: оно приходит подписанным от Telegram.
    person.username = account.username ?? person.username;
    person.name = account.displayName ?? person.name;
    person.firstSeen = earlier(person.firstSeen, account.createdAt);
    person.lastSeen = later(person.lastSeen, account.lastLoginAt);
    person.login = account.login;
  }

  for (const subscriber of subscribers) {
    const person = touch(subscriber.chatId);
    if (person) person.subscribed = true;
  }

  for (const alert of alerts) {
    const person = touch(alert.chatId);
    if (person) person.alerts += 1;
  }

  // Сначала те, у кого есть роль на сайте, потом остальные по активности.
  return [...byId.values()].sort((a, b) => {
    const rank = { owner: 3, admin: 2, user: 1 };
    const diff = (rank[b.role] ?? 0) - (rank[a.role] ?? 0);
    if (diff !== 0) return diff;
    return Date.parse(b.lastSeen ?? 0) - Date.parse(a.lastSeen ?? 0);
  });
}
