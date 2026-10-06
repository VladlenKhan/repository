/**
 * Получение рыночных данных.
 *
 * Модуль-адаптер: наружу торчит один интерфейс провайдера, реализация
 * спрятана внутри. Чтобы добавить OANDA или Finnhub, достаточно написать
 * рядом функцию createOandaProvider с теми же методами и подставить её
 * в getProvider — остальной код трогать не придётся.
 *
 * Интерфейс провайдера:
 *   getCandles({ timeframe, limit }) -> Promise<Candle[]>   // от старых к новым
 *   getQuote()                       -> Promise<{ price, time }>
 *
 * Candle: { time: number(ms), open, high, low, close, volume }
 */
import { getPricesConfig } from './config.js';
import { getCachedCandles, setCachedCandles } from './storage.js';
import { timeframeMs } from './timeframes.js';

/** Сколько ждём ответ API. Бюджет функции — 10 секунд, оставляем запас. */
const FETCH_TIMEOUT_MS = 4000;

/**
 * Ошибка получения данных с понятной причиной.
 * kind: 'rate_limit' | 'unavailable' | 'bad_response'
 */
export class PricesError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'PricesError';
    this.kind = kind;
  }
}

/**
 * Запрос к Twelve Data.
 *
 * Тонкость: при исчерпании лимита Twelve Data отвечает HTTP 200,
 * а признак ошибки кладёт в тело ответа (status: 'error', code: 429).
 * Поэтому проверять только response.ok недостаточно.
 */
async function requestTwelveData(path, params, apiKey) {
  const url = new URL(path, 'https://api.twelvedata.com');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('apikey', apiKey);

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    // Сюда попадает и таймаут (AbortError), и отсутствие сети.
    throw new PricesError('unavailable', `Twelve Data недоступна: ${error.message}`);
  }

  if (response.status === 429) {
    throw new PricesError('rate_limit', 'Превышен лимит запросов Twelve Data');
  }
  if (!response.ok) {
    throw new PricesError('unavailable', `Twelve Data ответила HTTP ${response.status}`);
  }

  const payload = await response.json().catch(() => null);
  if (!payload) {
    throw new PricesError('bad_response', 'Twelve Data вернула не-JSON');
  }
  if (payload.status === 'error') {
    const kind = payload.code === 429 ? 'rate_limit' : 'bad_response';
    throw new PricesError(kind, payload.message ?? 'Twelve Data вернула ошибку');
  }
  return payload;
}

/** Приводит строковую свечу Twelve Data к внутреннему формату. */
function toCandle(row) {
  return {
    // Twelve Data отдаёт время без зоны, но в UTC — дописываем Z явно.
    time: Date.parse(`${row.datetime.replace(' ', 'T')}Z`),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume ?? 0),
  };
}

/** Создаёт провайдер Twelve Data. */
export function createTwelveDataProvider({ apiKey, symbol }) {
  return {
    name: 'twelvedata',
    symbol,

    async getCandles({ timeframe, limit }) {
      const payload = await requestTwelveData(
        '/time_series',
        { symbol, interval: timeframe, outputsize: String(limit) },
        apiKey,
      );

      if (!Array.isArray(payload.values) || payload.values.length === 0) {
        throw new PricesError('bad_response', `Нет свечей для ${symbol} ${timeframe}`);
      }

      // API отдаёт от новых к старым, индикаторам нужен обратный порядок.
      const candles = payload.values.map(toCandle).reverse();

      // Отбрасываем строки, где время или цена не разобрались.
      const valid = candles.filter(
        (c) => Number.isFinite(c.time) && Number.isFinite(c.close),
      );
      if (valid.length === 0) {
        throw new PricesError('bad_response', 'Свечи не удалось разобрать');
      }
      return valid;
    },

    async getQuote() {
      const payload = await requestTwelveData('/price', { symbol }, apiKey);
      const price = Number(payload.price);
      if (!Number.isFinite(price)) {
        throw new PricesError('bad_response', 'Цена пришла не числом');
      }
      return { price, time: Date.now() };
    },
  };
}

/** Текущий провайдер. Здесь будет выбор, когда появится второй источник. */
export function getProvider() {
  return createTwelveDataProvider(getPricesConfig());
}

/**
 * Свечи с кэшированием в Blobs.
 *
 * Отдельная функция, а не метод провайдера: кэш — это свойство нашего
 * приложения, а не источника данных, и для нового провайдера он должен
 * работать без изменений.
 */
export async function getCandlesCached({ timeframe, limit = 300, provider = getProvider() }) {
  const key = `${provider.name}:${provider.symbol}:${timeframe}:${limit}`;

  const cached = await getCachedCandles(key);
  if (cached) return cached;

  const candles = await provider.getCandles({ timeframe, limit });

  // Четверть таймфрейма, но не меньше минуты.
  const ttl = Math.max(timeframeMs(timeframe) / 4, 60_000);
  await setCachedCandles(key, candles, ttl);

  return candles;
}
