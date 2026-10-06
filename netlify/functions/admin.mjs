/**
 * API панели администратора.
 *
 * Отдаёт состояние системы, пользователей, алерты и рыночные данные.
 * Всё это — персональные данные пользователей бота, поэтому доступ
 * только по паролю.
 */
import { timingSafeEqual } from 'node:crypto';
import { collectAdminData } from '../../lib/admin.js';
import { ConfigError, getAdminPassword } from '../../lib/config.js';

/**
 * Сравнение паролей за постоянное время.
 *
 * Обычное сравнение строк прерывается на первом несовпавшем символе,
 * и по времени ответа пароль теоретически можно подобрать посимвольно.
 * timingSafeEqual этого не допускает.
 */
function passwordMatches(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  // Длины тоже сравниваем, но только после выравнивания буферов:
  // timingSafeEqual требует одинакового размера.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Достаёт пароль из запроса.
 *
 * Основной путь — тело POST-запроса. Заголовок Authorization использовать
 * как основной нельзя: HTTP-заголовки допускают только латиницу (ByteString),
 * и пароль с кириллицей браузер отказался бы отправить, уронив fetch ещё
 * до запроса. Телом же передаётся UTF-8, поэтому пароль может быть любым.
 *
 * Заголовок остаётся запасным путём — им удобно проверять панель из curl.
 */
async function extractPassword(request) {
  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (typeof body?.password === 'string') return body.password;
  }

  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Панель с персональными данными не должна оседать в кэшах.
      'cache-control': 'no-store',
    },
  });

export default async (request) => {
  let expected;
  try {
    expected = getAdminPassword();
  } catch (error) {
    if (error instanceof ConfigError) {
      return json({ error: 'Панель не настроена: не задан ADMIN_PASSWORD' }, 503);
    }
    throw error;
  }

  const provided = await extractPassword(request);
  if (!provided || !passwordMatches(provided, expected)) {
    console.warn('[admin] отклонён вход с неверным паролем');
    // Небольшая задержка снижает скорость перебора.
    await new Promise((resolve) => setTimeout(resolve, 700));
    return json({ error: 'Неверный пароль' }, 401);
  }

  try {
    return json(await collectAdminData());
  } catch (error) {
    console.error('[admin] сбой сбора данных:', error);
    return json({ error: 'Не удалось собрать данные' }, 500);
  }
};

export const config = {
  path: '/api/admin',
};
