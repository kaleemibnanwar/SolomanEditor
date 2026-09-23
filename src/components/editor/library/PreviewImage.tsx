/**
 * LAZY PREVIEW IMAGE.
 *
 * A library tab can hold eighty cards, and every preview is a real render (the
 * compositor's own path — see `lib/preview.ts`). Rendering them all on mount
 * would stall the panel, so a card's preview is only produced once it scrolls
 * near the viewport, and never twice.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function PreviewImage({
  cacheKey,
  factory,
  className,
  alt = "",
}: {
  /** identity of what is being rendered — changing it forces a re-render */
  cacheKey: string;
  /** produces the data URL; only called when the card comes into view */
  factory: () => string;
  className?: string;
  alt?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const make = useRef(factory);
  make.current = factory;

  const [url, setUrl] = useState("");

  useEffect(() => {
    setUrl("");
    const node = host.current;
    if (!node) return;

    let cancelled = false;
    const paint = () => {
      if (cancelled) return;
      // `previewDataUrl` memoises, so a re-observation is free.
      setUrl(make.current());
    };

    if (typeof IntersectionObserver === "undefined") {
      paint();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        paint();
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [cacheKey]);

  return (
    <div ref={host} className="h-full w-full">
      {url ? (
        <img src={url} alt={alt} draggable={false} className={cn("h-full w-full object-cover", className)} />
      ) : (
        <div className="h-full w-full animate-pulse bg-km-raised/40" />
      )}
    </div>
  );
}
