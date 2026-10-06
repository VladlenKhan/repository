/**
 * Расчёт индикаторов поверх trading-signals.
 *
 * Обёртка нужна по двум причинам: во-первых, чтобы остальной код не знал
 * про конкретную библиотеку, во-вторых, чтобы недосчитанный индикатор
 * возвращался как null, а не бросал исключение. На коротких сериях EMA(200)
 * честно не определена, и это нормальная ситуация, а не ошибка.
 */
import { ATR, EMA, RSI } from 'trading-signals';

/**
 * Прогоняет серию значений через индикатор и возвращает последний
 * результат или null, если данных не хватило.
 */
function finalValue(indicator, values) {
  for (const value of values) {
    indicator.update(value, false);
  }
  return indicator.isStable ? indicator.getResultOrThrow() : null;
}

/**
 * Считает весь набор индикаторов по свечам.
 * @param {Array<{high:number, low:number, close:number}>} candles - от старых к новым
 */
export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const hlc = candles.map((c) => ({ high: c.high, low: c.low, close: c.close }));

  return {
    price: closes.at(-1) ?? null,
    ema50: finalValue(new EMA(50), closes),
    ema200: finalValue(new EMA(200), closes),
    rsi14: finalValue(new RSI(14), closes),
    atr14: finalValue(new ATR(14), hlc),
  };
}

/**
 * Тренд по взаимному положению EMA50 и EMA200 и цены.
 *
 * Небольшой порог в 0.1% нужен, чтобы при почти совпавших средних
 * не объявлять тренд на случайном дрожании четвёртого знака.
 * @returns {'up'|'down'|'flat'|'unknown'}
 */
export function detectTrend({ price, ema50, ema200 }) {
  if (ema50 === null || ema200 === null || price === null) return 'unknown';

  const spread = (ema50 - ema200) / ema200;
  const THRESHOLD = 0.001;

  if (spread > THRESHOLD && price > ema50) return 'up';
  if (spread < -THRESHOLD && price < ema50) return 'down';
  return 'flat';
}

/**
 * Словесная оценка RSI.
 * @returns {'overbought'|'oversold'|'neutral'|'unknown'}
 */
export function describeRsi(rsi) {
  if (rsi === null) return 'unknown';
  if (rsi >= 70) return 'overbought';
  if (rsi <= 30) return 'oversold';
  return 'neutral';
}

/**
 * Полный ряд значений EMA, а не только последнее.
 *
 * Нужен графику: линию средней нельзя построить по одной точке.
 * Длина результата совпадает с длиной входа, в начале стоят null —
 * пока индикатор не набрал нужного количества свечей.
 *
 * @returns {(number|null)[]}
 */
export function emaSeries(values, period) {
  const indicator = new EMA(period);

  return values.map((value) => {
    indicator.update(value, false);
    return indicator.isStable ? indicator.getResultOrThrow() : null;
  });
}
