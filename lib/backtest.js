/**
 * Бэктест: прогон стратегий по истории.
 *
 * Задача — не «посчитать прибыль», а быстро отвечать на вопрос
 * «что будет, если добавить такой фильтр». Поэтому главное требование
 * к движку — скорость: перебор десятков вариантов должен занимать
 * секунды, иначе исследовать нечего.
 *
 * Ключевое отличие от наивной реализации: разметка считается ОДИН раз
 * по всей серии, а не заново на каждой свече. Это законно, потому что
 * детекторы уже не заглядывают в будущее — событие получает индекс той
 * свечи, на которой оно стало известно. Такой прогон линеен по времени
 * вместо квадратичного.
 */
import { computeIndicators } from './indicators.js';
import { analyzeStructure, premiumDiscount } from './structure.js';
import { getActiveSessions } from './sessions.js';
import { checkExit, closePosition, managePosition, openPosition, summarize } from './trading.js';

/** Фильтры по умолчанию — ничего не отсеивают. */
export const DEFAULT_FILTERS = {
  // Входить только по направлению структуры на этом таймфрейме.
  trendAlign: false,
  // Покупать только в дешёвой половине диапазона, продавать в дорогой.
  premiumDiscount: false,
  // Торговать только в выбранные сессии.
  sessions: null,
  // Минимальная глубина снятия ликвидности в долях ATR.
  minSweepDepth: 0,
  // Закрывать позицию, если за столько свечей ничего не произошло.
  maxBars: 0,
  // Минимальное расстояние до стопа в долях ATR — отсекает входы,
  // где стоп стоит вплотную и выбивается шумом.
  minStopAtr: 0,
};

/** Строит отображение «время свечи → её индекс». */
function indexByTime(candles) {
  const map = new Map();
  for (let i = 0; i < candles.length; i++) map.set(candles[i].time, i);
  return map;
}

/**
 * Собирает сигналы по индексам свечей.
 *
 * Для каждой свечи — список сработавших на ней сетапов. Считается
 * один раз, дальше прогон только читает.
 */
function collectSignals(candles, analysis, enabled) {
  const byIndex = new Map();
  const index = indexByTime(candles);

  const add = (time, signal) => {
    const i = index.get(time);
    if (i === undefined) return;
    if (!byIndex.has(i)) byIndex.set(i, []);
    byIndex.get(i).push({ ...signal, index: i });
  };

  if (enabled.fvgRetest !== false) {
    for (const gap of analysis.fvg) {
      if (!gap.mitigatedAt) continue;
      add(gap.mitigatedAt, {
        strategy: 'fvgRetest',
        direction: gap.direction,
        zone: { top: gap.top, bottom: gap.bottom },
        reason: 'Возврат в имбаланс',
      });
    }
  }

  if (enabled.obRetest !== false) {
    for (const block of analysis.orderBlocks) {
      if (!block.mitigatedAt) continue;
      add(block.mitigatedAt, {
        strategy: 'obRetest',
        direction: block.direction,
        zone: { top: block.top, bottom: block.bottom },
        reason: 'Возврат в order block',
      });
    }
  }

  if (enabled.sweepReversal !== false) {
    for (const sweep of analysis.sweeps) {
      add(sweep.time, {
        strategy: 'sweepReversal',
        direction: sweep.direction,
        depth: sweep.depth,
        level: sweep.price,
        reason: 'Разворот после снятия ликвидности',
      });
    }
  }

  return byIndex;
}

/**
 * Направление структуры на каждой свече.
 *
 * События дают точки смены; между ними направление сохраняется.
 */
function trendByIndex(candles, events) {
  const trend = new Array(candles.length).fill(null);
  let current = null;
  let cursor = 0;

  for (let i = 0; i < candles.length; i++) {
    while (cursor < events.length && events[cursor].index <= i) {
      current = events[cursor].direction;
      cursor += 1;
    }
    trend[i] = current;
  }
  return trend;
}

/**
 * Прогон по истории.
 *
 * @param {Array} candles
 * @param {object} settings - нормализованные настройки торговли
 * @param {object} [filters]
 * @param {{warmup?: number}} [options]
 */
