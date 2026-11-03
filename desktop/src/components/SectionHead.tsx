import type { ReactNode } from "react";

/** Shared section header (title + subtitle + optional action). */
export function SectionHead({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) { return <div className="section-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>; }
