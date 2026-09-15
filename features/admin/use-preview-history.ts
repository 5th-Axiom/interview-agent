"use client";
import { useQuery } from "@tanstack/react-query";
import { getPreviewHistory } from "./api";

export function usePreviewHistory(
  id: string,
  open: boolean,
  finished: boolean,
) {
  return useQuery({
    queryKey: ["preview-history", id],
    queryFn: ({ signal }) => getPreviewHistory(id, signal),
    enabled: open,
    retry: false,
    refetchInterval: (query) => {
      if (!finished) return 5000;
      if (query.state.status === "error") return false;
      const data = query.state.data;
      return !data ||
        data.session.status !== "ended" ||
        ["pending", "running"].includes(data.transcription_status ?? "")
        ? 2000
        : false;
    },
  });
}
