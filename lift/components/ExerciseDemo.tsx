"use client";

import { useEffect, useState } from "react";

/** Flips between the start/end photos so it reads like a short animation. */
export function ExerciseDemo({ urls, alt, small }: { urls: string[]; alt: string; small?: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (urls.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % urls.length), small ? 1400 : 1000);
    return () => clearInterval(t);
  }, [urls.length, small]);

  if (!urls.length) {
    return <div className={`${small ? "size-14" : "aspect-[4/3] w-full"} rounded-xl bg-surface-2`} />;
  }
  return (
    <div className={`relative overflow-hidden rounded-xl bg-white ${small ? "size-14 shrink-0" : "aspect-[4/3] w-full"}`}>
      {urls.map((u, idx) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={u}
          src={u}
          alt={alt}
          loading="lazy"
          className={`absolute inset-0 size-full object-cover transition-opacity duration-300 ${
            idx === i ? "opacity-100" : "opacity-0"
          }`}
        />
      ))}
    </div>
  );
}
