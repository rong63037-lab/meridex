import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MERIDEX · 地址后台",
  description: "充值地址池。只有所有者可以登录，每次修改都要动态验证码。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hans">
      <body>{children}</body>
    </html>
  );
}
