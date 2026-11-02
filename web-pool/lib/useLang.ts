"use client";

import { useEffect, useState } from "react";
import { poolCopy, type Lang } from "./copy";

const KEY = "meridex.pool.lang";

export function useLang() {
  const [lang, setLangState] = useState<Lang>("zh");
  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "ms" || saved === "zh") setLangState(saved);
  }, []);
  function setLang(next: Lang) {
    setLangState(next);
    localStorage.setItem(KEY, next);
    document.documentElement.lang = next === "zh" ? "zh-Hans" : next;
  }
  return { lang, setLang, t: poolCopy[lang] };
}
