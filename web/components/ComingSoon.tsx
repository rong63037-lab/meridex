"use client";

import type { ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import { reasonText, useI18n } from "@/lib/i18n";
import { usePaperMode } from "@/lib/usePaper";

export function ComingSoon({ title, extra }: { title: string; extra?: ReactNode }) {
  const { t, lang } = useI18n();
  const { setEnabled } = usePaperMode();
  const toast = useToast();

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <p className="kicker">{t.gatedSoon}</p>
          <h1>{title}</h1>
          <p className="lede">{t.gatedBody}</p>
          <div className="hero-actions">
            <Button
              size="lg"
              onClick={() => {
                void setEnabled(true).catch((err) => toast(reasonText(lang, (err as Error).message), "bad"));
              }}
            >
              {t.gatedCta}
            </Button>
          </div>
        </section>
        {extra}
      </div>
    </Shell>
  );
}

export function DeskLoading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <Shell>
      <div className="page" aria-busy="true"><p className="hint">{label ?? t.loading}</p></div>
    </Shell>
  );
}
