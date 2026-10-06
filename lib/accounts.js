/**
 * Сценарии регистрации и входа.
 *
 * Отделены от HTTP-функции, чтобы проверяться тестами без запросов.
 */
import {
  ROLES,
  hashPassword,
  issueToken,
  validateLogin,
  validatePassword,
  verifyPassword,
} from './auth.js';
import { getAdminCredentials, getSessionSecret } from './config.js';
import { getAccount, saveAccount } from './storage.js';

/** Является ли логин админским. */
function isAdminLogin(login) {
  return login === getAdminCredentials().login;
}

/**
 * Регистрация нового пользователя.
 * @returns {Promise<{ok:true, token:string, account:object} | {ok:false, reason:string}>}
 */
export async function register(rawLogin, rawPassword) {
  const login = validateLogin(rawLogin);
  if (!login.ok) return { ok: false, reason: login.reason };

  const password = validatePassword(rawPassword);
  if (!password.ok) return { ok: false, reason: password.reason };

  // Админский логин занят владельцем и через регистрацию недоступен.
  if (isAdminLogin(login.value)) {
    return { ok: false, reason: 'Этот логин занят' };
  }
  if (await getAccount(login.value)) {
    return { ok: false, reason: 'Этот логин занят' };
  }

  const account = {
    login: login.value,
    passwordHash: hashPassword(password.value),
    role: ROLES.USER,
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };

  if (!(await saveAccount(account))) {
    return { ok: false, reason: 'Не удалось сохранить аккаунт, попробуйте позже' };
  }

  return { ok: true, token: issueToken(account, getSessionSecret()), account: publicView(account) };
}

/**
 * Вход.
 *
 * Админ проверяется по переменным окружения, обычные пользователи —
 * по хешу из хранилища.
 */
export async function login(rawLogin, rawPassword) {
  const login = String(rawLogin ?? '').trim().toLowerCase();
  const password = String(rawPassword ?? '');

  // Намеренно одинаковый текст для «нет такого логина» и «неверный пароль»:
  // иначе форма превращается в способ узнать, какие логины существуют.
  const wrong = { ok: false, reason: 'Неверный логин или пароль' };

  if (!login || !password) return wrong;

  if (isAdminLogin(login)) {
    const admin = getAdminCredentials();
    if (password !== admin.password) return wrong;

    const account = { login, role: ROLES.ADMIN };
    return { ok: true, token: issueToken(account, getSessionSecret()), account };
  }

  const account = await getAccount(login);
  if (!account || !verifyPassword(password, account.passwordHash)) return wrong;

  // Отметка последнего входа полезна в панели; сбой записи не критичен.
  await saveAccount({ ...account, lastLoginAt: new Date().toISOString() });

  return {
    ok: true,
    token: issueToken(account, getSessionSecret()),
    account: publicView(account),
  };
}

/** Представление аккаунта без хеша пароля. */
function publicView(account) {
  const { passwordHash, ...safe } = account;
  return safe;
}
