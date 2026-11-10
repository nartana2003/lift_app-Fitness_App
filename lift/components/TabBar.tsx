"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type IconProps = { active: boolean };

const svg = (children: React.ReactNode, active: boolean) => (
  <svg
    viewBox="0 0 24 24"
    className="size-6"
    fill="none"
    stroke="currentColor"
    strokeWidth={active ? 2.2 : 1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

const HomeIcon = ({ active }: IconProps) =>
  svg(
    <>
      <path
        d="M12 3.5 3 11.2h2.5V20a.5.5 0 0 0 .5.5h3.6v-5.4h4.8v5.4H18a.5.5 0 0 0 .5-.5v-8.8H21Z"
        fill={active ? "currentColor" : "none"}
      />
    </>,
    active,
  );

/** Dumbbell: plates fill in when selected. */
const DumbbellIcon = ({ active }: IconProps) =>
  svg(
    <>
      <path d="M8 12h8" />
      <rect x="4.5" y="7" width="3.5" height="10" rx="1.2" fill={active ? "currentColor" : "none"} />
      <rect x="16" y="7" width="3.5" height="10" rx="1.2" fill={active ? "currentColor" : "none"} />
      <path d="M2.5 10v4M21.5 10v4" />
    </>,
    active,
  );

const TrendIcon = ({ active }: IconProps) =>
  svg(
    <>
      <path d="M3 4v15.5a.5.5 0 0 0 .5.5H21" />
      <path d="m7 15 4-4.5 3 3L20 7" />
      <path d="M15.5 7H20v4.5" />
    </>,
    active,
  );

/** Coach: a target, ringed and filled when selected. */
const CoachIcon = ({ active }: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </>,
    active,
  );

const ProfileIcon = ({ active }: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="8" r="4" fill={active ? "currentColor" : "none"} />
      <path d="M4.5 20.5c.6-3.6 3.8-6 7.5-6s6.9 2.4 7.5 6" fill={active ? "currentColor" : "none"} />
    </>,
    active,
  );

const TABS = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/exercises", label: "Exercises", Icon: DumbbellIcon },
  { href: "/coach", label: "Coach", Icon: CoachIcon },
  { href: "/progress", label: "Progress", Icon: TrendIcon },
  { href: "/profile", label: "Profile", Icon: ProfileIcon },
];

export function TabBar() {
  const path = usePathname();
  return (
    // transform-gpu gives the bar its own layer so iOS Safari keeps it pinned to the bottom while the page scrolls.
    <nav className="fixed bottom-0 inset-x-0 z-40 transform-gpu bg-bg/90 backdrop-blur border-t border-border pb-safe">
      <ul className="flex max-w-lg mx-auto">
        {TABS.map(({ href, label, Icon }) => {
          const active = href === "/" ? path === "/" || path.startsWith("/history") : path.startsWith(href);
          return (
            <li key={href} className="flex-1 min-w-0">
              <Link href={href} className={`flex flex-col items-center gap-0.5 px-1 pt-2 text-[11px] ${active ? "text-accent font-semibold" : "text-muted"}`}>
                <Icon active={active} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
