"use client";
import { useEffect, useState } from "react";

const initial = {
  phone: "",
  search: "",
  role: "",
  status: "",
  date: "",
  page: 1,
};
const storageKey = "interview:record-filters";
export function useRecordFilters() {
  const [filters, setFilters] = useState(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let restored = initial;
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (
        value &&
        ["phone", "search", "role", "status", "date"].every(
          (key) => typeof value[key] === "string",
        ) &&
        Number.isSafeInteger(value.page) &&
        value.page > 0
      )
        restored = value;
    } catch {
      /* Storage can be unavailable in private browser contexts. */
    }
    const role = new URLSearchParams(location.search).get("role");
    setFilters(role ? { ...initial, role } : restored);
    if (role)
      window.history.replaceState(window.history.state, "", location.pathname);
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(filters));
    } catch {
      /* In-memory filters still work. */
    }
  }, [filters, ready]);
  function update(value: Partial<typeof initial>) {
    setFilters((old) => ({
      ...old,
      ...value,
      ...(["search", "role", "status", "date"].some((key) => key in value)
        ? { page: 1 }
        : {}),
    }));
  }
  return { ...filters, ready, update, clear: () => setFilters(initial) };
}
