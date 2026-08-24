import { describe, expect, it } from 'vitest';
import { isInjectedContext, userAuthoredMessage } from '../src/sessions/codex/support/privacy.js';

describe('userAuthoredMessage', () => {
  it('keeps only the real request after an IDE context prelude', () => {
    const message = [
      '# Context from my IDE setup:',
      '',
      '## Active file: src/app.ts',
      '## Open tabs:',
      '- app.ts',
      '',
      '## My request for Codex:',
      '请修复登录接口并补充测试',
    ].join('\n');

    expect(userAuthoredMessage(message)).toBe('请修复登录接口并补充测试');
  });

  it('keeps only the real request after a mentioned-files prelude', () => {
    const message = [
      '# Files mentioned by the user:',
      '- src/app.ts',
      '',
      '## My request for Codex:',
      '解释这个文件的职责',
    ].join('\n');

    expect(userAuthoredMessage(message)).toBe('解释这个文件的职责');
  });

  it('drops a pure IDE prelude and preserves an ordinary user message', () => {
    expect(userAuthoredMessage('# Context from my IDE setup:\n## Active file: src/app.ts')).toBe('');
    expect(userAuthoredMessage('直接修复这个问题')).toBe('直接修复这个问题');
    expect(isInjectedContext('# Files mentioned by the user:\n- src/app.ts')).toBe(true);
  });
});
