import { describe, expect, it } from 'vitest';
import { renderUiPage } from '../src/web/ui.js';

describe('daily report web preview', () => {
  it('loads local Markdown and Mermaid renderers for a faithful preview', () => {
    const page = renderUiPage();

    expect(page).toContain('<script src="/assets/marked.js"></script>');
    expect(page).toContain('<script src="/assets/dompurify.js"></script>');
    expect(page).toContain('<script src="/assets/mermaid.js"></script>');
    expect(page).toContain("querySelectorAll('pre > code.language-mermaid')");
    expect(page).toContain('window.mermaid.run');
    expect(page).toContain("window.DOMPurify.sanitize");
    expect(page).toContain('.markdown table');
  });

  it('normalizes legacy HTML break blocks before rendering Markdown', () => {
    const page = renderUiPage();

    expect(page).toContain('<p>\\s*<br\\s*\\/?>(?:\\s*)<\\/p>');
    expect(page).toContain("preview.textContent = '图示暂时无法预览'");
  });
});
