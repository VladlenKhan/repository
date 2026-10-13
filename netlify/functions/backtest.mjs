/**
 * Прогон стратегий по истории.
 *
 * POST /api/backtest  { settings, filters }
 *
 * Отвечает двумя наборами цифр: по части, на которой параметры
 * подбирались, и по отложенной, которую движок не видел. Разделение
 * встроено намеренно — подобранный на всей истории результат выглядит
 * заметно лучше, чем система торгует на самом деле, и об этом легко
 * забыть, если не показывать обе цифры рядом.
 */
import { backtest, bootstrap, walkForward } from '../../lib/backtest.js';
import { verifyToken } from '../../lib/auth.js';
import { ConfigError, getSessionSecret } from '../../lib/config.js';
import { PricesError, getChartCandles } from '../../lib/prices.js';
import { STRATEGIES } from '../../lib/strategies.js';
import { normalizeSettings } from '../../lib/trading.js';
import { isTimeframe } from '../../lib/timeframes.js';

/** Сколько свечей уходит на прогрев индикаторов и структуры. */
const WARMUP = 300;

/** Доля истории, отводимая под подбор параметров. */
const TRAIN_RATIO = 0.6;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function extractToken(request) {
  const match = (request.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/** Кривая капитала по закрытым сделкам — для графика. */
function equityCurve(positions) {
  const closed = positions
    .filter((p) => p.status === 'closed')
    .sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));

  let equity = 0;
  return closed.map((p) => {
    equity = Math.round((equity + p.pnlMoney) * 100) / 100;
    return { time: Math.floor(Date.parse(p.closedAt) / 1000), value: equity };
  });
}

export default async (request) => {
  if (request.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405);

  let secret;
  try {
    secret = getSessionSecret();
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: 'Сервис не настроен' }, 503);
    throw error;
  }

  if (!verifyToken(extractToken(request), secret)) return json({ error: 'Нужно войти' }, 401);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Некорректный запрос' }, 400);

  const settings = normalizeSettings({ ...body.settings, enabled: true });
  if (!isTimeframe(settings.timeframe)) return json({ error: 'Неизвестный таймфрейм' }, 400);

  const filters = {
    premiumDiscount: body.filters?.premiumDiscount === true,
    minStopAtr: Number(body.filters?.minStopAtr) || 0,
    trendAlign: body.filters?.trendAlign === true,
    minSweepDepth: Number(body.filters?.minSweepDepth) || 0,
    sessions: Array.isArray(body.filters?.sessions) && body.filters.sessions.length
      ? body.filters.sessions
      : null,
    maxBars: Number(body.filters?.maxBars) || 0,
  };

  // Символ меняется только для сверки: бот остаётся про золото,
  // другие инструменты нужны, чтобы проверить переносимость правил.
  const symbol = typeof body.symbol === 'string' && /^[A-Z]{3}\/[A-Z]{3}$/.test(body.symbol)
    ? body.symbol
    : null;

  let candles;
  try {
    candles = await getChartCandles({ timeframe: settings.timeframe, limit: 5000, symbol });
  } catch (error) {
    if (error instanceof PricesError) {
      const text = error.kind === 'rate_limit'
        ? 'Лимит запросов к поставщику данных исчерпан'
        : 'Поставщик данных недоступен';
      return json({ error: text }, 503);
    }
    throw error;
  }

  if (candles.length <= WARMUP * 2) return json({ error: 'Слишком мало истории' }, 400);

  const split = Math.floor(candles.length * TRAIN_RATIO);
  const train = candles.slice(0, split);
  // Проверочной части нужен свой прогрев, иначе первые сделки
  // считались бы по недосчитанным индикаторам.
  const test = candles.slice(split - WARMUP);

  const full = backtest(candles, settings, filters, { warmup: WARMUP });
  const trainResult = backtest(train, settings, filters, { warmup: WARMUP });
  const testResult = backtest(test, settings, filters, { warmup: WARMUP });

  // Скользящая проверка: несколько независимых проверочных окон
  // вместо одного. Доля прибыльных окон надёжнее общей суммы.
  const forward = walkForward(candles, settings, filters, { warmup: WARMUP });

  // Значимость считаем по сделкам проверочных окон — единственному
  // набору, не участвовавшему в подборе параметров.
  const significance = bootstrap(forward.testPositions);

  return json({
    settings,
    filters,
    symbol: symbol ?? 'XAU/USD',
    strategies: STRATEGIES,
    walkForward: { windows: forward.windows, summary: forward.summary },
    significance,
    period: {
      from: candles[0].time,
      to: candles.at(-1).time,
      bars: candles.length,
      trainBars: train.length - WARMUP,
      testBars: test.length - WARMUP,
    },
    full: full.stats,
    train: trainResult.stats,
    test: testResult.stats,
    equity: equityCurve(full.positions),
  });
};

export const config = { path: '/api/backtest' };
