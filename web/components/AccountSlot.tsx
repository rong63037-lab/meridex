"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

type Me = { email: string; role: string };

export function AccountSlot({ guest = "actions" }: { guest?: "actions" | "login" }) {
  const { t } = useI18n();
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    const load = () => {
      const token = localStorage.getItem("meridex.token");
      if (!token) {
        setMe(null);
        return;
      }
      fetch("/api/me", { headers: { authorization: `Bearer ${token}` } })
        .then((res) => (res.ok ? res.json() : null))
        .then((row: Me | null) => setMe(row?.email ? row : null))
        .catch(() => setMe(null));
    };
    load();
    window.addEventListener("storage", load);
    return () => window.removeEventListener("storage", load);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!mounted) return <span className="avatar ghost" aria-hidden="true" />;

  if (!me) {
    return (
      <>
        <Button variant="outline" asChild><Link href="/login">{t.login}</Link></Button>
        {guest === "actions" ? <Button asChild><Link href="/terminal">{t.ctaNow}</Link></Button> : null}
      </>
    );
  }

  const initial = me.email.trim().charAt(0).toUpperCase() || "A";
  return (
    <div className="account-menu" ref={box}>
      <button
        type="button"
        className="avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={me.email}
        onClick={() => setOpen((value) => !value)}
      >
        {initial}
      </button>
      {open ? (
        <div className="account-pop" role="menu">
          <div className="account-id">
            <b>{me.email}</b>
            <span>{me.role}</span>
          </div>
          <Link href="/account" role="menuitem" onClick={() => setOpen(false)}>{t.profile}</Link>
          <Link href="/account/security" role="menuitem" onClick={() => setOpen(false)}>{t.security}</Link>
          <Link href="/terminal" role="menuitem" onClick={() => setOpen(false)}>{t.trade}</Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              localStorage.removeItem("meridex.token");
              void fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
              setOpen(false);
              setMe(null);
              router.push("/login");
            }}
          >
            {t.logout}
          </button>
        </div>
      ) : null}
    </div>
  );
}
