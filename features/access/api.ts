export async function testAccess(body: Record<string, unknown>) {
  const response = await fetch("/api/test-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "暂时无法登录，请重试");
  return data as { next?: string };
}
