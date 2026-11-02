"use client";

import { useEffect, useState } from "react";

type Prompt = Event & { prompt: () => Promise<void> };

export function Pwa() {
  const [install, setInstall] = useState<Prompt | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstall(event as Prompt);
    };
    const onOff = () => setOffline(!navigator.onLine);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("online", onOff);
    window.addEventListener("offline", onOff);
    onOff();
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("online", onOff);
      window.removeEventListener("offline", onOff);
    };
  }, []);

  return (
    <div className="install-card" id="pwa-install">
      <div>
        <b>安装 MERIDEX</b>
        <p>{offline ? "当前离线，已打开缓存的外壳。" : "可安装到主屏幕。离线时仍能打开已缓存的页面。"}</p>
      </div>
      <button
        type="button"
        onClick={() => {
          if (install) void install.prompt();
        }}
      >
        {install ? "安装" : "添加到主屏幕"}
      </button>
    </div>
  );
}
