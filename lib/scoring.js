/**
 * Сводная оценка обстановки по нескольким факторам.
 *
 * Каждый фактор даёт число от −1 (за продажу) до +1 (за покупку) и
 * имеет вес. Итог — взвешенная сумма, уверенность — согласие факторов
 * между собой.
 *
 * Почему именно согласие, а не величина суммы: шесть факторов, слабо
 * указывающих в одну сторону, надёжнее одного сильного против пяти
 * нейтральных. Разнобой означает, что рынок не определился, и это
 * честнее показать, чем маскировать средним значением.
 *
 * Факторы считаются по тем данным, что у нас есть. Ни «настроения
 * толпы», ни «новостного риска» здесь нет: для них нужны источники,
 * которых у нас не подключено, а рисовать правдоподобные числа из
 * ничего — худшее, что можно сделать в торговой системе.
 */
import { describeRsi, detectTrend } from './indicators.js';
import { getActiveSessions, isMarketOpen } from './sessions.js';

/** Веса подобраны по вкладу факторов, а не по красоте чисел. */
const WEIGHTS = {
  trend: 1.0,
  structure: 1.2,
  range: 1.0,
  momentum: 0.6,
  zones: 0.8,
  liquidity: 0.6,
  candles: 0.4,
};

const LABELS = {
  trend: 'Тренд (EMA 50/200)',
  structure: 'Структура рынка',
  range: 'Положение в диапазоне',
  momentum: 'Импульс (RSI)',
  zones: 'Незакрытые зоны',
  liquidity: 'Ближайшая ликвидность',
  candles: 'Свечной импульс',
};

/** Ограничивает значение диапазоном −1…+1. */
const clamp = (value) => Math.max(-1, Math.min(1, value));
const round = (value) => Math.round(value * 100) / 100;

/* ======================= Отдельные факторы ======================= */

/** Направление по скользящим средним и положению цены. */
function scoreTrend(indicators) {
  const trend = detectTrend(indicators);
  if (trend === 'up') return { score: 1, note: 'EMA50 выше EMA200, цена над средней' };
  if (trend === 'down') return { score: -1, note: 'EMA50 ниже EMA200, цена под средней' };
  if (trend === 'flat') return { score: 0, note: 'средние сошлись, направления нет' };
  return { score: 0, note: 'данных не хватает' };
}

/**
 * Структура: продолжение весит больше смены характера.
 *
 * BOS подтверждает направление, CHoCH лишь намекает на разворот —
 * он часто оказывается ложным, поэтому вес вдвое меньше.
 */
function scoreStructure(structure) {
  const last = structure.events?.at(-1);
  if (!last) return { score: 0, note: 'сломов структуры не было' };

  const direction = last.direction === 'bullish' ? 1 : -1;
  const strength = last.type === 'BOS' ? 1 : 0.5;

  return {
    score: direction * strength,
    note: `${last.type} ${last.direction === 'bullish' ? 'вверх' : 'вниз'} на ${last.price.toFixed(2)}`,
  };
}

/**
 * Положение в диапазоне.
 *
 * Единственный фактор, прошедший проверку на отложенной истории:
 * покупки в дорогой половине и продажи в дешёвой стабильно ухудшали
 * результат. Поэтому он работает против цены, а не по ней.
 */
function scoreRange(range) {
  if (!range) return { score: 0, note: 'диапазон не определён' };

  // 0 на минимуме диапазона, 1 на максимуме. Переводим в −1…+1,
  // где дёшево означает «за покупку».
  const score = clamp((0.5 - range.position) * 2);
  const zone = { premium: 'дорого', discount: 'дёшево', equilibrium: 'середина' }[range.zone];

  return { score, note: `${zone}, ${Math.round(range.position * 100)}% диапазона` };
}

/** Импульс по RSI: крайности работают на возврат. */
function scoreMomentum(indicators) {
  // Проверяем на конечность, а не на null: недосчитанный индикатор
  // приходит как null, отсутствующее поле — как undefined, и второе
  // проскакивало бы дальше.
  const rsi = indicators.rsi14;
  if (!Number.isFinite(rsi)) return { score: 0, note: 'недостаточно данных' };

  const state = describeRsi(rsi);
  if (state === 'oversold') return { score: 0.8, note: `RSI ${rsi.toFixed(1)}, перепродан` };
  if (state === 'overbought') return { score: -0.8, note: `RSI ${rsi.toFixed(1)}, перекуплен` };

  // В нейтральной зоне RSI слабо указывает в сторону отклонения от 50.
  return { score: clamp((rsi - 50) / 100), note: `RSI ${rsi.toFixed(1)}, нейтрально` };
}

