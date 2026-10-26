"use client";

import { useState } from "react";

/** Card with a tappable header that expands/collapses its content. */
export function Collapsible({
  title,
  subtitle,
  icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="card mb-2 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {icon && <span className="shrink-0 size-9 rounded-xl bg-surface-2 grid place-items-center text-muted">{icon}</span>}
        <span className="flex-1 min-w-0">
          <span className="block font-semibold text-[15px]">{title}</span>
          {subtitle && !open && <span className="block text-xs text-muted truncate mt-0.5">{subtitle}</span>}
        </span>
        <svg
          viewBox="0 0 24 24"
          className={`size-5 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && <div className="px-4 pb-4 space-y-3.5 border-t border-border pt-4">{children}</div>}
    </section>
  );
}
