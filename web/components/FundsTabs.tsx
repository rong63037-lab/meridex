"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fundsCopy } from "@/lib/funds-copy";
import { useI18n } from "@/lib/i18n";

const tabs = [
  { href: "/funds", key: "overview", exact: true },
  { href: "/funds/deposit", key: "deposit", exact: false },
  { href: "/funds/withdraw", key: "withdraw", exact: false },
  { href: "/funds/history", key: "history", exact: false },
] as const;

export function FundsTabs() {
  const path = usePathname();
  const { lang } = useI18n();
  const copy = fundsCopy(lang);
  const [internal, setInternal] = useState(false);
  useEffect(() => {
    api<{ isInternalTest?: boolean }>("/api/me").then((me) => setInternal(Boolean(me.isInternalTest))).catch(() => undefined);
  }, []);
  const shown = internal ? tabs.filter((tab) => tab.key === "overview" || tab.key === "history") : tabs;
  return (
    <nav className="funds-tabs" aria-label={copy.overview}>
      {internal ? <span className="internal-badge">INTERNAL TEST / 内部测试</span> : null}
      {shown.map((tab) => {
        const on = tab.exact ? path === tab.href : path.startsWith(tab.href);
        return (
          <Link key={tab.href} href={tab.href} className={on ? "active" : ""}>
            {copy[tab.key]}
          </Link>
        );
      })}
    </nav>
  );
}
