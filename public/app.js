/* ===========================================================================
   Логика панели управления.

   Без фреймворков: получаем JSON от /api/admin и собираем разметку руками.
   Пароль хранится в sessionStorage — он живёт до закрытия вкладки и,
   в отличие от localStorage, не остаётся на чужом компьютере навсегда.
   =========================================================================== */

const API = '/api/admin';
const STORAGE_KEY = 'aurum-admin-password';

const $ = (id) => document.getElementById(id);

/* ---------- Переключение витрины и панели ---------- */

function showPanel() {
  $('public-view').classList.add('hidden');
  $('panel-view').classList.remove('hidden');
  window.scrollTo(0, 0);

  // Если пароль уже вводили в этой вкладке — сразу грузим данные.
  const saved = readPassword();
  if (saved) load(saved);
}

function showPublic() {
  $('panel-view').classList.add('hidden');
  $('public-view').classList.remove('hidden');
  window.scrollTo(0, 0);
}

/* ---------- Хранение пароля ---------- */

function readPassword() {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Приватный режим браузера может запрещать доступ к хранилищу.
    return null;
  }
}

function writePassword(value) {
  try {
    if (value === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* Не критично: просто придётся вводить пароль заново. */
  }
}

/* ---------- Запрос данных ---------- */

async function load(password) {
  $('login-error').textContent = '';
  $('panel-error').textContent = '';

  let response;
  try {
    // Пароль уходит телом запроса, а не заголовком: заголовки HTTP
    // допускают только латиницу, и пароль с кириллицей отправить нельзя.
    response = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    $('panel-error').textContent = 'Сеть недоступна. Проверьте соединение.';
    return;
  }

  if (response.status === 401) {
    writePassword(null);
    $('dashboard').classList.add('hidden');
    $('login-card').classList.remove('hidden');
    $('login-error').textContent = 'Неверный пароль';
    return;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    $('panel-error').textContent = body.error ?? `Ошибка сервера (${response.status})`;
    return;
  }

  writePassword(password);
  $('login-card').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  render(await response.json());
}

/* ---------- Вспомогательные ---------- */

/** Число или прочерк, если значение не посчиталось. */
const num = (value, digits = 2) =>
  Number.isFinite(value) ? value.toFixed(digits) : '—';

/** Экранирование: данные приходят от пользователей бота. */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const dt = (ms) =>
  ms ? new Date(ms).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/** Карточка с крупным числом. */
function statCard(label, value, sub = '', extra = '') {
  return `<div class="card stat">
    <span class="stat-label">${label}</span>
    <span class="stat-value">${value}</span>
    ${sub ? `<span class="stat-sub">${sub}</span>` : ''}
    ${extra}
  </div>`;
}

/** Точка состояния службы. */
const dot = (state) =>
  `<span class="dot dot-${state}"></span>`;

/* ---------- Отрисовка ---------- */

function render(data) {
  $('updated-at').textContent = `Обновлено ${dt(data.generatedAt)}`;

  renderHealth(data);
  renderMarket(data);
  renderAlerts(data.alerts);
  renderUsers(data);

  if (data.errors.length > 0) {
    const list = data.errors.map((e) => `${esc(e.section)}: ${esc(e.error)}`).join('; ');
    $('panel-error').textContent = `Недоступны разделы — ${list}`;
  }
}

function renderHealth(data) {
  const cards = [];

  // Расход кредитов Twelve Data с полосой заполнения.
  if (data.usage) {
    const { dailyUsed, dailyLimit, minuteUsed, minuteLimit, plan } = data.usage;
    const percent = dailyLimit ? Math.round((dailyUsed / dailyLimit) * 100) : 0;
    const level = percent > 85 ? 'high' : percent > 60 ? 'mid' : '';
    cards.push(
      statCard(
        'Кредиты Twelve Data',
        `${dailyUsed} / ${dailyLimit}`,
        `${percent}% дневного лимита · тариф ${esc(plan ?? '—')} · ${minuteUsed}/${minuteLimit} в минуту`,
        `<div class="bar"><div class="bar-fill ${level}" style="width:${Math.min(percent, 100)}%"></div></div>`,
      ),
    );
  } else {
    cards.push(statCard('Кредиты Twelve Data', '—', 'данные недоступны'));
  }

  // Вебхук Telegram.
  if (data.webhook) {
    const bad = Boolean(data.webhook.lastError);
    cards.push(
      statCard(
        'Вебхук Telegram',
        `${dot(bad ? 'bad' : 'ok')}${bad ? 'ошибка' : 'работает'}`,
        bad
          ? `${esc(data.webhook.lastError)} · ${dt(data.webhook.lastErrorAt)}`
          : `в очереди ${data.webhook.pending} апдейтов`,
      ),
    );
  } else {
    cards.push(statCard('Вебхук Telegram', `${dot('bad')}недоступен`));
  }

  // Хранилище.
  cards.push(
    statCard(
      'Хранилище Blobs',
      `${dot(data.storage.ok ? 'ok' : 'bad')}${data.storage.ok ? 'доступно' : 'ошибка'}`,
      data.storage.ok ? 'чтение и запись' : esc(data.storage.error ?? ''),
    ),
  );

  // Макроданные.
  if (data.macro) {
    cards.push(
      statCard(
        'Реальная доходность',
        `${num(data.macro.value)}%`,
        `${esc(data.macro.seriesId)} · на ${esc(data.macro.date)}` +
          (data.macro.change === null
            ? ''
            : ` · ${data.macro.change > 0 ? '+' : ''}${data.macro.change} п.п.`),
      ),
    );
  } else {
    cards.push(statCard('Реальная доходность', '—', 'FRED недоступен'));
  }

  $('health').innerHTML = cards.join('');
}

function renderMarket(data) {
  const market = data.market;
  if (!market) {
    $('market').innerHTML = statCard('Рынок', '—', 'данные недоступны');
    $('pivots-table').innerHTML = '';
    return;
  }

  const trendText = { up: 'восходящий', down: 'нисходящий', flat: 'боковик', unknown: 'не определён' };
  const trendClass = market.trend === 'up' ? 'up' : market.trend === 'down' ? 'down' : '';
  const sessionNames = { asia: 'Азия', london: 'Лондон', newyork: 'Нью-Йорк' };
  const sessions =
    market.sessions.length > 0
      ? market.sessions.map((s) => sessionNames[s] ?? s).join(' + ')
      : 'затишье';

  $('market').innerHTML = [
    statCard(
      esc(market.symbol),
      num(market.price),
      `свеча от ${dt(market.candleTime)}${market.marketOpen ? '' : ' · рынок закрыт'}`,
    ),
    statCard(
      'Тренд',
      `<span class="${trendClass}">${trendText[market.trend]}</span>`,
      `EMA 50 / 200: ${num(market.indicators.ema50)} / ${num(market.indicators.ema200)}`,
    ),
    statCard('RSI(14)', num(market.indicators.rsi14, 1), `ATR(14): ${num(market.indicators.atr14)}`),
    statCard('Сессия', sessions, market.marketOpen ? 'торги идут' : 'торги закрыты'),
  ].join('');

  // Пивот-уровни: сверху сопротивления, снизу поддержки.
  if (market.pivots) {
    const order = ['r3', 'r2', 'r1', 'pp', 's1', 's2', 's3'];
    const rows = order
      .map((key) => {
        const value = market.pivots[key];
        const above = value > market.price;
        const diff = value - market.price;
        return `<tr>
          <td class="mono">${key.toUpperCase()}</td>
          <td class="mono">${num(value)}</td>
          <td class="mono ${above ? 'up' : 'down'}">${diff > 0 ? '+' : ''}${num(diff)}</td>
          <td class="muted">${above ? 'сопротивление' : 'поддержка'}</td>
        </tr>`;
      })
      .join('');
    $('pivots-table').innerHTML =
      `<thead><tr><th>Уровень</th><th>Цена</th><th>От текущей</th><th></th></tr></thead><tbody>${rows}</tbody>`;
  }
}

function renderAlerts(alerts) {
  if (alerts.length === 0) {
    $('alerts-table').innerHTML =
      '<tbody><tr><td class="muted">Активных уведомлений нет</td></tr></tbody>';
    return;
  }

  const rows = alerts
    .map(
      (alert) => `<tr>
      <td class="mono">${esc(alert.chatId)}</td>
      <td>${alert.direction === 'above' ? '🔼 вверх' : '🔽 вниз'}</td>
      <td class="mono">${num(alert.price)}</td>
      <td class="mono ${alert.distance > 0 ? 'up' : 'down'}">
        ${alert.distance === null ? '—' : `${alert.distance > 0 ? '+' : ''}${num(alert.distance)}`}
      </td>
      <td class="mono muted">${alert.distancePercent === null ? '—' : `${num(alert.distancePercent)}%`}</td>
      <td class="muted">${dt(Date.parse(alert.createdAt))}</td>
    </tr>`,
    )
    .join('');

  $('alerts-table').innerHTML =
    `<thead><tr><th>Чат</th><th>Направление</th><th>Уровень</th><th>До цели</th><th>%</th><th>Создан</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderUsers(data) {
  const subscribed = new Set(data.subscribers.map((s) => s.chatId));

  if (data.users.length === 0) {
    $('users-table').innerHTML = '<tbody><tr><td class="muted">Пользователей пока нет</td></tr></tbody>';
    return;
  }

  const rows = data.users
    .map(
      (user) => `<tr>
      <td class="mono">${esc(user.chatId)}</td>
      <td>${esc(user.lang === 'en' ? '🇬🇧 English' : '🇷🇺 Русский')}</td>
      <td>${subscribed.has(user.chatId) ? '✅ подписан' : '—'}</td>
      <td class="muted">${dt(Date.parse(user.updatedAt))}</td>
    </tr>`,
    )
    .join('');

  $('users-table').innerHTML =
    `<thead><tr><th>Чат</th><th>Язык</th><th>Сводка</th><th>Последняя активность</th></tr></thead><tbody>${rows}</tbody>` +
    `<tfoot><tr><td colspan="4" class="muted">Всего ${data.users.length}, подписано ${data.subscribers.length}</td></tr></tfoot>`;
}

/* ---------- События ---------- */

$('open-panel').addEventListener('click', showPanel);
$('logout').addEventListener('click', () => {
  writePassword(null);
  $('dashboard').classList.add('hidden');
  $('login-card').classList.remove('hidden');
  $('password').value = '';
  showPublic();
});

$('login').addEventListener('click', () => {
  const value = $('password').value.trim();
  if (value) load(value);
});

// Enter в поле пароля срабатывает как нажатие кнопки.
$('password').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('login').click();
});

$('refresh').addEventListener('click', () => {
  const saved = readPassword();
  if (saved) load(saved);
});

// Прямая ссылка на панель: /#panel
if (location.hash === '#panel') showPanel();
