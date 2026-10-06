/**
 * Расчёт уровней поддержки и сопротивления методом классических
 * пивот-точек (floor pivots).
 *
 * Уровни считаются по предыдущей закрытой свече старшего таймфрейма:
 * для дневных уровней — по вчерашнему дню, для H4 — по прошлой
 * четырёхчасовке. Формулы детерминированные, поэтому результат
 * воспроизводим и легко проверяется тестами.
 *
 * Все функции чистые.
 */

/** Округление денежных значений до двух знаков. */
function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Классические пивот-уровни по свече предыдущего периода.
 * @param {{high:number, low:number, close:number}} candle
 * @returns {{pp:number, r1:number, r2:number, r3:number, s1:number, s2:number, s3:number}}
 */
export function calculatePivotPoints({ high, low, close }) {
  if (![high, low, close].every(Number.isFinite)) {
    throw new TypeError('calculatePivotPoints: high, low и close должны быть числами');
  }
  if (high < low) {
    throw new RangeError('calculatePivotPoints: high не может быть меньше low');
  }

  const pp = (high + low + close) / 3;
  const range = high - low;

  return {
    pp: round(pp),
    r1: round(2 * pp - low),
    r2: round(pp + range),
    r3: round(high + 2 * (pp - low)),
    s1: round(2 * pp - high),
    s2: round(pp - range),
    s3: round(low - 2 * (high - pp)),
  };
}

/**
 * Ближайшие уровни вокруг текущей цены.
 *
 * Для сообщения с анализом не нужен весь набор из семи уровней — нужны
 * тот, что сразу над ценой, и тот, что сразу под ней.
 * @param {object} pivots - результат calculatePivotPoints
 * @param {number} price
 * @returns {{support: {name:string, value:number}|null, resistance: {name:string, value:number}|null}}
 */
export function findNearestLevels(pivots, price) {
  const entries = Object.entries(pivots)
    .map(([name, value]) => ({ name: name.toUpperCase(), value }))
    .sort((a, b) => a.value - b.value);

  const below = entries.filter((level) => level.value < price);
  const above = entries.filter((level) => level.value > price);

  return {
    support: below.at(-1) ?? null,
    resistance: above.at(0) ?? null,
  };
}

/**
 * Свеча предыдущего закрытого периода.
 *
 * Последняя свеча в серии ещё формируется, её high/low будут меняться,
 * поэтому уровни считаем по предпоследней.
 * @param {Array} candles - от старых к новым
 */
export function previousClosedCandle(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  return candles.at(-2);
}
