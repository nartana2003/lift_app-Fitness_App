import { SyncStatus } from "@/components/SyncStatus";

/** Full-screen live workout: no tab bar. */
export default function WorkoutLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SyncStatus />
      <main className="pt-safe pb-40 px-4 max-w-lg mx-auto min-h-dvh">{children}</main>
    </>
  );
}
