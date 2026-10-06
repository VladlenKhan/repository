import { describe, expect, it } from 'vitest';
import { escapeHtml, formatCommands, formatStart, withDisclaimer } from '../lib/format.js';
import { t } from '../lib/i18n.js';

describe('escapeHtml', () => {
  it('экранирует символы, ломающие разметку Telegram', () => {
    expect(escapeHtml('<b>&тест</b>')).toBe('&lt;b&gt;&amp;тест&lt;/b&gt;');
  });

  it('не трогает обычный текст', () => {
    expect(escapeHtml('XAU/USD 2650.5')).toBe('XAU/USD 2650.5');
  });
});

describe('withDisclaimer', () => {
  it('добавляет обязательную оговорку на русском', () => {
    expect(withDisclaimer('текст', 'ru')).toContain('Это не финансовая рекомендация');
  });

  it('добавляет обязательную оговорку на английском', () => {
    expect(withDisclaimer('text', 'en')).toContain('This is not financial advice');
  });

  it('сохраняет исходный текст', () => {
    expect(withDisclaimer('цена 2650', 'ru')).toMatch(/^цена 2650/);
  });
});

describe('i18n', () => {
  it('подставляет параметры в шаблон', () => {
    expect(t('ru', 'start.greeting', { name: 'Влад' })).toContain('Влад');
  });

  it('откатывается на русский для неизвестного языка', () => {
    expect(t('de', 'disclaimer')).toBe('Это не финансовая рекомендация');
  });

  it('оставляет плейсхолдер, если параметр не передан', () => {
    expect(t('ru', 'start.greeting')).toContain('{name}');
  });
});

describe('formatStart', () => {
  it('содержит имя пользователя и список команд', () => {
    const text = formatStart('ru', 'Влад');
    expect(text).toContain('Влад');
    expect(text).toContain('/analysis');
    expect(text).toContain('/help');
  });

  it('экранирует имя пользователя', () => {
    expect(formatStart('ru', '<script>')).toContain('&lt;script&gt;');
  });

  it('переключается на английский', () => {
    expect(formatStart('en', 'Vlad')).toContain('market breakdown');
  });
});

describe('formatCommands', () => {
  it('перечисляет все команды бота', () => {
    const text = formatCommands('ru');
    for (const command of ['/analysis', '/levels', '/macro', '/subscribe', '/alert', '/lang']) {
      expect(text).toContain(command);
    }
  });
});
