import { PageHeader } from "@/components/PageHeader";
import { SaveFromLink } from "@/components/routines/SaveFromLink";

// /save?url=... : the target of the iOS Shortcut on the share sheet ("Save to
// Lift"), because iOS PWAs do not support the Web Share Target API. It opens
// the existing Save from link flow with the link prefilled. The link is only
// checked here (parseLink in SaveFromLink); nothing is fetched or saved until
// the user taps the existing buttons.

type Props = { searchParams: Promise<{ url?: string | string[] }> };

export default async function SavePage({ searchParams }: Props) {
  const { url } = await searchParams;
  const first = Array.isArray(url) ? url[0] : url;
  return (
    <main className="pt-safe pb-28 px-4 max-w-lg mx-auto min-h-dvh">
      <PageHeader title="Save to Lift" back="/" />
      <SaveFromLink initialUrl={first ?? ""} />
    </main>
  );
}
