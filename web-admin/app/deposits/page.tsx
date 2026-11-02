"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function DepositsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/funds?tab=deposits");
  }, [router]);
  return <p><Link href="/funds?tab=deposits">资金</Link></p>;
}
