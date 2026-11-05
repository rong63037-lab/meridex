"use client";

import Link from "next/link";
import { accountCopy } from "@/lib/account-copy";
import { useI18n } from "@/lib/i18n";

export function AccountBack() {
  const { lang } = useI18n();
  return <Link className="back-link" href="/account">{accountCopy(lang).back}</Link>;
}
