"use client";

import type { ReactNode } from "react";
import { FundsTabs } from "@/components/FundsTabs";
import { Shell } from "@/components/Shell";

export default function FundsLayout({ children }: { children: ReactNode }) {
  return (
    <Shell>
      <div className="page funds-page" data-tour="wallet">
        <FundsTabs />
        {children}
      </div>
    </Shell>
  );
}
