import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function ReleaseNotes({ children, baseUrl }: { children: string; baseUrl?: string }) {
  return <div className="workspace-release-notes">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(value, key) => {
      if (key !== 'href') return '';
      try {
        const url = new URL(value, baseUrl);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
      } catch { return ''; }
    }} components={{
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
      // Release notes remain self-contained; image descriptions do not trigger remote requests.
      img: ({ alt }) => alt ? <span>{alt}</span> : null,
    }}>{children}</Markdown>
  </div>;
}
