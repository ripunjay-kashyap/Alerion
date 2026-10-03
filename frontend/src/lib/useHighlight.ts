"use client";
import { useEffect, type RefObject } from "react";

/** Presentation only: briefly mark a changed backend entity without changing its state. */
export function useHighlight(
  ref: RefObject<HTMLElement | null>,
  version: string,
) {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = ref.current?.animate(
      [
        { boxShadow: "inset 0 0 0 1px #889780" },
        { boxShadow: "inset 0 0 0 1px transparent" },
      ],
      { duration: 1200, easing: "ease-out" },
    );
    return () => animation?.cancel();
  }, [ref, version]);
}
