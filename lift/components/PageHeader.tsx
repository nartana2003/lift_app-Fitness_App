import Link from "next/link";

export function PageHeader({
  title,
  back,
  right,
}: {
  title: string;
  back?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="flex items-center gap-3 py-3 mb-2">
      {back && (
        <Link href={back} className="-ml-1 p-1 text-muted" aria-label="Back">
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={2.2}>
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      )}
      <h1 className="text-2xl font-bold tracking-tight flex-1 truncate">{title}</h1>
      {right}
    </header>
  );
}
