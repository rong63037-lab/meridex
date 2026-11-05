import type { Db } from "./db.js";

export type Access = "allow" | "pending" | "block";
export type RegionId = "east" | "southeast" | "south" | "west" | "central" | "us";
export type Risk = "standard" | "edd" | "sanctioned";

export type Place = {
  code: string;
  region: RegionId;
  nameZh: string;
  nameEn: string;
  nameMs: string;
  risk: Risk;
  locked: boolean;
  crypto: Access;
  noteZh: string | null;
  noteEn: string | null;
  noteMs: string | null;
};

export const REGIONS: RegionId[] = ["east", "southeast", "south", "west", "central", "us"];
export const CATEGORIES = ["metal", "crypto", "commodity", "fx"] as const;
export const OPEN_MODES = ["convert", "recurring", "paper"] as const;
export const LICENSED_MODES = ["margin", "perp", "copy"] as const;
export const MATRIX_FIELDS = ["residence", ...CATEGORIES, ...OPEN_MODES, ...LICENSED_MODES] as const;
export type MatrixField = (typeof MATRIX_FIELDS)[number];

const NOTE = {
  cn: [
    "中国大陆禁止居民从事加密货币交易。香港与澳门单独列示。",
    "Mainland China prohibits crypto trading by residents. Hong Kong and Macao are separate.",
    "China daratan melarang dagangan kripto oleh penduduk. Hong Kong dan Makau berasingan.",
  ],
  bd: [
    "孟加拉国央行禁止加密货币交易。",
    "Bangladesh Bank prohibits crypto trading.",
    "Bank Bangladesh melarang dagangan kripto.",
  ],
  np: [
    "尼泊尔央行禁止加密货币交易。",
    "Nepal Rastra Bank prohibits crypto trading.",
    "Bank pusat Nepal melarang dagangan kripto.",
  ],
  qa: [
    "卡塔尔央行禁止加密资产交易。",
    "Qatar Central Bank prohibits crypto-asset trading.",
    "Bank pusat Qatar melarang dagangan aset kripto.",
  ],
  kw: [
    "科威特资本市场管理局禁止加密资产交易。",
    "Kuwait's capital markets authority prohibits crypto-asset trading.",
    "Pihak berkuasa pasaran modal Kuwait melarang dagangan aset kripto.",
  ],
  om: [
    "阿曼资本市场管理局禁止加密资产交易。",
    "Oman's capital markets authority prohibits crypto-asset trading.",
    "Pihak berkuasa pasaran modal Oman melarang dagangan aset kripto.",
  ],
  iq: [
    "伊拉克央行禁止加密货币交易。",
    "The Central Bank of Iraq prohibits crypto trading.",
    "Bank pusat Iraq melarang dagangan kripto.",
  ],
  af: [
    "阿富汗当局禁止加密货币。高风险，开户需加强尽职调查。",
    "Afghan authorities prohibit crypto. High risk: onboarding needs enhanced due diligence.",
    "Pihak berkuasa Afghanistan melarang kripto. Risiko tinggi: perlu usaha wajar diperketat.",
  ],
  mm: [
    "高风险，开户需加强尽职调查。",
    "High risk: onboarding needs enhanced due diligence.",
    "Risiko tinggi: pembukaan akaun perlu usaha wajar diperketat.",
  ],
  sanctioned: [
    "全面制裁，硬关闭，合规页不能改开。",
    "Comprehensive sanctions. Hard-closed and not editable.",
    "Sekatan menyeluruh. Ditutup keras dan tidak boleh diubah.",
  ],
} as const;

function note(key: keyof typeof NOTE | null): [string | null, string | null, string | null] {
  if (!key) return [null, null, null];
  const row = NOTE[key];
  return [row[0], row[1], row[2]];
}

function place(
  code: string,
  region: RegionId,
  nameZh: string,
  nameEn: string,
  nameMs: string,
  extra?: { risk?: Risk; locked?: boolean; crypto?: Access; note?: keyof typeof NOTE },
): Place {
  const [noteZh, noteEn, noteMs] = note(extra?.note ?? null);
  const locked = extra?.locked === true;
  return {
    code,
    region,
    nameZh,
    nameEn,
    nameMs,
    risk: extra?.risk ?? (locked ? "sanctioned" : "standard"),
    locked,
    crypto: locked ? "block" : extra?.crypto ?? "allow",
    noteZh,
    noteEn,
    noteMs,
  };
}

