import type { ReactNode } from 'react';

export function Header({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <header className="page-header"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{children}</p></header>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="empty-state">{children}</div>; }
export function Json({ value }: { value: unknown }) { return <pre className="mono">{JSON.stringify(value, null, 2)}</pre>; }
export function Table({ headings, children, caption }: { headings: string[]; children: ReactNode; caption: string }) {
  return <div className="table-wrap" tabIndex={0} role="region" aria-label={caption}><table><caption>{caption}</caption><thead><tr>{headings.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
export const numeric = (n: number | null) => n === null ? 'unavailable' : n.toFixed(4);
