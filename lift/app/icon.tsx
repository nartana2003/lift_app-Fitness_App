import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#111111", borderRadius: 14 }}>
        <svg width={64} height={64} viewBox="0 0 100 100">
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
    size,
  );
}
