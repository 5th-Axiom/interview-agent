"use client";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api, RequestError } from "./api";
export function useAdminQuery(key: string, path: string, interval?: number) {
  const router = useRouter();
  const q = useQuery({
    queryKey: [key, path],
    queryFn: () => api(path),
    retry: false,
    refetchInterval: interval,
  });
  useEffect(() => {
    if (q.error instanceof RequestError && [401, 403].includes(q.error.status))
      router.replace("/admin/login");
  }, [q.error, router]);
  return q;
}
