"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function NotificationsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/account/preferences"); }, [router]);
  return null;
}
