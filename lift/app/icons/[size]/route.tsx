import { ImageResponse } from "next/og";

const SIZES = [180, 192, 512];

export function generateStaticParams() {
  return SIZES.map((s) => ({ size: String(s) }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const n = Number((await params).size);
  const size = SIZES.includes(n) ? n : 192;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#111111",
        }}
      >
        <svg width={size} height={size} viewBox="0 0 100 100">
          <g fill="#ffffff" transform="rotate(-45 50 50)">
            <rect x="14" y="38" width="9" height="24" rx="3" />
            <rect x="25" y="32" width="9" height="36" rx="3" />
            <rect x="36" y="46" width="28" height="8" rx="2" />
            <rect x="66" y="32" width="9" height="36" rx="3" />
            <rect x="77" y="38" width="9" height="24" rx="3" />
          </g>
        </svg>
      </div>
    ),
    { width: size, height: size },
  );
}
