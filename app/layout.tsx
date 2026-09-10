import type { Metadata } from "next";
import { Providers } from "@/components/business/shell";
import "./globals.css";
export const metadata: Metadata = {
  title: "AI 面试 · 认真听见每一段经历",
  description: "通过自然语音对话完成面试，保留连续交流与真实记录。",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