export function backtest(candles, settings, filters = {}, options = {}) {
  const rules = { ...DEFAULT_FILTERS, ...filters };
  const warmup = options.warmup ?? 300;
  if (candles.length <= warmup) return emptyResult(settings);

  const analysis = analyzeStructure(candles, settings);
  const signalsByIndex = collectSignals(candles, analysis, settings.strategies ?? {});
  const trend = trendByIndex(candles, analysis.events);

  // ATR считаем один раз по всей серии: он нужен и для стопов,
  // и для фильтров.
  const atrSeries = atrByIndex(candles);

  const positions = [];
  let open = [];

  for (let i = warmup; i < candles.length; i++) {
    const candle = candles[i];

    const atrNow = atrSeries[i];

    // Сначала закрываем — иначе лимит позиций считался бы неверно.
    const stillOpen = [];
    for (const position of open) {
      const exit = checkExit(position, candle);
      const expired =
        rules.maxBars > 0 && i - position.openedAtIndex >= rules.maxBars;

      if (exit) {
        positions.push(closePosition(position, exit.outcome, exit.price, candle.time, costs(settings)));
        continue;
      }
      if (expired) {
        // Выход по времени: сделка, которая никуда не пошла, держит
        // лимит позиций и мешает брать новые.
        positions.push(closePosition(position, 'time', candle.close, candle.time, costs(settings)));
        continue;
      }

      // Управление применяется ПОСЛЕ проверки выхода: иначе стоп
      // успевал бы переехать в безубыток раньше, чем цена сходила
      // против позиции на той же свече.
      const managed = managePosition(position, candle, atrNow, settings.exits ?? {}, costs(settings));
      if (managed.partial) positions.push(managed.partial);
      stillOpen.push(managed.position);
    }
    open = stillOpen;

    if (open.length >= settings.maxOpenPositions) continue;

    const signals = signalsByIndex.get(i);
    if (!signals) continue;

    const atr = atrNow;

    for (const signal of signals) {
      if (open.length >= settings.maxOpenPositions) break;
      if (open.some((p) => p.strategy === signal.strategy)) continue;
      if (!passesFilters(signal, { candle, index: i, trend, atr, candles, rules })) continue;

      const position = openPosition(
        { ...signal, entry: candle.close, zone: signal.zone ?? zoneFromSweep(signal, candle) },
        settings,
        atr,
        candle.time,
      );
      if (!position) continue;

      // Слишком узкий стоп выбивается рыночным шумом.
      if (rules.minStopAtr > 0 && atr > 0 && position.riskPoints < atr * rules.minStopAtr) continue;

      position.openedAtIndex = i;
      open.push(position);
    }
  }

  return {
    positions: [...positions, ...open],
    stats: summarize([...positions, ...open], settings),
    bars: candles.length - warmup,
  };
}

/** Все издержки одним объектом. */
function costs(settings) {
  return {
    spread: settings.spread ?? 0,
    swapPerNight: settings.swapPerNight ?? 0,
    stopSlippage: settings.stopSlippage ?? 0,
  };
}

/** Зона для сигнала снятия: от уровня до экстремума свечи. */
function zoneFromSweep(signal, candle) {
  return {
    top: Math.max(signal.level, candle.high),
    bottom: Math.min(signal.level, candle.low),
  };
}

/** Проверка всех включённых фильтров. */
function passesFilters(signal, context) {
  const { candle, index, trend, atr, candles, rules } = context;

  if (rules.trendAlign && trend[index] && signal.direction !== trend[index]) return false;

  if (rules.premiumDiscount) {
    const range = premiumDiscount(candles.slice(Math.max(0, index - 100), index + 1), candle.close);
    if (range) {
      // Покупаем только внизу диапазона, продаём только наверху.
      if (signal.direction === 'bullish' && range.zone === 'premium') return false;
      if (signal.direction === 'bearish' && range.zone === 'discount') return false;
    }
  }

  if (rules.sessions) {
    const active = getActiveSessions(new Date(candle.time));
    if (!active.some((s) => rules.sessions.includes(s))) return false;
  }

  if (rules.minSweepDepth > 0 && signal.strategy === 'sweepReversal') {
    if (!(atr > 0) || signal.depth < atr * rules.minSweepDepth) return false;
  }

  return true;
}

/** ATR по всей серии — для стопов и фильтров. */
function atrByIndex(candles) {
  const series = new Array(candles.length).fill(null);
  const period = 14;
  let sum = 0;

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prev.close),
      Math.abs(candles[i].low - prev.close),
    );

    if (i <= period) {
      sum += tr;
      if (i === period) series[i] = sum / period;
      continue;
    }
    series[i] = (series[i - 1] * (period - 1) + tr) / period;
  }
  return series;
}

function emptyResult(settings) {
  return { positions: [], stats: summarize([], settings), bars: 0 };
}

/* ======================= Скользящая проверка ======================= */