/** Незакрытые зоны: учитываются только те, до которых близко. */
function scoreZones(structure, price) {
  const zones = structure.zones ?? [];
  if (zones.length === 0 || !Number.isFinite(price)) {
    return { score: 0, note: 'незакрытых зон рядом нет' };
  }

  let sum = 0;
  let counted = 0;

  for (const zone of zones) {
    const middle = (zone.top + zone.bottom) / 2;
    const distance = Math.abs(middle - price) / price;
    if (distance > 0.02) continue;

    // Чем ближе зона, тем весомее: на расстоянии 2% вклад нулевой.
    sum += (zone.direction === 'bullish' ? 1 : -1) * (1 - distance / 0.02);
    counted += 1;
  }

  if (counted === 0) return { score: 0, note: 'ближайшие зоны далеко' };
  return { score: clamp(sum / counted), note: `${counted} зон в пределах 2% от цены` };
}

/**
 * Ликвидность: цену тянет к ближайшему скоплению заявок.
 *
 * Пул над ценой — повод ждать движения вверх, под ценой — вниз.
 * Это не прогноз, а наблюдение методологии: туда чаще ходят.
 */
function scoreLiquidity(structure, price) {
  const pools = structure.pools ?? [];
  if (pools.length === 0 || !Number.isFinite(price)) {
    return { score: 0, note: 'скоплений рядом нет' };
  }

  const nearest = pools.reduce((best, pool) =>
    Math.abs(pool.price - price) < Math.abs(best.price - price) ? pool : best,
  );

  const distance = Math.abs(nearest.price - price) / price;
  if (distance > 0.015) return { score: 0, note: 'ближайшее скопление далеко' };

  const above = nearest.price > price;
  return {
    score: clamp((above ? 1 : -1) * (1 - distance / 0.015) * 0.8),
    // Положение относительно ЦЕНЫ, а не тип ликвидности: buy-side
    // означает «над максимумами», и это не то же самое, что «выше
    // текущей цены».
    note: `${nearest.price.toFixed(2)} ${above ? 'выше' : 'ниже'} цены (×${nearest.count})`,
  };
}

/** Последние свечи: куда шло закрытие. */
function scoreCandles(candles) {
  const last = (candles ?? []).slice(-5);
  if (last.length < 5) return { score: 0, note: 'мало свечей' };

  const bullish = last.filter((c) => c.close > c.open).length;
  const score = clamp((bullish - 2.5) / 2.5);

  return { score, note: `${bullish} из 5 свечей в плюс` };
}

/* ======================= Сводка ======================= */

/**
 * Считает все факторы и сводит их в один вердикт.
 *
 * @param {{candles: Array, indicators: object, structure: object}} input
 */
export function scoreMarket({ candles, indicators, structure }) {
  const price = indicators.price;

  const factors = {
    trend: scoreTrend(indicators),
    structure: scoreStructure(structure),
    range: scoreRange(structure.range),
    momentum: scoreMomentum(indicators),
    zones: scoreZones(structure, price),
    liquidity: scoreLiquidity(structure, price),
    candles: scoreCandles(candles),
  };

  let weighted = 0;
  let totalWeight = 0;

  for (const [name, factor] of Object.entries(factors)) {
    factor.label = LABELS[name];
    factor.weight = WEIGHTS[name];
    factor.score = round(factor.score);
    weighted += factor.score * factor.weight;
    totalWeight += factor.weight;
  }

  const total = round(weighted / totalWeight);

  // Согласие: доля факторов, смотрящих в сторону итога. Нейтральные
  // (почти нулевые) в расчёт не идут — они ни за, ни против.
  const meaningful = Object.values(factors).filter((f) => Math.abs(f.score) >= 0.15);
  const agreeing = meaningful.filter((f) => Math.sign(f.score) === Math.sign(total));
  const agreement = meaningful.length ? agreeing.length / meaningful.length : 0;

  return {
    direction: total > 0.12 ? 'long' : total < -0.12 ? 'short' : 'flat',
    total,
    agreement: round(agreement),
    confidence: confidenceOf(total, agreement, meaningful.length),
    factors,
    sessions: getActiveSessions(),
    marketOpen: isMarketOpen(),
  };
}

/**
 * Уверенность словом.
 *
 * Высокой она бывает редко и только когда факторы действительно
 * сходятся. Завышенная уверенность — самое вредное, что может
 * сообщить такая система.
 */
function confidenceOf(total, agreement, meaningfulCount) {
  if (meaningfulCount < 3) return 'низкая';
  if (Math.abs(total) < 0.12) return 'нет перевеса';
  if (agreement >= 0.8 && Math.abs(total) >= 0.35) return 'высокая';
  if (agreement >= 0.6 && Math.abs(total) >= 0.2) return 'средняя';
  return 'низкая';
}
