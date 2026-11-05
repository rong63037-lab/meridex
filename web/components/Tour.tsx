"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

const STEPS = [
  { key: "tourStepMarkets", href: "/terminal", selector: "[data-tour=markets]" },
  { key: "tourStepChart", href: "/terminal", selector: "[data-tour=chart]" },
  { key: "tourStepBook", href: "/terminal", selector: "[data-tour=book]" },
  { key: "tourStepTicket", href: "/terminal", selector: "[data-tour=ticket]" },
  { key: "tourStepWallet", href: "/funds", selector: "[data-tour=wallet]" },
  { key: "tourStepAccount", href: "/account", selector: "[data-tour=account]" },
] as const;

type Box = { top: number; left: number; width: number; height: number };

export function Tour() {
  const { t } = useI18n();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    if (!localStorage.getItem("meridex.token")) return;
    if (localStorage.getItem("meridex.tour") === "done") return;
    const saved = Number(sessionStorage.getItem("meridex.tour.step") || "0");
    setIndex(Number.isFinite(saved) && saved >= 0 && saved < STEPS.length ? saved : 0);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    sessionStorage.setItem("meridex.tour.step", String(index));
  }, [open, index]);

  function show(next: number) {
    setIndex(next);
    const step = STEPS[next];
    if (path !== step.href) router.push(step.href);
  }

  useEffect(() => {
    if (!open) return;
    const step = STEPS[index];
    const measure = () => {
      const el = document.querySelector(step.selector);
      if (!el) {
        setBox(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      setBox({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    };
    const id = window.setTimeout(measure, 120);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, index, path]);

  if (!open) return null;
  const step = STEPS[index];
  const last = index === STEPS.length - 1;
  const pad = 6;
  const hole = box
    ? { top: Math.max(0, box.top - pad), left: Math.max(0, box.left - pad), width: box.width + pad * 2, height: box.height + pad * 2 }
    : null;
  let cardTop = 72;
  let cardLeft = 16;
  if (hole && typeof window !== "undefined") {
    cardTop = hole.top + hole.height + 12;
    cardLeft = Math.min(Math.max(12, hole.left), window.innerWidth - 380);
    if (cardTop > window.innerHeight - 200) cardTop = Math.max(12, hole.top - 188);
  }

  function finish() {
    localStorage.setItem("meridex.tour", "done");
    sessionStorage.removeItem("meridex.tour.step");
    setOpen(false);
  }

  return (
    <>
      {hole ? <div className="tour-hole" style={hole} /> : <div className="tour-shade" />}
      <div className="tour-card" style={{ top: cardTop, left: cardLeft }} role="dialog" aria-label={t.tourTitle}>
        <p className="kicker">{t.tourTitle} · {index + 1} / {STEPS.length}</p>
        <p>{t[step.key]}</p>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <Button size="sm" variant="ghost" onClick={finish}>{t.tourSkip}</Button>
          {index > 0 ? <Button size="sm" variant="outline" onClick={() => show(index - 1)}>{t.tourBack}</Button> : null}
          <Button size="sm" onClick={() => (last ? finish() : show(index + 1))}>{last ? t.tourDone : t.tourNext}</Button>
        </div>
      </div>
    </>
  );
}
