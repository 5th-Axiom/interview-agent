"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function useUnsavedChanges(dirty: boolean) {
  const router = useRouter();
  const [destination, setDestination] = useState("");
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = (event.target as Element).closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download"))
        return;
      const url = new URL(link.href);
      if (
        url.origin !== location.origin ||
        (url.pathname === location.pathname && url.search === location.search)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setDestination(url.pathname + url.search + url.hash);
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
  return {
    open: !!destination,
    cancel: () => setDestination(""),
    discard: () => {
      setDestination("");
      router.push(destination);
    },
  };
}

// Browser Back cannot be reliably cancelled by an App Router page. Preserve
// the unsaved review in this tab as well as guarding explicit page links.
export function useReviewDraft(id: string) {
  const [review, setReview] = useState("");
  const key = `interview:review-draft:${id}`;
  useEffect(() => {
    try {
      setReview(sessionStorage.getItem(key) ?? "");
    } catch {
      /* Optional recovery. */
    }
  }, [key]);
  function update(value: string) {
    setReview(value);
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch {
      /* The navigation warning still protects in-memory input. */
    }
  }
  return [review, update] as const;
}
