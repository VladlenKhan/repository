/* ===========================================================================
   Логика сайта: вход через Telegram, роли, вкладки, автообновление.

   Без фреймворков. Всё состояние — в одном объекте, разметка собирается
   строками. Так видно, что происходит, без промежуточных абстракций.
   =========================================================================== */

import { initChart, setChartToken, stopChart } from './chart.js';
import { loadTrading, setTradingToken } from './trading.js';
import { setBacktestToken } from './backtest.js';
import { setAiToken } from './ai.js';

const API_AUTH = '/api/auth';
const API_DATA = '/api/data';
const API_PEOPLE = '/api/people';
const TOKEN_KEY = 'aurum-token';
const REFRESH_MS = 20000;

const $ = (id) => document.getElementById(id);

const state = {
  token: null,
  account: null,
  tab: 'overview',
  people: [],
  timer: null,
  tickTimer: null,
  lastUpdate: null,
  canManageRoles: false,
};

const ROLE_LABEL = {
  owner: 'Владелец',
  admin: 'Админ',
  user: 'Пользователь',
  guest: 'Гость',
};

/* ======================= Хранение токена ======================= */

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Приватный режим браузера может запрещать доступ к хранилищу.
    return null;
  }
}

function writeToken(value) {
  try {
    if (value === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, value);
  } catch {
    /* Не критично: вход просто не переживёт перезагрузку. */
  }
}

/* ======================= Вход по ссылке ======================= */

/**
 * Код из ссылки, которую прислал бот.
 *
 * Лежит в хеш-фрагменте: он не уходит на сервер в заголовке Referer
 * и не попадает в логи. Сразу после чтения стираем его из адресной
 * строки, чтобы код не остался в истории браузера.
 */
function takeLoginCode() {
  const match = location.hash.match(/^#login=(.+)$/);
  if (!match) return null;

  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(match[1]);
}

async function loginWithCode(code) {
  try {
    const response = await fetch(API_AUTH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginCode: code }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      $('auth-error').textContent = body.error ?? 'Ссылка не подошла';
      show('auth-view');
      return;
    }

    state.token = body.token;
    state.account = body.account;
    writeToken(body.token);
    setChartToken(body.token);
    setTradingToken(body.token);
    setBacktestToken(body.token);
    setAiToken(body.token);

    renderAccount();
    openPanel();
  } catch {
    $('auth-error').textContent = 'Сеть недоступна';
    show('auth-view');
  }
}

/* ======================= Экраны ======================= */

function show(view) {
  for (const id of ['public-view', 'auth-view', 'panel-view']) {
    $(id).classList.toggle('hidden', id !== view);
  }
  window.scrollTo(0, 0);
}

/* ======================= Шапка ======================= */

function renderAccount() {
  const area = $('account-area');

  if (!state.account) {
    area.innerHTML = '<button class="btn btn-sm" id="to-auth">Войти</button>';
    $('to-auth').addEventListener('click', () => show('auth-view'));
    return;
  }

  const role = state.account.role;
  area.innerHTML = `
    <span class="user-name">${esc(state.account.displayName ?? state.account.login)}</span>
    <span class="role role-${role}">${ROLE_LABEL[role] ?? role}</span>
    <button class="btn btn-sm" id="to-panel">Панель</button>
    <button class="btn btn-sm" id="logout">Выйти</button>`;

  $('to-panel').addEventListener('click', openPanel);
  $('logout').addEventListener('click', logout);
}

/* ======================= Вход и выход ======================= */

/** Строка initData появляется, только когда страница открыта из бота. */
function telegramInitData() {
  const webApp = window.Telegram?.WebApp;
  return webApp?.initData && webApp.initData.length > 0 ? webApp.initData : null;
}

async function loginWithTelegram(initData) {
  try {
    const response = await fetch(API_AUTH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      $('auth-error').textContent = body.error ?? 'Telegram не подтвердил вход';
      show('auth-view');
      return;
    }

    state.token = body.token;
    state.account = body.account;
    writeToken(body.token);
    setChartToken(body.token);
    setTradingToken(body.token);
    setBacktestToken(body.token);
    setAiToken(body.token);

    renderAccount();
    openPanel();
  } catch {
    $('auth-error').textContent = 'Сеть недоступна';
    show('auth-view');
  }
}

/**
 * Полный выход.
 *
 * Важно гасить всё разом: таймеры опроса, таймер счётчика, график,
 * сохранённый токен и содержимое панели. Если оставить хоть что-то,
 * на экране продолжает жить кусок предыдущей сессии — например,
 * пульсирующий индикатор «данные обновляются».
 */