/** UN Asia, plus the territories the owner named, and the United States. */
export const PLACES: Place[] = [
  place("CN", "east", "中国大陆", "Mainland China", "China daratan", { crypto: "block", note: "cn" }),
  place("HK", "east", "香港", "Hong Kong", "Hong Kong"),
  place("MO", "east", "澳门", "Macao", "Makau"),
  place("TW", "east", "台湾", "Taiwan", "Taiwan"),
  place("JP", "east", "日本", "Japan", "Jepun"),
  place("KR", "east", "韩国", "Korea, Republic of", "Korea"),
  place("KP", "east", "朝鲜", "Korea, DPR", "Korea Utara", { locked: true, note: "sanctioned" }),
  place("MN", "east", "蒙古", "Mongolia", "Mongolia"),

  place("BN", "southeast", "文莱", "Brunei", "Brunei"),
  place("KH", "southeast", "柬埔寨", "Cambodia", "Kemboja"),
  place("ID", "southeast", "印度尼西亚", "Indonesia", "Indonesia"),
  place("LA", "southeast", "老挝", "Laos", "Laos"),
  place("MY", "southeast", "马来西亚", "Malaysia", "Malaysia"),
  place("MM", "southeast", "缅甸", "Myanmar", "Myanmar", { risk: "edd", note: "mm" }),
  place("PH", "southeast", "菲律宾", "Philippines", "Filipina"),
  place("SG", "southeast", "新加坡", "Singapore", "Singapura"),
  place("TH", "southeast", "泰国", "Thailand", "Thailand"),
  place("TL", "southeast", "东帝汶", "Timor-Leste", "Timor-Leste"),
  place("VN", "southeast", "越南", "Vietnam", "Vietnam"),

  place("AF", "south", "阿富汗", "Afghanistan", "Afghanistan", { risk: "edd", crypto: "block", note: "af" }),
  place("BD", "south", "孟加拉国", "Bangladesh", "Bangladesh", { crypto: "block", note: "bd" }),
  place("BT", "south", "不丹", "Bhutan", "Bhutan"),
  place("IN", "south", "印度", "India", "India"),
  place("IR", "south", "伊朗", "Iran", "Iran", { locked: true, note: "sanctioned" }),
  place("MV", "south", "马尔代夫", "Maldives", "Maldives"),
  place("NP", "south", "尼泊尔", "Nepal", "Nepal", { crypto: "block", note: "np" }),
  place("PK", "south", "巴基斯坦", "Pakistan", "Pakistan"),
  place("LK", "south", "斯里兰卡", "Sri Lanka", "Sri Lanka"),

  place("AE", "west", "阿联酋", "United Arab Emirates", "Emiriah Arab Bersatu"),
  place("AM", "west", "亚美尼亚", "Armenia", "Armenia"),
  place("AZ", "west", "阿塞拜疆", "Azerbaijan", "Azerbaijan"),
  place("BH", "west", "巴林", "Bahrain", "Bahrain"),
  place("CY", "west", "塞浦路斯", "Cyprus", "Cyprus"),
  place("GE", "west", "格鲁吉亚", "Georgia", "Georgia"),
  place("IL", "west", "以色列", "Israel", "Israel"),
  place("IQ", "west", "伊拉克", "Iraq", "Iraq", { crypto: "block", note: "iq" }),
  place("JO", "west", "约旦", "Jordan", "Jordan"),
  place("KW", "west", "科威特", "Kuwait", "Kuwait", { crypto: "block", note: "kw" }),
  place("LB", "west", "黎巴嫩", "Lebanon", "Lubnan"),
  place("OM", "west", "阿曼", "Oman", "Oman", { crypto: "block", note: "om" }),
  place("PS", "west", "巴勒斯坦", "Palestine", "Palestin"),
  place("QA", "west", "卡塔尔", "Qatar", "Qatar", { crypto: "block", note: "qa" }),
  place("SA", "west", "沙特阿拉伯", "Saudi Arabia", "Arab Saudi"),
  place("SY", "west", "叙利亚", "Syria", "Syria", { locked: true, note: "sanctioned" }),
  place("TR", "west", "土耳其", "Türkiye", "Turkiye"),
  place("YE", "west", "也门", "Yemen", "Yaman"),

  place("KZ", "central", "哈萨克斯坦", "Kazakhstan", "Kazakhstan"),
  place("KG", "central", "吉尔吉斯斯坦", "Kyrgyzstan", "Kyrgyzstan"),
  place("TJ", "central", "塔吉克斯坦", "Tajikistan", "Tajikistan"),
  place("TM", "central", "土库曼斯坦", "Turkmenistan", "Turkmenistan"),
  place("UZ", "central", "乌兹别克斯坦", "Uzbekistan", "Uzbekistan"),

  place("US", "us", "美国", "United States", "Amerika Syarikat"),
];

