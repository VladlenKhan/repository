/**
 * Аккаунты сайта.
 *
 * Регистрация одна — через Telegram. Пароли не используются и не хранятся:
 * профиль приходит от Telegram подписанным токеном бота, подделать его
 * нельзя. Логин аккаунта строится из Telegram ID, потому что ID не
 * меняется, а имя пользователя человек может сменить в любой момент.
 */
import {
  ASSIGNABLE_ROLES,
  ROLES,
  TOKEN_KIND,
  isKnownRole,
  issueLoginCode,
  issueToken,
  verifyToken,
} from './auth.js';
import { getOwnerTelegramId, getSessionSecret, getTelegramConfig } from './config.js';
import { deletePerson, getAccount, saveAccount } from './storage.js';
import { displayName, validateInitData } from './telegram-auth.js';

/** Логин аккаунта по идентификатору Telegram. */
export const loginFor = (telegramId) => `tg${telegramId}`;

/**
 * Вход через Telegram.
 *
 * Роль владельца выдаётся по переменной окружения и не хранится в базе —
 * её нельзя получить, подправив запись. Остальные роли берутся из
 * сохранённого аккаунта; новый пользователь получает роль user.
 *
 * @param {string} initData - строка, которую Telegram кладёт в мини-приложение
 */
export async function loginWithTelegram(initData) {
  const { token } = getTelegramConfig();
  const result = validateInitData(initData, token);
  if (!result.ok) return { ok: false, reason: result.reason };

  const telegramId = result.user.id;
  const login = loginFor(telegramId);
  const existing = await getAccount(login);

  const ownerId = getOwnerTelegramId();
  const isOwner = ownerId !== null && telegramId === ownerId;

  // Владелец определяется окружением, остальные — сохранённой ролью.
  const role = isOwner
    ? ROLES.OWNER
    : isKnownRole(existing?.role) && existing.role !== ROLES.OWNER
      ? existing.role
      : ROLES.USER;

  const account = {
    login,
    role,
    telegramId,
    username: result.user.username ?? null,
    displayName: displayName(result.user),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };

  await saveAccount(account);

  return { ok: true, token: issueToken(account, getSessionSecret()), account };
}

/**
 * Меняет роль пользователя. Доступно только владельцу.
 *
 * Собственную роль владельца менять нельзя: она задана окружением,
 * запись в базе на неё всё равно не влияет.
 *
 * @returns {Promise<{ok:true, account:object} | {ok:false, reason:string}>}
 */
export async function setRole(login, role) {
  if (!ASSIGNABLE_ROLES.includes(role)) {
    return { ok: false, reason: 'Такую роль назначить нельзя' };
  }

  const account = await getAccount(login);
  if (!account) return { ok: false, reason: 'Аккаунт не найден' };

  const ownerId = getOwnerTelegramId();
  if (ownerId !== null && account.telegramId === ownerId) {
    return { ok: false, reason: 'Роль владельца изменить нельзя' };
  }

  const updated = { ...account, role, roleChangedAt: new Date().toISOString() };
  if (!(await saveAccount(updated))) {
    return { ok: false, reason: 'Не удалось сохранить изменение' };
  }

  return { ok: true, account: updated };
}


/**
 * Выпускает ссылку для входа в обычном браузере.
 *
 * Внутри Telegram вход происходит сам, но на компьютере человек может
 * открыть сайт напрямую — там профиля от Telegram нет. Бот знает, кто
 * к нему обратился, поэтому выдаёт короткоживущий код.
 *
 * Если аккаунта ещё нет, он создаётся здесь же: источник данных тот же
 * самый — профиль из апдейта Telegram, подлинность которого уже
 * подтверждена секретом вебхука.
 *
 * @param {{id:number, username?:string, first_name?:string, last_name?:string}} user
 * @param {string} siteUrl
 */
export async function createLoginLink(user, siteUrl) {
  const telegramId = user.id;
  const login = loginFor(telegramId);
  const existing = await getAccount(login);

  const ownerId = getOwnerTelegramId();
  const isOwner = ownerId !== null && telegramId === ownerId;

  const role = isOwner
    ? ROLES.OWNER
    : isKnownRole(existing?.role) && existing.role !== ROLES.OWNER
      ? existing.role
      : ROLES.USER;

  await saveAccount({
    login,
    role,
    telegramId,
    username: user.username ?? null,
    displayName: displayName(user),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastLoginAt: existing?.lastLoginAt ?? new Date().toISOString(),
  });

  const code = issueLoginCode({ login, role }, getSessionSecret());

  // Код уходит в хеш-фрагмент: он не отправляется на сервер в заголовке
  // Referer и не попадает в логи веб-сервера.
  return `${siteUrl}/#login=${code}`;
}

/**
 * Меняет код из ссылки на обычную сессию.
 */
export async function loginWithCode(code) {
  const payload = verifyToken(code, getSessionSecret(), { kind: TOKEN_KIND.LOGIN });
  if (!payload) return { ok: false, reason: 'Ссылка устарела или недействительна' };

  const account = await getAccount(payload.login);
  if (!account) return { ok: false, reason: 'Аккаунт не найден' };

  const ownerId = getOwnerTelegramId();
  const role =
    ownerId !== null && account.telegramId === ownerId ? ROLES.OWNER : account.role;

  const updated = { ...account, role, lastLoginAt: new Date().toISOString() };
  await saveAccount(updated);

  return { ok: true, token: issueToken(updated, getSessionSecret()), account: updated };
}

/**
 * Удаляет человека целиком. Доступно только владельцу.
 *
 * Себя удалить нельзя: роль владельца задана окружением, запись
 * пересоздалась бы при следующем входе, а подписки и уведомления
 * пропали бы без причины.
 */
export async function removePerson(telegramId) {
  // Проверяем до преобразования: Number(null) и Number('') дают ноль,
  // а не NaN, и пустое значение прошло бы как корректный номер.
  if (telegramId === null || telegramId === undefined || telegramId === '') {
    return { ok: false, reason: 'Некорректный идентификатор' };
  }

  const id = Number(telegramId);
  if (!Number.isInteger(id) || id === 0) {
    return { ok: false, reason: 'Некорректный идентификатор' };
  }

  const ownerId = getOwnerTelegramId();
  if (ownerId !== null && id === ownerId) {
    return { ok: false, reason: 'Владельца удалить нельзя' };
  }

  const result = await deletePerson(id);
  if (result.failed.length > 0) {
    return { ok: false, reason: `Не удалось очистить: ${result.failed.join(', ')}` };
  }

  return { ok: true, removed: result.removed };
}
