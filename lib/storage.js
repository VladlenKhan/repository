/**
 * Хранилище на Netlify Blobs.
 *
 * На этом этапе хранятся только настройки пользователя (язык).
 * Подписчики, алерты и кэш свечей добавятся позже — структура ключей
 * рассчитана на это заранее.
 *
 * Важно: Blobs недоступны вне окружения Netlify (например, в юнит-тестах),
 * поэтому все обращения обёрнуты в try/catch. Бот должен ответить
 * пользователю даже если хранилище прилегло — просто настройками
 * по умолчанию.
 */
import { getStore } from '@netlify/blobs';
import { getDefaultLang } from './config.js';
import { isLang } from './i18n.js';

const STORE_USERS = 'users';

/** Ленивое получение стора: не дёргаем Blobs, пока они реально не нужны. */
function store(name) {
  return getStore({ name, consistency: 'strong' });
}

/**
 * Настройки пользователя. Если записи нет или хранилище недоступно,
 * возвращаем значения по умолчанию.
 * @param {number} chatId
 * @returns {Promise<{lang: string}>}
 */
export async function getUserSettings(chatId) {
  const defaults = { lang: getDefaultLang() };
  try {
    const saved = await store(STORE_USERS).get(String(chatId), { type: 'json' });
    if (!saved) return defaults;
    return { lang: isLang(saved.lang) ? saved.lang : defaults.lang };
  } catch (error) {
    console.error('[storage] не удалось прочитать настройки', error);
    return defaults;
  }
}

/**
 * Сохраняет настройки пользователя, дополняя уже существующие.
 * @param {number} chatId
 * @param {{lang?: string}} patch
 */
export async function saveUserSettings(chatId, patch) {
  try {
    const current = await getUserSettings(chatId);
    await store(STORE_USERS).setJSON(String(chatId), {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.error('[storage] не удалось сохранить настройки', error);
    return false;
  }
}

// ===== Кэш свечей =====
//
// Бесплатный тариф Twelve Data даёт 800 кредитов в сутки и 8 в минуту.
// Без кэша каждая команда любого пользователя била бы в API напрямую,
// и лимит 8/минуту выбивался бы на ровном месте. Храним ответ на время,
// равное четверти таймфрейма: свеча за это время всё равно не закроется.

const STORE_CACHE = 'candles';

/**
 * Читает свечи из кэша. Просроченную запись считаем отсутствующей.
 * @returns {Promise<Array|null>}
 */
export async function getCachedCandles(key) {
  try {
    const entry = await store(STORE_CACHE).get(key, { type: 'json' });
    if (!entry || typeof entry.expiresAt !== 'number') return null;
    if (entry.expiresAt < Date.now()) return null;
    return entry.candles;
  } catch (error) {
    console.error('[storage] кэш свечей недоступен при чтении', error);
    return null;
  }
}

/**
 * Кладёт свечи в кэш. Сбой записи не должен ломать ответ пользователю —
 * данные уже получены, кэш лишь экономит лимит на будущее.
 */
export async function setCachedCandles(key, candles, ttlMs) {
  try {
    await store(STORE_CACHE).setJSON(key, {
      candles,
      expiresAt: Date.now() + ttlMs,
    });
  } catch (error) {
    console.error('[storage] кэш свечей недоступен при записи', error);
  }
}

// ===== Подписчики утренней сводки =====

const STORE_SUBSCRIBERS = 'subscribers';

/** Добавляет подписчика. Повторная подписка просто обновляет запись. */
export async function subscribe(chatId, lang) {
  try {
    await store(STORE_SUBSCRIBERS).setJSON(String(chatId), {
      chatId,
      lang,
      createdAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.error('[storage] не удалось оформить подписку', error);
    return false;
  }
}

/** Убирает подписчика. */
export async function unsubscribe(chatId) {
  try {
    await store(STORE_SUBSCRIBERS).delete(String(chatId));
    return true;
  } catch (error) {
    console.error('[storage] не удалось отменить подписку', error);
    return false;
  }
}

/** Подписан ли чат. */
export async function isSubscribed(chatId) {
  try {
    const entry = await store(STORE_SUBSCRIBERS).get(String(chatId), { type: 'json' });
    return entry !== null && entry !== undefined;
  } catch (error) {
    console.error('[storage] не удалось проверить подписку', error);
    return false;
  }
}

/**
 * Все подписчики.
 *
 * list() отдаёт только ключи, поэтому за содержимым идём отдельными
 * запросами. Для учебного проекта с десятками подписчиков этого хватает;
 * на тысячах стоило бы хранить реестр одним документом.
 */
export async function listSubscribers() {
  try {
    const { blobs } = await store(STORE_SUBSCRIBERS).list();
    const entries = await Promise.all(
      blobs.map((blob) => store(STORE_SUBSCRIBERS).get(blob.key, { type: 'json' })),
    );
    return entries.filter(Boolean);
  } catch (error) {
    console.error('[storage] не удалось получить список подписчиков', error);
    return [];
  }
}

// ===== Уведомления о цене =====
//
// Алерты одного чата лежат одним документом: так их проще показывать
// и удалять целиком, а запись остаётся атомарной.

const STORE_ALERTS = 'alerts';

/** Алерты одного чата. */
export async function getAlerts(chatId) {
  try {
    const entry = await store(STORE_ALERTS).get(String(chatId), { type: 'json' });
    return Array.isArray(entry?.items) ? entry.items : [];
  } catch (error) {
    console.error('[storage] не удалось прочитать алерты', error);
    return [];
  }
}

/** Перезаписывает список алертов чата. Пустой список удаляет документ. */
export async function saveAlerts(chatId, items) {
  try {
    if (items.length === 0) {
      await store(STORE_ALERTS).delete(String(chatId));
    } else {
      await store(STORE_ALERTS).setJSON(String(chatId), { chatId, items });
    }
    return true;
  } catch (error) {
    console.error('[storage] не удалось сохранить алерты', error);
    return false;
  }
}

/** Все алерты всех чатов — нужны функции по расписанию. */
export async function listAllAlerts() {
  try {
    const { blobs } = await store(STORE_ALERTS).list();
    const entries = await Promise.all(
      blobs.map((blob) => store(STORE_ALERTS).get(blob.key, { type: 'json' })),
    );
    return entries.filter((entry) => entry && Array.isArray(entry.items));
  } catch (error) {
    console.error('[storage] не удалось получить список алертов', error);
    return [];
  }
}
