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

/**
 * Telegram ID владельца.
 *
 * Это единственный способ стать владельцем: роль задаётся переменной
 * окружения, а не хранится в базе. Подделать нельзя — профиль приходит
 * от Telegram подписанным токеном бота.
 */
export function getOwnerTelegramId() {
  const raw = optional('OWNER_TELEGRAM_ID', null) ?? optional('ADMIN_TELEGRAM_ID', null);
  if (raw === null) return null;

  const id = Number(raw);
  if (!Number.isInteger(id)) {
    throw new ConfigError('OWNER_TELEGRAM_ID должен быть числом');
  }
  return id;
}

/**
 * Адрес веб-версии для кнопки в боте.
 *
 * На Netlify переменная URL проставляется автоматически. Локально
 * netlify dev подставляет в неё http://localhost — а Telegram принимает
 * в кнопках веб-приложения только HTTPS и на остальное отвечает ошибкой.
 * Поэтому не-HTTPS адрес считаем отсутствующим: бот просто покажет меню
 * без кнопки приложения вместо того, чтобы упасть.
 */
export function getWebAppUrl() {
  const url = optional('WEBAPP_URL', null) ?? optional('URL', null);
  if (!url || !url.startsWith('https://')) return null;
  return url.replace(/\/+$/, '');
}

/**
 * Секрет для подписи токенов сессии.
 *
 * Если его сменить, все выданные сессии перестанут действовать —
 * это и есть способ разом разлогинить всех.
 */
export function getSessionSecret() {
  return required('SESSION_SECRET');
}

/**
 * Ключ Gemini — нужен только слою объяснений.
 *
 * Без него бот и панель работают полностью: модель добавляет
 * комментарии, но ничего не решает.
 */
export function getLlmConfig() {
  const model = optional('GEMINI_MODEL', 'gemini-2.5-flash');

  // Свой ключ Google — основной путь. Бесплатный тариф Gemini, кредиты
  // Netlify не расходуются.
  const ownKey = optional('GOOGLE_AI_KEY', null);
  if (ownKey) {
    return {
      apiKey: ownKey,
      model,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      via: 'google',
    };
  }

  // Запасной путь — AI Gateway самого Netlify. Он подставляет в функции
  // GEMINI_API_KEY (служебный токен, не ключ Google) вместе с адресом
  // шлюза. Работает без регистрации, но расходует кредиты Netlify,
  // поэтому основным его делать не стоит.
  const gatewayUrl = optional('GOOGLE_GEMINI_BASE_URL', null);
  const gatewayKey = optional('GEMINI_API_KEY', null);
  if (gatewayUrl && gatewayKey) {
    return {
      apiKey: gatewayKey,
      model,
      baseUrl: gatewayUrl.replace(/\/+$/, ''),
      via: 'netlify-gateway',
    };
  }

  throw new ConfigError('Не задан GOOGLE_AI_KEY — ключ Gemini для разбора обстановки');
}

/**
 * Настроен ли слой модели.
 *
 * Проверять только GEMINI_API_KEY нельзя: Netlify подставляет её сам
 * для своего шлюза, и без учёта адреса шлюза код принял бы служебный
 * токен за ключ Google и ушёл бы с ним не туда.
 */
export function hasLlm() {
  if (process.env.GOOGLE_AI_KEY?.trim()) return true;
  return Boolean(process.env.GOOGLE_GEMINI_BASE_URL?.trim() && process.env.GEMINI_API_KEY?.trim());
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
