"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

type Country = { code: string; nameZh: string; nameEn: string; nameMs: string; risk: string };
type Region = { id: string; countries: Country[] };

const REGION_KEY = {
  east: "regionEast",
  southeast: "regionSoutheast",
  south: "regionSouth",
  west: "regionWest",
  central: "regionCentral",
  us: "regionUs",
} as const;

export function CountrySelect({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const { t, lang } = useI18n();
  const [regions, setRegions] = useState<Region[]>([]);

  useEffect(() => {
    api<{ regions: Region[] }>("/api/jurisdictions")
      .then((res) => setRegions(res.regions))
      .catch(() => undefined);
  }, []);

  function name(row: Country) {
    if (lang === "zh") return row.nameZh;
    if (lang === "ms") return row.nameMs;
    return row.nameEn;
  }

  const known = regions.some((region) => region.countries.some((row) => row.code === value));

  return (
    <select className="desk-input" value={value} onChange={(e) => onChange(e.target.value)} required>
      {!known && value ? <option value={value}>{value}</option> : null}
      {regions.map((region) => (
        <optgroup key={region.id} label={t[REGION_KEY[region.id as keyof typeof REGION_KEY]]}>
          {region.countries.map((row) => (
            <option key={row.code} value={row.code}>{name(row)} · {row.code}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
