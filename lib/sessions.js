/**
 * Торговые сессии и часы работы рынка золота.
 *
 * Все расчёты в UTC. Границы сессий приблизительные: реальные часы
 * плавают на час из-за перехода на летнее время в Лондоне и Нью-Йорке.
 * Для подсказки «сейчас Лондон» этой точности достаточно, на ней
 * не строится ни одно торговое решение.
 *
 * Функции чистые и принимают дату параметром — так их можно тестировать
 * без подмены системного времени.
 */

/** Границы сессий в часах UTC. end может быть меньше start (переход через полночь). */
const SESSIONS = [
  { id: 'asia', start: 0, end: 9 },
  { id: 'london', start: 8, end: 17 },
  { id: 'newyork', start: 13, end: 22 },
];

/** Попадает ли час в интервал с учётом перехода через полночь. */
function inRange(hour, start, end) {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Какие сессии идут прямо сейчас. Их может быть две сразу:
 * пересечение Лондона и Нью-Йорка — самое ликвидное время для золота.
 * @param {Date} date
 * @returns {string[]} идентификаторы сессий
 */
export function getActiveSessions(date = new Date()) {
  const hour = date.getUTCHours();
  return SESSIONS.filter((s) => inRange(hour, s.start, s.end)).map((s) => s.id);
}

/**
 * Открыт ли рынок золота.
 *
 * Спот-золото торгуется круглосуточно с вечера воскресенья до вечера
 * пятницы. В выходные котировки стоят, и проверять алерты бессмысленно.
 * @param {Date} date
 */
export function isMarketOpen(date = new Date()) {
  const day = date.getUTCDay(); // 0 — воскресенье, 6 — суббота
  const hour = date.getUTCHours();

  if (day === 6) return false;                 // суббота — весь день закрыто
  if (day === 5 && hour >= 21) return false;   // пятница после 21:00 UTC
  if (day === 0 && hour < 22) return false;    // воскресенье до 22:00 UTC
  return true;
}
