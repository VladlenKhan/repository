/**
 * Макроданные из FRED (Federal Reserve Economic Data).
 *
 * Серия по умолчанию — DFII10: доходность 10-летних облигаций США,
 * защищённых от инфляции (TIPS). Это и есть «реальная доходность» —
 * ключевой ориентир для золота.
 *
 * Две особенности источника, которые приходится учитывать:
 *  1. Данные выходят не каждый день: в выходные и праздники наблюдения
 *     нет, а свежее значение появляется с задержкой в день-два.
 *  2. Пропуски FRED помечает точкой ('.') вместо числа. Берём последнее
 *     значение, которое действительно разбирается как число.
 */
import { getMacroConfig } from './config.js';

const FETCH_TIMEOUT_MS = 4000;

/** Ошибка получения макроданных. kind: 'unavailable' | 'bad_response' */
export class MacroError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'MacroError';
    this.kind = kind;
  }
}

/**
 * Разбирает значение наблюдения FRED.
 * @returns {number|null} число или null, если значение пропущено
 */
export function parseObservationValue(raw) {
  // FRED помечает отсутствующее наблюдение точкой.
  if (raw === undefined || raw === null || raw === '.' || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Выбирает два последних реальных наблюдения из ответа FRED.
 *
 * Чистая функция — отделена от сети, чтобы проверять логику пропусков
 * без похода в API.
 * @param {Array<{date:string, value:string}>} observations - от новых к старым
 */
export function pickLatestObservations(observations) {
  const valid = [];
  for (const item of observations ?? []) {
    const value = parseObservationValue(item.value);
    if (value !== null) {
      valid.push({ value, date: item.date });
      if (valid.length === 2) break;
    }
  }
  if (valid.length === 0) return null;

  const [latest, previous = null] = valid;
  return {
    value: latest.value,
    date: latest.date,
    previousValue: previous?.value ?? null,
    change: previous ? Number((latest.value - previous.value).toFixed(3)) : null,
  };
}

/**
 * Запрашивает реальную доходность из FRED.
 * @returns {Promise<{value:number, date:string, previousValue:number|null, change:number|null}>}
 */
export async function getRealYield() {
  const { apiKey, seriesId } = getMacroConfig();

  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  // Запас на выходные и праздники: за 10 наблюдений хотя бы два будут с числом.
  url.searchParams.set('limit', '10');

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new MacroError('unavailable', `FRED недоступен: ${error.message}`);
  }

  if (!response.ok) {
    throw new MacroError('unavailable', `FRED ответил HTTP ${response.status}`);
  }

  const payload = await response.json().catch(() => null);
  const result = pickLatestObservations(payload?.observations);
  if (!result) {
    throw new MacroError('bad_response', 'FRED не вернул ни одного значения');
  }

  return { ...result, seriesId };
}

/**
 * Словесная характеристика реальной доходности.
 *
 * Логика связи с золотом: золото не приносит процентов, поэтому чем выше
 * реальная доходность надёжных облигаций, тем дороже обходится держать
 * золото вместо них. Отрицательная реальная доходность исторически
 * золоту благоприятна.
 *
 * Порог 0.03 п.п. отсекает дневной шум, чтобы не объявлять «рост»
 * на движении в сотую долю процента.
 * @returns {'negative'|'rising'|'falling'|'stable'}
 */
export function describeRealYield({ value, change }) {
  if (value < 0) return 'negative';

  const THRESHOLD = 0.03;
  if (change !== null && change > THRESHOLD) return 'rising';
  if (change !== null && change < -THRESHOLD) return 'falling';
  return 'stable';
}
