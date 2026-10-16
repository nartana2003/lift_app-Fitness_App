import { TabBar } from "@/components/TabBar";
import { SyncStatus } from "@/components/SyncStatus";

export default function TabsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SyncStatus />
      <main className="pt-safe pb-28 px-4 max-w-lg mx-auto min-h-dvh">{children}</main>
      <TabBar />
    </>
  );
}
