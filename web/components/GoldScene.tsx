"use client";

import { useEffect, useRef } from "react";

export function GoldField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let running = true;
    const dots = Array.from({ length: 42 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.6 + Math.random() * 1.6,
      s: 0.12 + Math.random() * 0.35,
      a: 0.15 + Math.random() * 0.45,
    }));

    const paint = (t: number) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const glow = ctx.createRadialGradient(width * 0.72, height * 0.35, 20, width * 0.7, height * 0.4, width * 0.55);
      glow.addColorStop(0, "rgba(201,162,75,0.16)");
      glow.addColorStop(1, "rgba(201,162,75,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.strokeStyle = `rgba(245,213,138,${0.08 + i * 0.03})`;
        for (let x = 0; x <= width; x += 8) {
          const y = height * (0.25 + i * 0.12) + Math.sin(x * 0.008 + t * 0.0004 + i) * (18 + i * 4);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      for (const dot of dots) {
        const x = ((dot.x + t * 0.00002 * dot.s) % 1) * width;
        const y = (dot.y + Math.sin(t * 0.0003 + dot.x * 8) * 0.02) * height;
        ctx.beginPath();
        ctx.fillStyle = `rgba(245,213,138,${dot.a})`;
        ctx.arc(x, y, dot.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    let last = 0;
    const loop = (now: number) => {
      if (!running) return;
      if (now - last > 50) {
        last = now;
        paint(now);
      }
      frame = requestAnimationFrame(loop);
    };
    if (reduce) paint(0);
    else frame = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={ref} className="gold-field" aria-hidden="true" />;
}

export function GoldBar() {
  return (
    <div className="ingot-stage" aria-hidden="true">
      <div className="ingot">
        <svg viewBox="0 0 220 120">
          <defs>
            <linearGradient id="barFace" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#F5D58A" />
              <stop offset="0.5" stopColor="#C9A24B" />
              <stop offset="1" stopColor="#8C6A2B" />
            </linearGradient>
          </defs>
          <path d="M28 86 58 28h104l30 58H28Z" fill="url(#barFace)" />
          <path d="M58 28h104l-14 16H72L58 28Z" fill="#F5D58A" opacity="0.55" />
          <path d="M96 62h28L110 40l-14 22Z" fill="#14110A" />
          <path d="M92 56h36v4H92z" fill="#14110A" />
        </svg>
      </div>
    </div>
  );
}
