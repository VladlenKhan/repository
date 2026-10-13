/* ===========================================================================
   Разбор обстановки языковой моделью.

   Текст приходит от модели, поэтому экранируется целиком: доверять его
   разметке нельзя, даже если модель обычно ведёт себя прилично.
   =========================================================================== */

const $ = (id) => document.getElementById(id);
const state = { token: null };

export function setAiToken(token) {
  state.token = token;
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const list = (items) =>
  Array.isArray(items) && items.length
    ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    : '';

async function ask() {
  const button = $('ask-ai');
  const box = $('ai-box');

  button.disabled = true;
  button.textContent = 'Думает…';

  try {
    const response = await fetch('/api/ai?timeframe=1h', {
      headers: { authorization: `Bearer ${state.token}` },
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      box.innerHTML = `<p class="muted" style="margin:0">${esc(data.error ?? 'Не удалось получить разбор')}</p>`;
      return;
    }

    const c = data.commentary ?? {};
    box.innerHTML = `
      <p>${esc(c.summary ?? '')}</p>
      ${c.observations?.length ? '<h4>Наблюдения</h4>' + list(c.observations) : ''}
      ${c.watchLevels?.length ? '<h4>За чем следить</h4>' + list(c.watchLevels) : ''}
      ${c.caution ? `<h4>Чего данные не показывают</h4><p class="muted">${esc(c.caution)}</p>` : ''}
      <p class="ai-note">
        Составлено языковой моделью по рассчитанным показателям${data.cached ? ' (из кэша)' : ''}.
        Модель не предсказывает цену. Это не финансовая рекомендация.
      </p>`;
  } catch {
    box.innerHTML = '<p class="muted" style="margin:0">Сеть недоступна</p>';
  } finally {
    button.disabled = false;
    button.textContent = 'Запросить';
  }
}

$('ask-ai').addEventListener('click', ask);