function logout() {
  stopAutoRefresh();
  stopChart();

  state.token = null;
  state.account = null;
  state.lastUpdate = null;
  state.canManageRoles = false;
  state.tab = 'overview';
  writeToken(null);

  clearPanel();
  renderAccount();
  show('public-view');
}

/** Очищает панель, чтобы от прошлой сессии не осталось ничего видимого. */
function clearPanel() {
  for (const id of [
    'market', 'pivots-table', 'macro', 'health',
    'alerts-table', 'admins-table', 'users-table', 'people-summary',
  ]) {
    const node = $(id);
    if (node) node.innerHTML = '';
  }

  $('updated-at').textContent = 'обновляется…';
  $('panel-error').textContent = '';
  $('auth-error').textContent = '';

  for (const tab of document.querySelectorAll('.admin-tab')) tab.classList.add('hidden');
  switchTab('overview');
}

/* ======================= Вкладки ======================= */

function switchTab(name) {
  state.tab = name;

  for (const button of document.querySelectorAll('.tab-btn')) {
    button.classList.toggle('active', button.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll('.tab-pane')) {
    pane.classList.toggle('hidden', pane.dataset.pane !== name);
  }

  // График создаём только когда его открыли: пока вкладка скрыта,
  // у контейнера нулевая ширина и библиотека нарисовала бы пустоту.
  if (name === 'chart' && state.token) initChart(state.token);
  if (name === 'trading' && state.token) loadTrading();
}

/* ======================= Панель ======================= */

function openPanel() {
  show('panel-view');
  load();
  startAutoRefresh();
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.timer = setInterval(load, REFRESH_MS);
  state.tickTimer = setInterval(renderAge, 1000);
}

function stopAutoRefresh() {
  clearInterval(state.timer);
  clearInterval(state.tickTimer);
  state.timer = null;
  state.tickTimer = null;
}

document.addEventListener('visibilitychange', () => {
  const onPanel = !$('panel-view').classList.contains('hidden');
  if (!onPanel || !state.token) return;

  if (document.hidden) {
    stopAutoRefresh();
    stopChart();
  } else {
    load();
    startAutoRefresh();
    if (state.tab === 'chart') initChart(state.token);
  }
});

function renderAge() {
  if (state.lastUpdate === null) return;

  const seconds = Math.round((Date.now() - state.lastUpdate) / 1000);
  $('updated-at').textContent =
    seconds < 5 ? 'данные актуальны' : `обновлено ${seconds} ${plural(seconds)} назад`;
}

function plural(n) {
  const last = n % 10;
  const tens = n % 100;
  if (tens >= 11 && tens <= 14) return 'секунд';
  if (last === 1) return 'секунду';
  if (last >= 2 && last <= 4) return 'секунды';
  return 'секунд';
}

async function load() {
  if (!state.token) return;

  let response;
  try {
    response = await fetch(API_DATA, { headers: { authorization: `Bearer ${state.token}` } });
  } catch {
    $('panel-error').textContent = 'Сеть недоступна, следующая попытка через 20 секунд';
    return;
  }

  if (response.status === 401) {
    logout();
    $('auth-error').textContent = 'Сессия истекла, войдите заново';
    show('auth-view');
    return;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    $('panel-error').textContent = body.error ?? `Ошибка сервера (${response.status})`;
    return;
  }

  $('panel-error').textContent = '';
  render(await response.json());
}

/* ======================= Вспомогательные ======================= */

const num = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const dt = (ms) =>
  ms ? new Date(ms).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';

function statCard(label, value, sub = '', extra = '') {
  return `<div class="card stat">
    <span class="stat-label">${label}</span>
    <span class="stat-value">${value}</span>
    ${sub ? `<span class="stat-sub">${sub}</span>` : ''}
    ${extra}
  </div>`;
}

const dot = (s) => `<span class="dot dot-${s}"></span>`;

function put(id, html) {
  const node = $(id);
  if (!node) return;
  node.innerHTML = html;
  node.classList.remove('fade-in');
  void node.offsetWidth;
  node.classList.add('fade-in');
}

/* ======================= Отрисовка ======================= */

function render(data) {
  state.lastUpdate = Date.now();
  renderAge();

  if (state.account && data.role && state.account.role !== data.role) {
    state.account.role = data.role;
    renderAccount();
  }

  state.canManageRoles = data.canManageRoles === true;

  renderMarket(data);
  renderMacro(data);

  // Вкладки с персональными данными — от администратора и выше.
  const privileged = data.role === 'admin' || data.role === 'owner';
  for (const tab of document.querySelectorAll('.admin-tab')) {
    tab.classList.toggle('hidden', !privileged);
  }

  if (privileged) {
    renderHealth(data);
    renderAlerts(data.alerts ?? []);
    renderPeople(data);
  } else if (state.tab === 'people' || state.tab === 'system') {
    // Роль могли понизить, пока вкладка была открыта.
    switchTab('overview');
  }

  if (state.tab === 'trading') loadTrading();

  if (data.errors?.length) {
    $('panel-error').textContent =
      'Недоступны разделы — ' + data.errors.map((e) => `${esc(e.section)}: ${esc(e.error)}`).join('; ');
  }
}

function renderMarket(data) {
  const market = data.market;
  if (!market) {
    put('market', statCard('Рынок', '—', 'данные недоступны'));
    put('pivots-table', '');
    return;
  }

  const trendText = { up: 'восходящий', down: 'нисходящий', flat: 'боковик', unknown: 'не определён' };
  const trendClass = market.trend === 'up' ? 'up' : market.trend === 'down' ? 'down' : '';
  const names = { asia: 'Азия', london: 'Лондон', newyork: 'Нью-Йорк' };
  const sessions = market.sessions.length ? market.sessions.map((s) => names[s] ?? s).join(' + ') : 'затишье';

  put('market', [
    statCard(esc(market.symbol), num(market.price),
      `свеча от ${dt(market.candleTime)}${market.marketOpen ? '' : ' · рынок закрыт'}`),
    statCard('Тренд', `<span class="${trendClass}">${trendText[market.trend]}</span>`,
      `EMA 50 / 200: ${num(market.indicators.ema50)} / ${num(market.indicators.ema200)}`),
    statCard('RSI(14)', num(market.indicators.rsi14, 1), `ATR(14): ${num(market.indicators.atr14)}`),
    statCard('Сессия', sessions, market.marketOpen ? 'торги идут' : 'торги закрыты'),
  ].join(''));

  if (!market.pivots) return;

  const rows = ['r3', 'r2', 'r1', 'pp', 's1', 's2', 's3'].map((key) => {
    const value = market.pivots[key];
    const above = value > market.price;
    const diff = value - market.price;
    return `<tr>
      <td class="mono">${key.toUpperCase()}</td>
      <td class="mono">${num(value)}</td>
      <td class="mono ${above ? 'up' : 'down'}">${diff > 0 ? '+' : ''}${num(diff)}</td>
      <td class="muted">${above ? 'сопротивление' : 'поддержка'}</td>
    </tr>`;
  }).join('');

  put('pivots-table',
    `<thead><tr><th>Уровень</th><th>Цена</th><th>От текущей</th><th></th></tr></thead><tbody>${rows}</tbody>`);
}

function renderMacro(data) {
  if (!data.macro) {
    put('macro', statCard('Реальная доходность', '—', 'FRED недоступен'));
    return;
  }

  const state_ = {
    negative: 'отрицательная — золоту благоприятно',
    rising: 'растёт — давит на золото',
    falling: 'снижается — поддерживает золото',
    stable: 'без заметных движений',
  };

  put('macro', [
    statCard('Реальная доходность', `${num(data.macro.value)}%`,
      `${esc(data.macro.seriesId)} · на ${esc(data.macro.date)}`),
    statCard('Изменение',
      data.macro.change === null ? '—' : `${data.macro.change > 0 ? '+' : ''}${data.macro.change}`,
      state_[data.macro.state] ?? ''),
  ].join(''));
}

function renderHealth(data) {
  const cards = [];

  if (data.usage) {
    const { dailyUsed, dailyLimit, minuteUsed, minuteLimit, plan } = data.usage;
    const percent = dailyLimit ? Math.round((dailyUsed / dailyLimit) * 100) : 0;
    const level = percent > 85 ? 'high' : percent > 60 ? 'mid' : '';
    cards.push(statCard('Кредиты Twelve Data', `${dailyUsed} / ${dailyLimit}`,
      `${percent}% дневного лимита · тариф ${esc(plan ?? '—')} · ${minuteUsed}/${minuteLimit} в минуту`,
      `<div class="bar"><div class="bar-fill ${level}" style="width:${Math.min(percent, 100)}%"></div></div>`));
  }

  if (data.webhook) {
    const bad = Boolean(data.webhook.lastError);
    cards.push(statCard('Вебхук Telegram', `${dot(bad ? 'bad' : 'ok')}${bad ? 'ошибка' : 'работает'}`,
      bad ? `${esc(data.webhook.lastError)} · ${dt(data.webhook.lastErrorAt)}`
          : `в очереди ${data.webhook.pending} апдейтов`));
  }

  cards.push(statCard('Хранилище', `${dot(data.storage?.ok ? 'ok' : 'bad')}${data.storage?.ok ? 'доступно' : 'ошибка'}`,
    data.storage?.ok ? 'чтение и запись' : esc(data.storage?.error ?? '')));

  put('health', cards.join(''));
}

function renderAlerts(alerts) {
  if (!alerts.length) {
    put('alerts-table', '<tbody><tr><td class="muted">Активных уведомлений нет</td></tr></tbody>');
    return;
  }

  const rows = alerts.map((a) => `<tr>
    <td class="mono">${esc(a.chatId)}</td>
    <td>${a.direction === 'above' ? '🔼 вверх' : '🔽 вниз'}</td>
    <td class="mono">${num(a.price)}</td>
    <td class="mono ${a.distance > 0 ? 'up' : 'down'}">${a.distance === null ? '—' : `${a.distance > 0 ? '+' : ''}${num(a.distance)}`}</td>
    <td class="mono muted">${a.distancePercent === null ? '—' : `${num(a.distancePercent)}%`}</td>
    <td class="muted">${dt(Date.parse(a.createdAt))}</td>
  </tr>`).join('');

  put('alerts-table',
    `<thead><tr><th>Чат</th><th>Направление</th><th>Уровень</th><th>До цели</th><th>%</th><th>Создан</th></tr></thead><tbody>${rows}</tbody>`);
}

/**
 * Люди, разделённые по правам.
 *
 * Владелец и администраторы — в одной таблице, остальные в другой:
 * у них разные задачи. Управляющие аккаунты нужно видеть все сразу,
 * а обычных пользователей — искать по идентификатору.
 */
function renderPeople(data) {
  state.people = data.people ?? [];
  drawPeople();
}

/** Перерисовывает обе таблицы с учётом строки поиска. */
function drawPeople() {
  const all = state.people ?? [];
  const query = ($('people-search')?.value ?? '').trim().toLowerCase();

  const matches = (p) =>
    !query ||
    String(p.telegramId).includes(query) ||
    (p.username ?? '').toLowerCase().includes(query) ||
    (p.name ?? '').toLowerCase().includes(query);

  const visible = all.filter(matches);
  const privileged = visible.filter((p) => p.role === 'owner' || p.role === 'admin');
  const regular = visible.filter((p) => p.role !== 'owner' && p.role !== 'admin');

  put('people-summary', [
    statCard('Всего людей', all.length,
      `${all.filter((p) => p.usesSite).length} заходили на сайт`),
    statCard('Управляющие', all.filter((p) => p.role === 'owner' || p.role === 'admin').length,
      'владелец и администраторы'),
    statCard('Подписаны на сводку', all.filter((p) => p.subscribed).length,
      `уведомлений: ${all.reduce((s, p) => s + p.alerts, 0)}`),
  ].join(''));

  renderPeopleTable('admins-table', privileged, 'Администраторов нет');
  renderPeopleTable('users-table', regular,
    query ? 'Никто не найден' : 'Пользователей пока нет');

  bindPeopleActions();
}

function renderPeopleTable(id, people, emptyText) {
  if (people.length === 0) {
    put(id, `<tbody><tr><td class="muted">${emptyText}</td></tr></tbody>`);
    return;
  }

  const rows = people.map((p) => {
    const isOwner = p.role === 'owner';

    const handle = p.username
      ? `<a href="https://t.me/${esc(p.username)}" target="_blank" rel="noopener">@${esc(p.username)}</a>`
      : '<span class="muted">без имени</span>';

    const role = p.role
      ? `<span class="role role-${p.role}">${ROLE_LABEL[p.role] ?? p.role}</span>`
      : '<span class="muted">только бот</span>';

    // Владельца нельзя ни понизить, ни удалить: его роль задана
    // окружением, а запись всё равно пересоздастся при входе.
    let actions = '<span class="muted">—</span>';
    if (state.canManageRoles && !isOwner) {
      const roleButton = p.usesSite
        ? `<button class="role-action" data-login="${esc(p.login)}" data-role="${p.role === 'admin' ? 'user' : 'admin'}">
             ${p.role === 'admin' ? 'Снять админа' : 'Сделать админом'}
           </button>`
        : '';
      actions = `${roleButton}<button class="danger-action" data-remove="${esc(p.telegramId)}">Удалить</button>`;
    }

    return `<tr>
      <td>${handle}</td>
      <td class="mono">${esc(p.telegramId)}</td>
      <td>${esc(p.name ?? '—')}</td>
      <td>${role}</td>
      <td>${p.lang === 'en' ? '🇬🇧' : p.lang === 'ru' ? '🇷🇺' : '—'}</td>
      <td>${p.subscribed ? '✅' : '—'}</td>
      <td class="mono">${p.alerts || '—'}</td>
      <td class="muted">${dt(Date.parse(p.lastSeen))}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');

  put(id,
    `<thead><tr>
      <th>Пользователь</th><th>Telegram ID</th><th>Имя</th><th>Роль</th>
      <th>Язык</th><th>Сводка</th><th>Алерты</th><th>Активность</th><th></th>
    </tr></thead><tbody>${rows}</tbody>`);
}

function bindPeopleActions() {
  for (const button of document.querySelectorAll('.role-action')) {
    button.addEventListener('click', () => changeRole(button));
  }
  for (const button of document.querySelectorAll('.danger-action')) {
    button.addEventListener('click', () => removePerson(button));
  }
}

/**
 * Удаление человека.
 *
 * Операция необратимая и чистит сразу всё: аккаунт, настройки бота,
 * подписку и уведомления. Поэтому спрашиваем подтверждение с явным
 * указанием, кого именно удаляем.
 */
async function removePerson(button) {
  const id = button.dataset.remove;
  const person = (state.people ?? []).find((p) => String(p.telegramId) === id);
  const who = person?.username ? `@${person.username}` : `ID ${id}`;

  if (!confirm(`Удалить ${who}? Аккаунт, подписка и уведомления будут стёрты безвозвратно.`)) {
    return;
  }

  button.disabled = true;
  button.textContent = 'Удаляю…';

  try {
    const response = await fetch(API_PEOPLE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ action: 'delete', telegramId: Number(id) }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      $('panel-error').textContent = body.error ?? 'Не удалось удалить';
      button.disabled = false;
      button.textContent = 'Удалить';
      return;
    }

    await load();
  } catch {
    $('panel-error').textContent = 'Сеть недоступна';
    button.disabled = false;
    button.textContent = 'Удалить';
  }
}

async function changeRole(button) {
  button.disabled = true;
  button.textContent = 'Меняю…';

  try {
    const response = await fetch(API_PEOPLE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ login: button.dataset.login, role: button.dataset.role }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      $('panel-error').textContent = body.error ?? 'Не удалось сменить роль';
      button.disabled = false;
      return;
    }

    await load();
  } catch {
    $('panel-error').textContent = 'Сеть недоступна';
    button.disabled = false;
  }
}

/* ======================= События ======================= */

for (const button of document.querySelectorAll('.tab-btn')) {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
}

// Поиск фильтрует уже загруженные данные — без запроса к серверу.
$('people-search').addEventListener('input', drawPeople);

$('brand').addEventListener('click', (event) => {
  event.preventDefault();
  show(state.token ? 'panel-view' : 'public-view');
});

/* ======================= Запуск ======================= */

(function init() {
  renderAccount();

  // Переход по ссылке из бота: входим сразу, не спрашивая ничего.
  const loginCode = takeLoginCode();
  if (loginCode) {
    show('auth-view');
    $('auth-title').textContent = 'Входим…';
    loginWithCode(loginCode);
    return;
  }

  const initData = telegramInitData();
  if (initData) {
    document.body.classList.add('in-telegram');
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();

    show('auth-view');
    $('auth-title').textContent = 'Входим…';
    loginWithTelegram(initData);
    return;
  }

  // Вне Telegram: пробуем сохранённую сессию, иначе показываем витрину.
  const saved = readToken();
  if (!saved) return;

  state.token = saved;
  setChartToken(saved);
  setTradingToken(saved);
  setBacktestToken(saved);
  setAiToken(saved);

  fetch(API_DATA, { headers: { authorization: `Bearer ${saved}` } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((data) => {
      state.account = {
        login: data.login,
        role: data.role,
        displayName: data.displayName ?? data.login,
      };
      renderAccount();

      // Сессия жива — открываем панель сразу. Иначе в шапке написано,
      // что вход выполнен, а на экране витрина: выглядит как сбой.
      openPanel();
    })
    .catch(() => {
      writeToken(null);
      state.token = null;
      renderAccount();
    });
})();
