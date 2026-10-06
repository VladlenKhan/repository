/**
 * Уведомления о пересечении ценой заданного уровня.
 *
 * Ключевое решение: направление фиксируется в момент создания алерта.
 * Если цель выше текущей цены — ждём движения вверх, если ниже — вниз.
 * Благодаря этому не нужно хранить предыдущую цену: факт пересечения
 * следует из направления и текущего значения. Заодно алерт не сработает
 * сразу после создания.
 *
 * Алерт одноразовый: сработал — удалён.
 */
import { getAlerts, listAllAlerts, saveAlerts } from './storage.js';

/** Больше десяти уведомлений на чат — скорее ошибка, чем сценарий. */
export const MAX_ALERTS_PER_CHAT = 10;

/** Разумные границы для золота: отсекают опечатки вроде /alert 24. */
const MIN_PRICE = 100;
const MAX_PRICE = 100_000;

/**
 * Разбирает цену из аргумента команды.
 * Принимает и точку, и запятую как десятичный разделитель.
 * @returns {number|null}
 */
export function parseAlertPrice(input) {
  if (input === undefined || input === null) return null;

  const normalized = String(input).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;

  const price = Number(normalized);
  if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) return null;

  return Math.round(price * 100) / 100;
}

/**
 * Создаёт алерт относительно текущей цены.
 * @returns {object|null} null, если цель совпала с текущей ценой
 */
export function createAlert(targetPrice, currentPrice) {
  if (targetPrice === currentPrice) return null;

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    price: targetPrice,
    direction: targetPrice > currentPrice ? 'above' : 'below',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Пора ли сработать.
 * @param {{price:number, direction:'above'|'below'}} alert
 * @param {number} price - текущая цена
 */
export function shouldFire(alert, price) {
  if (!Number.isFinite(price)) return false;
  return alert.direction === 'above' ? price >= alert.price : price <= alert.price;
}

/**
 * Делит алерты чата на сработавшие и оставшиеся.
 * Чистая функция — вся проверка тестируется без хранилища.
 */
export function splitAlerts(items, price) {
  const fired = [];
  const remaining = [];

  for (const alert of items) {
    (shouldFire(alert, price) ? fired : remaining).push(alert);
  }
  return { fired, remaining };
}

/**
 * Добавляет алерт в хранилище с проверкой лимита.
 * @returns {Promise<{ok:boolean, reason?:string, alert?:object}>}
 */
export async function addAlert(chatId, targetPrice, currentPrice) {
  const items = await getAlerts(chatId);
  if (items.length >= MAX_ALERTS_PER_CHAT) {
    return { ok: false, reason: 'limit' };
  }

  const alert = createAlert(targetPrice, currentPrice);
  if (alert === null) {
    return { ok: false, reason: 'same_price' };
  }

  const saved = await saveAlerts(chatId, [...items, alert]);
  return saved ? { ok: true, alert } : { ok: false, reason: 'storage' };
}

/** Удаляет все алерты чата. */
export async function clearAlerts(chatId) {
  return saveAlerts(chatId, []);
}

/**
 * Проверяет все алерты всех чатов по текущей цене.
 *
 * Возвращает список срабатываний — рассылкой занимается вызывающая
 * сторона, чтобы эту функцию можно было тестировать без Telegram.
 *
 * @returns {Promise<Array<{chatId:number, alert:object}>>}
 */
export async function collectTriggeredAlerts(price) {
  const chats = await listAllAlerts();
  const triggered = [];

  for (const chat of chats) {
    const { fired, remaining } = splitAlerts(chat.items, price);
    if (fired.length === 0) continue;

    // Сначала убираем сработавшие из хранилища, потом сообщаем о них.
    // При обратном порядке сбой записи привёл бы к повторной отправке
    // тех же уведомлений на следующем запуске.
    const saved = await saveAlerts(chat.chatId, remaining);
    if (!saved) {
      console.error(`[alerts] не удалось обновить алерты чата ${chat.chatId}, пропускаю`);
      continue;
    }

    for (const alert of fired) {
      triggered.push({ chatId: chat.chatId, alert });
    }
  }

  return triggered;
}
