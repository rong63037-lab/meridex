"use client";

import { useEffect, useRef, useState } from "react";

export function Num({ value, text, className = "" }: { value: number | null; text: string; className?: string }) {
  const prev = useRef<number | null>(null);
  const [dir, setDir] = useState<"" | "up" | "down">("");
  useEffect(() => {
    if (value === null || !Number.isFinite(value)) return;
    if (prev.current !== null && value !== prev.current) {
      setDir(value > prev.current ? "up" : "down");
      const id = window.setTimeout(() => setDir(""), 560);
      prev.current = value;
      return () => window.clearTimeout(id);
    }
    prev.current = value;
  }, [value]);
  return <span className={`num tick-${dir} ${className}`}>{text}</span>;
}