/**
 * Walk-forward: много независимых проверок вместо одной.
 *
 * Одно разделение истории даёт один шанс обмануться. Здесь окно едет
 * по истории: подбор на отрезке, проверка на следующем, сдвиг, снова.
 * Получается несколько непересекающихся проверочных участков.
 *
 * Смотреть надо не на сумму, а на ДОЛЮ прибыльных окон. Настоящее
 * преимущество работает в большинстве периодов; подгонка даёт один
 * яркий отрезок и провалы вокруг него.
 *
 * @param {Array} candles
 * @param {object} settings
 * @param {object} filters
 * @param {{trainBars?: number, testBars?: number, warmup?: number}} [options]
 */
export function walkForward(candles, settings, filters = {}, options = {}) {
  const warmup = options.warmup ?? 300;
  const trainBars = options.trainBars ?? 1200;
  const testBars = options.testBars ?? 600;

  const windows = [];
  const step = testBars;

  for (let start = 0; ; start += step) {
    const trainEnd = start + warmup + trainBars;
    const testEnd = trainEnd + testBars;
    if (testEnd > candles.length) break;

    // Проверочный отрезок получает собственный прогрев, иначе первые
    // сделки считались бы по недосчитанным индикаторам.
    const trainSlice = candles.slice(start, trainEnd);
    const testSlice = candles.slice(trainEnd - warmup, testEnd);

    const train = backtest(trainSlice, settings, filters, { warmup });
    const test = backtest(testSlice, settings, filters, { warmup });

    windows.push({
      from: candles[trainEnd].time,
      to: candles[testEnd - 1].time,
      train: train.stats,
      test: test.stats,
      // Сделки проверочных окон складываем в общий мешок: по ним
      // считается сводная статистика по всем периодам сразу.
      positions: test.positions,
    });
  }

  const allTest = windows.flatMap((w) => w.positions);
  const positive = windows.filter((w) => w.test.pnlMoney > 0).length;

  return {
    windows: windows.map(({ positions, ...rest }) => rest),
    // Сделки всех проверочных окон — по ним считается значимость.
    // Это единственный набор, не участвовавший в подборе.
    testPositions: allTest,
    summary: {
      windowCount: windows.length,
      positiveWindows: positive,
      // Доля прибыльных окон — главное число во всём отчёте.
      consistency: windows.length ? Math.round((positive / windows.length) * 1000) / 10 : null,
      combined: summarize(allTest, settings),
    },
  };
}

/* ======================= Значимость ======================= */

/**
 * Насколько результат отличим от случайности.
 *
 * Берём полученные сделки и много раз составляем из них новые наборы
 * того же размера, выбирая с возвратом. Разброс итогов показывает,
 * в каких пределах мог бы оказаться результат при той же статистике
 * сделок, но другом стечении обстоятельств.
 *
 * Практический смысл: если нижняя граница интервала ниже нуля, значит
 * отличить систему от случайности на имеющемся числе сделок нельзя —
 * и выводы делать рано, сколько бы ни было в итоге.
 *
 * @param {Array} positions
 * @param {{iterations?: number, seed?: number}} [options]
 */
export function bootstrap(positions, options = {}) {
  const iterations = options.iterations ?? 2000;
  const closed = positions.filter((p) => p.status === 'closed');
  if (closed.length < 20) return null;

  const pnls = closed.map((p) => p.pnlMoney);
  const random = mulberry32(options.seed ?? 12345);

  const totals = [];
  const factors = [];

  for (let run = 0; run < iterations; run++) {
    let total = 0;
    let won = 0;
    let lost = 0;

    for (let i = 0; i < pnls.length; i++) {
      const value = pnls[Math.floor(random() * pnls.length)];
      total += value;
      if (value > 0) won += value;
      else lost -= value;
    }

    totals.push(total);
    factors.push(lost > 0 ? won / lost : 0);
  }

  totals.sort((a, b) => a - b);
  factors.sort((a, b) => a - b);

  const at = (array, q) => Math.round(array[Math.floor(array.length * q)] * 100) / 100;

  return {
    trades: closed.length,
    iterations,
    pnl: { low: at(totals, 0.025), median: at(totals, 0.5), high: at(totals, 0.975) },
    profitFactor: { low: at(factors, 0.025), median: at(factors, 0.5), high: at(factors, 0.975) },
    // Доля наборов, закончившихся в минусе.
    lossProbability: Math.round((totals.filter((t) => t <= 0).length / iterations) * 1000) / 10,
  };
}

/** Детерминированный генератор: одинаковый результат при одном seed. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
