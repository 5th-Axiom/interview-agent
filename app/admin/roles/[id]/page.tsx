import { RoleEditor } from "@/features/admin/role-editor";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RoleEditor id={id} />;
}
