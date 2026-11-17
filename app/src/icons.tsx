import React from "react";

// lucide 风格内联图标(24 viewBox 多 path 以 | 分隔)
const P: Record<string, string> = {
  library: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z|M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z",
  sliders: "M4 21v-7|M4 10V3|M12 21v-9|M12 8V3|M20 21v-5|M20 12V3|M1 14h6|M9 8h6|M17 16h6",
  rows: "M3 4h18v16H3z|M3 12h18",
  cols: "M3 4h18v16H3z|M12 4v16",
  lines: "M4 6h16|M4 12h10|M4 18h14",
  tag: "M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z|M7.5 7.5h.01",
  bookmark: "M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
  chev: "m6 9 6 6 6-6",
  refresh: "M3 12a9 9 0 0 1 15.4-6.4L21 8|M21 3v5h-5|M21 12a9 9 0 0 1-15.4 6.4L3 16|M3 21v-5h5",
  pin: "M12 17v5|M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  x: "M18 6 6 18|m6 6 12 12",
  win: "M8 3H5a2 2 0 0 0-2 2v3|M21 8V5a2 2 0 0 0-2-2h-3|M3 16v3a2 2 0 0 0 2 2h3|M16 21h3a2 2 0 0 0 2-2v-3",
  copy: "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z|M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z|M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  zap: "M13 2 3 14h9l-1 8 10-12h-9z",
  swap: "m16 3 4 4-4 4|M20 7H4|m8 21-4-4 4-4|M4 17h16",
  plus: "M5 12h14|M12 5v14",
  fileplus: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z|M14 2v4a2 2 0 0 0 2 2h4|M9 15h6|M12 12v6",
  import: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|m7 10 5 5 5-5|M12 15V3",
  sparkles: "m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z",
  volume: "M11 5 6 9H2v6h4l5 4z|M15.5 8.5a5 5 0 0 1 0 7",
  moon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z|m21 21-4.3-4.3",
  info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M12 16v-4|M12 8h.01",
  loader: "M21 12a9 9 0 1 1-6.219-8.56",
};

export function Icon({ n, size = 16, className }: { n: string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"ic ic-" + n + (className ? " " + className : "")}
      aria-hidden
    >
      {P[n].split("|").map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
