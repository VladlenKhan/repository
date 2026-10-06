/**
 * Чтение и проверка переменных окружения.
 *
 * Проверки намеренно разбиты по функциям, а не собраны в один объект на
 * старте модуля: без ключа FRED команда /start должна работать, и бот не
 * обязан падать целиком из-за ключа, который нужен только одной команде.
 */

/** Ошибка конфигурации — отличаем её от сетевых и прочих сбоев. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Читает обязательную переменную или бросает понятную ошибку. */
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `Не задана переменная окружения ${name}. Скопируйте .env.example в .env и заполните её.`,
    );
  }
  return value;
}

/** Читает необязательную переменную со значением по умолчанию. */
function optional(name, fallback) {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

/** Настройки Telegram — нужны всегда. */
export function getTelegramConfig() {
  return {
    token: required('TELEGRAM_BOT_TOKEN'),
    webhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
  };
}

/** Ключ Twelve Data — нужен командам с ценами. */
export function getPricesConfig() {
  return {
    apiKey: required('TWELVE_DATA_API_KEY'),
    symbol: optional('MARKET_SYMBOL', 'XAU/USD'),
  };
}

/** Ключ FRED — нужен только команде /macro. */
export function getMacroConfig() {
  return {
    apiKey: required('FRED_API_KEY'),
    seriesId: optional('FRED_SERIES_ID', 'DFII10'),
  };
}

/** Язык по умолчанию для тех, кто ещё не выбирал. */
export function getDefaultLang() {
  const lang = optional('DEFAULT_LANG', 'ru');
  return lang === 'en' ? 'en' : 'ru';
}

/** Публичный адрес сайта. Netlify сам задаёт URL в окружении сборки. */
export function getSiteUrl() {
  const url = optional('URL', null) ?? optional('DEPLOY_PRIME_URL', null);
  if (!url) {
    throw new ConfigError('Не задана переменная URL — укажите адрес сайта Netlify.');
  }
  return url.replace(/\/+$/, '');
}

/**
 * Данные о боте (результат getMe) в виде JSON-строки.
 *
 * grammY на каждом холодном старте вызывает getMe, чтобы узнать имя бота.
 * На serverless это лишний сетевой запрос внутри и без того короткого
 * лимита выполнения. Если положить ответ getMe в переменную окружения,
 * этот запрос не понадобится. Переменная необязательная: без неё бот
 * просто работает чуть медленнее на холодную.
 *
 * Готовую строку печатает `npm run set-webhook`.
 */
export function getBotInfo() {
  const raw = process.env.TELEGRAM_BOT_INFO?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.error('[config] TELEGRAM_BOT_INFO не разбирается как JSON, игнорирую.');
    return null;
  }
}
