import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';
import { MU_NAME_POST_PROCESSOR, muNamePostProcessor, showAsMu } from '@/common/kyrn/displayName';

describe('showAsMu', () => {
  it('shows the upstream product name as mu, in either spelling and next to CJK text', () => {
    expect(showAsMu('关于 AionUi')).toBe('关于 mu');
    expect(showAsMu('重启AionUI，或把这个 MCP server 改成绝对命令路径。')).toBe(
      '重启mu，或把这个 MCP server 改成绝对命令路径。'
    );
    expect(showAsMu('AionUi - Login')).toBe('mu - Login');
    expect(showAsMu('Restart AionUi. Then retry.')).toBe('Restart mu. Then retry.');
    expect(showAsMu('AionUi AionUi')).toBe('mu mu');
    expect(showAsMu('Chat with (AionUi) assistant')).toBe('Chat with (mu) assistant');
  });

  it('shows the name as mu in German compound nouns, which join it to the next word with a hyphen', () => {
    expect(showAsMu('Die AionUi-Installation ist unvollständig.')).toBe('Die mu-Installation ist unvollständig.');
    expect(showAsMu('Liebe AionUi-Nutzerin, lieber AionUi-Nutzer,')).toBe('Liebe mu-Nutzerin, lieber mu-Nutzer,');
    expect(showAsMu('die AionUi-Oberfläche')).toBe('die mu-Oberfläche');
  });

  it('leaves links, paths, file names, identifiers and the backend component name alone', () => {
    for (const text of [
      'https://github.com/iOfficeAI/AionUi/releases',
      'github.com/iOfficeAI/AionUi',
      'support@AionUi.com',
      'AionUi.app',
      'AionUi-update-1.zip',
      '~/Library/Application Support/AionUi-Dev',
      '~/Library/Application Support/AionUi/config',
      'AIONUI_STREAM_BROKEN',
      'cleanAionUITimestamp',
      'AionCore 无法启动',
    ]) {
      expect(showAsMu(text), text).toBe(text);
    }
  });

  it('returns a string without the name untouched', () => {
    const text = '判定已交给执行层；这不代表操作已经完成。';
    expect(showAsMu(text)).toBe(text);
  });
});

describe('muNamePostProcessor', () => {
  it('applies to translations, interpolated values and default values of an i18next instance', async () => {
    const i18n = createInstance();
    await i18n.use(muNamePostProcessor).init({
      lng: 'zh-CN',
      resources: {
        'zh-CN': {
          translation: {
            tray: { about: '关于 AionUi' },
            update: '请将 AionUi 更新到 {{version}}，AionCore 无需处理。',
          },
        },
      },
      interpolation: { escapeValue: false },
      postProcess: [MU_NAME_POST_PROCESSOR],
    });
    expect(i18n.t('tray.about')).toBe('关于 mu');
    expect(i18n.t('update', { version: 'v2' })).toBe('请将 mu 更新到 v2，AionCore 无需处理。');
    expect(i18n.t('missing.key', { defaultValue: 'Chat with AionUi assistant via Telegram' })).toBe(
      'Chat with mu assistant via Telegram'
    );
  });
});
