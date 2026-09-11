import { responseData } from "@/shared/http";
export async function testAccess(body: Record<string, unknown>) {
  const response = await fetch("/api/test-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await responseData(response);
  return data as { next?: string };
}
