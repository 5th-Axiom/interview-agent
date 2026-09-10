import { FeedbackPage } from "@/features/interview/feedback-page";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <FeedbackPage id={id} />;
}
