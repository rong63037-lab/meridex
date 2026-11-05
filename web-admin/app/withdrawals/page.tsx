"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function WithdrawalsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/funds?tab=withdrawals");
  }, [router]);
  return <p><Link href="/funds?tab=withdrawals">资金</Link></p>;
}