const BY_CODE = new Map(PLACES.map((row) => [row.code, row]));

export function placeOf(code: string): Place | undefined {
  return BY_CODE.get(code.trim().toUpperCase());
}

export function knownPlace(code: string): boolean {
  return BY_CODE.has(code.trim().toUpperCase());
}

export function isLocked(code: string): boolean {
  return placeOf(code)?.locked === true;
}

/** Residence can trade an instrument when the jurisdiction is on the list and not hard-blocked. */
export function offeredTo(code: string): boolean {
  const row = placeOf(code);
  return Boolean(row && !row.locked);
}

export function countryDefault(row: Place): Access {
  return row.locked ? "block" : "allow";
}

export function categoryDefault(row: Place, category: string): Access {
  if (row.locked) return "block";
  if (category === "crypto") return row.crypto;
  return "allow";
}

export function modeDefault(row: Place, mode: string): Access {
  if (row.locked) return "block";
  if ((LICENSED_MODES as readonly string[]).includes(mode)) return "block";
  return "allow";
}

export function entityDefault(row: Place): string | null {
  if (row.locked) return null;
  if (row.code === "MY") return "MY-ENTITY";
  return "SG-OPCO";
}

export class CoverageError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export function assertBulk(payload: Record<string, unknown>): { region: RegionId; field: MatrixField; access: Access } {
  const region = String(payload.region || "");
  const field = String(payload.field || "");
  const access = String(payload.access || "");
  if (!REGIONS.includes(region as RegionId)) throw new CoverageError("VALIDATION");
  if (!(MATRIX_FIELDS as readonly string[]).includes(field)) throw new CoverageError("VALIDATION");
  if (access !== "allow" && access !== "pending" && access !== "block") throw new CoverageError("VALIDATION");
  return { region: region as RegionId, field: field as MatrixField, access };
}

async function writeAccess(
  pool: Db,
  sql: { read: string; write: string; audit: string },
  args: { keys: string[]; access: Access; previousArgs: string[]; actor: { id: number | null; email: string } },
): Promise<void> {
  const current = await pool.query(sql.read, args.keys);
  const previous = (current.rows[0]?.access as string | undefined) ?? null;
  await pool.query(sql.write, [...args.keys, args.access]);
  if (previous === args.access) return;
  await pool.query(sql.audit, [...args.previousArgs, previous, args.access, args.actor.id, args.actor.email]);
}

async function writeResidence(pool: Db, row: Place, access: Access, actor: { id: number | null; email: string }, entity?: string | null) {
  const current = await pool.query(`SELECT access, entity_id FROM jurisdiction_access WHERE country = $1`, [row.code]);
  const previous = (current.rows[0]?.access as string | undefined) ?? null;
  const entityId = access === "block" ? null : entity ?? entityDefault(row);
  await pool.query(
    `INSERT INTO jurisdiction_access (country, access, entity_id, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (country) DO UPDATE SET access = EXCLUDED.access, entity_id = EXCLUDED.entity_id, updated_at = now()`,
    [row.code, access, entityId],
  );
  if (previous === access) return;
  await pool.query(
    `INSERT INTO jurisdiction_audit (country, previous_access, access, actor_user_id, actor_email)
     VALUES ($1,$2,$3,$4,$5)`,
    [row.code, previous, access, actor.id, actor.email],
  );
}

async function writeCategory(pool: Db, row: Place, category: string, access: Access, actor: { id: number | null; email: string }) {
  await writeAccess(pool, {
    read: `SELECT access FROM category_access WHERE category = $1 AND country = $2`,
    write: `INSERT INTO category_access (category, country, access, updated_at) VALUES ($1,$2,$3,now())
            ON CONFLICT (category, country) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
    audit: `INSERT INTO category_audit (category, country, previous_access, access, actor_user_id, actor_email)
            VALUES ($1,$2,$3,$4,$5,$6)`,
  }, {
    keys: [category, row.code],
    access,
    previousArgs: [category, row.code],
    actor,
  });
}

async function writeMode(pool: Db, row: Place, mode: string, access: Access, actor: { id: number | null; email: string }) {
  await writeAccess(pool, {
    read: `SELECT access FROM mode_access WHERE mode = $1 AND country = $2`,
    write: `INSERT INTO mode_access (mode, country, access, updated_at) VALUES ($1,$2,$3,now())
            ON CONFLICT (mode, country) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
    audit: `INSERT INTO mode_audit (mode, country, previous_access, access, actor_user_id, actor_email)
            VALUES ($1,$2,$3,$4,$5,$6)`,
  }, {
    keys: [mode, row.code],
    access,
    previousArgs: [mode, row.code],
    actor,
  });
}

