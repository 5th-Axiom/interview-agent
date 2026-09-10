import { RecordDetail } from "@/features/admin/record-detail";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RecordDetail id={id} />;
}
