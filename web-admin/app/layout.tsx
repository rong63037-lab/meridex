import type { Metadata } from "next";
import { Cormorant_Garamond, IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";

const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-display",
  display: "optional",
  adjustFontFallback: true,
});

const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "optional",
  adjustFontFallback: true,
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "optional",
  preload: false,
  adjustFontFallback: true,
});

export const metadata: Metadata = {
  title: "MERIDEX ADMIN · 内部后台",
  description: "MERIDEX 内部后台。员工账号、动态验证码。与客户站点分开。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hans" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