const SEED_ACTOR = { id: null as number | null, email: "seed-asia" };

async function syncPlace(pool: Db, row: Place, overwrite: boolean) {
  const jur = await pool.query(`SELECT 1 FROM jurisdiction_access WHERE country = $1`, [row.code]);
  if (overwrite || !jur.rowCount) await writeResidence(pool, row, countryDefault(row), SEED_ACTOR);
  for (const category of CATEGORIES) {
    if (!overwrite) {
      const have = await pool.query(`SELECT 1 FROM category_access WHERE category = $1 AND country = $2`, [category, row.code]);
      if (have.rowCount) continue;
    }
    await writeCategory(pool, row, category, categoryDefault(row, category), SEED_ACTOR);
  }
  for (const mode of [...OPEN_MODES, ...LICENSED_MODES]) {
    if (!overwrite) {
      const have = await pool.query(`SELECT 1 FROM mode_access WHERE mode = $1 AND country = $2`, [mode, row.code]);
      if (have.rowCount) continue;
    }
    await writeMode(pool, row, mode, modeDefault(row, mode), SEED_ACTOR);
  }
}

/** Version 1 installs the Asia matrix once. Later boots only fill countries that are new. */
export async function ensureCoverage(pool: Db): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS coverage_meta (
    id INT PRIMARY KEY,
    version INT NOT NULL
  )`);
  await pool.query(`INSERT INTO coverage_meta (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`);
  const ver = await pool.query(`SELECT version FROM coverage_meta WHERE id = 1`);
  const version = Number(ver.rows[0]?.version ?? 0);
  const overwrite = version < 1;
  for (const row of PLACES) await syncPlace(pool, row, overwrite);
  if (overwrite) await pool.query(`UPDATE coverage_meta SET version = 1 WHERE id = 1`);
}

export async function applyBulk(
  pool: Db,
  payload: Record<string, unknown>,
  actor: { id: number; email: string },
): Promise<{ updated: string[]; skipped: string[] }> {
  const { region, field, access } = assertBulk(payload);
  const updated: string[] = [];
  const skipped: string[] = [];
  for (const row of PLACES.filter((item) => item.region === region)) {
    if (row.locked) {
      skipped.push(row.code);
      continue;
    }
    if (row.code === "US" && (field === "margin" || field === "perp") && access === "allow") {
      skipped.push(row.code);
      continue;
    }
    if (field === "residence") await writeResidence(pool, row, access, actor);
    else if ((CATEGORIES as readonly string[]).includes(field)) await writeCategory(pool, row, field, access, actor);
    else await writeMode(pool, row, field, access, actor);
    updated.push(row.code);
  }
  return { updated, skipped };
}

export async function publicCatalog(pool: Db) {
  const rows = await pool.query(`SELECT country, access FROM jurisdiction_access`);
  const access = new Map(rows.rows.map((row) => [row.country as string, row.access as Access]));
  const regions = REGIONS.map((id) => ({
    id,
    countries: PLACES.filter((row) => row.region === id && !row.locked && access.get(row.code) !== "block").map((row) => ({
      code: row.code,
      nameZh: row.nameZh,
      nameEn: row.nameEn,
      nameMs: row.nameMs,
      risk: row.risk,
      access: access.get(row.code) ?? countryDefault(row),
    })),
  })).filter((region) => region.countries.length > 0);
  const count = regions.reduce((sum, region) => sum + region.countries.length, 0);
  return { count, regions };
}

export async function adminCatalog(pool: Db) {
  const rows = await pool.query(`SELECT country, access, entity_id, updated_at FROM jurisdiction_access`);
  const byCountry = new Map(rows.rows.map((row) => [row.country as string, row]));
  const rules = PLACES.map((row) => {
    const live = byCountry.get(row.code);
    return {
      country: row.code,
      access: (live?.access as Access | undefined) ?? countryDefault(row),
      entity_id: (live?.entity_id as string | null | undefined) ?? entityDefault(row),
      updated_at: live?.updated_at ?? null,
      region: row.region,
      nameZh: row.nameZh,
      nameEn: row.nameEn,
      nameMs: row.nameMs,
      risk: row.risk,
      locked: row.locked,
      noteZh: row.noteZh,
      noteEn: row.noteEn,
      noteMs: row.noteMs,
    };
  });
  const audit = await pool.query(
    `SELECT id, country, previous_access, access, actor_email, created_at
     FROM jurisdiction_audit ORDER BY id DESC LIMIT 40`,
  );
  return { rules, audit: audit.rows, regions: REGIONS };
}
