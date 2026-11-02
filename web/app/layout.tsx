import type { Metadata } from "next";
import { Cormorant_Garamond, IBM_Plex_Mono, Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import "./pro.css";
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
  title: "MERIDEX 美瑞德 · 多资产交易所沙盒",
  description: "美元计价的多资产现货沙盒：贵金属、加密货币、大宗商品与外汇。新加坡牌照申请进行中。没有真实资金。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hans" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <I18nProvider>{children}</I18nProvider>
        {/* Tawk.to live chat: general Q&A only. Not linked to deposits, the address pool, or any funds flow.
            Bottom-right, same offsets the removed in-house chat button used (16px; 88px on phones so it sits above the bottom tab bar). */}
        <Script id="tawk-init" strategy="afterInteractive">{`
          window.Tawk_API = window.Tawk_API || {};
          window.Tawk_LoadStart = new Date();
          window.Tawk_API.customStyle = {
            visibility: {
              desktop: { position: "br", xOffset: 16, yOffset: window.innerWidth <= 820 ? 88 : 16 },
              mobile: { position: "br", xOffset: 16, yOffset: 88 }
            }
          };
        `}</Script>
        <Script
          id="tawk-embed"
          src="https://embed.tawk.to/6ae83b1e05c1f83c34b1a031/1k6didspk"
          strategy="afterInteractive"
          charSet="UTF-8"
          crossOrigin="anonymous"
        />
      </body>
    </html>
  );
}
