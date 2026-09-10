import { CandidatePage } from "@/features/interview/candidate-page";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CandidatePage id={id} />;
}
