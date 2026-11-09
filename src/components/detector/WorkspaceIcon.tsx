import type { ReactNode } from 'react';

export type WorkspaceIconName = 'shield' | 'basic' | 'network' | 'tests' | 'compare' | 'settings' | 'refresh' | 'globe' | 'sliders' | 'browser' | 'monitor' | 'home' | 'router' | 'document' | 'github';

const paths: Record<WorkspaceIconName, ReactNode> = {
  shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
  basic: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  network: <><rect x="9" y="3" width="6" height="5" rx="1" /><path d="M12 8v6M5 17v-3h14v3" /><rect x="2" y="17" width="6" height="4" rx="1" /><rect x="16" y="17" width="6" height="4" rx="1" /></>,
  tests: <><path d="m3 6 2 2 3-4m-5 9 2 2 3-4M12 6h9M12 13h9M3 20h18" /></>,
  compare: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></>,
  refresh: <><path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
  sliders: <><path d="M6 3v18M12 3v18M18 3v18" /><path d="M3 8h6m0 8h6m0-9h6" /></>,
  browser: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
  monitor: <><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M12 16v5m-5 0h10" /></>,
  home: <><path d="m3 10 9-7 9 7v10H3Z" /><path d="M9 20v-7h6v7" /></>,
  router: <><rect x="3" y="12" width="18" height="8" rx="2" /><path d="M7 12V7m10 5V7M7 16h.01M11 16h.01M8 4a7 7 0 0 1 8 0M10 7a3 3 0 0 1 4 0" /></>,
  document: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  github: <path fill="currentColor" stroke="none" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />,
};

export function WorkspaceIcon({ name }: { name: WorkspaceIconName }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
