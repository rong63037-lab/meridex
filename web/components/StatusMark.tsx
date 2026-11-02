"use client";

import { useI18n } from "@/lib/i18n";

export function StatusMark({
  halted,
  pending,
  liquidity,
  tag,
}: {
  halted?: boolean;
  pending?: boolean;
  liquidity?: "low" | "ok" | string;
  tag?: string;
}) {
  const { t } = useI18n();
  if (halted) return <span className="badge bad" title={t.tipHalted}>{t.halted}</span>;
  if (pending) return <span className="badge warn" title={tag || t.tipPending}>{t.pendingOpen}</span>;
  if (liquidity === "low") return <span className="badge warn" title={t.tipLow}>{t.lowLiquidity}</span>;
  return null;
}
