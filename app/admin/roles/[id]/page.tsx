import { RoleEditor } from "@/features/admin/role-editor";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ template?: string | string[] }>;
}) {
  const { id } = await params;
  const { template } = await searchParams;
  return (
    <RoleEditor
      key={id}
      id={id}
      templateId={typeof template === "string" ? template : undefined}
    />
  );
}
