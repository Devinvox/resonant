import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked for chat messages
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = lang || 'text';
      return `
        <div class="code-block-container" data-code="${encodeURIComponent(text)}">
          <div class="code-block-header">
            <span class="code-lang">${language}</span>
            <button class="copy-code-btn" type="button" aria-label="Copy code">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>Copy</span>
            </button>
          </div>
          <pre><code class="language-${language}">${text}</code></pre>
        </div>
      `;
    }
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'del', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'hr', 'span', 'div', 'button', 'svg', 'path', 'rect'
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'data-code', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'd', 'x', 'y', 'rx', 'type'],
  });
}
