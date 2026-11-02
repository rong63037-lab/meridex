import pg from "pg";
const db = new pg.Pool({ connectionString: "postgres://meridex:<redacted>@127.0.0.1:5432/meridex" });
const c = await db.connect();
const users = (await c.query(`SELECT id FROM users WHERE email LIKE 'kyc-test-%@example.test'`)).rows.map((r) => Number(r.id));
console.log("throwaway users", users);
const refs = (await c.query(
  `SELECT cl.relname AS t, a.attname AS col FROM pg_constraint k
   JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey)
   WHERE k.contype = 'f' AND k.confrelid = 'users'::regclass`,
)).rows;
const touched: string[] = [];
try {
  await c.query("BEGIN");
  // Nullify self-references like reviewed_by first
  await c.query(`UPDATE kyc_profiles SET reviewed_by = NULL WHERE reviewed_by = ANY($1)`, [users]);
  for (let pass = 0; pass < 4; pass++) {
    for (const r of refs) {
      if (r.t === "users") continue;
      await c.query("SAVEPOINT s");
      try {
        const res = await c.query(`DELETE FROM "${r.t}" WHERE "${r.col}" = ANY($1)`, [users]);
        if (res.rowCount) touched.push(`${r.t}.${r.col}:${res.rowCount}`);
        await c.query("RELEASE SAVEPOINT s");
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT s");
        if (pass === 3) touched.push(`FAILED ${r.t}.${r.col}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }
  const del = await c.query(`DELETE FROM users WHERE id = ANY($1) AND email LIKE 'kyc-test-%@example.test'`, [users]);
  touched.push(`users:${del.rowCount}`);
  await c.query("COMMIT");
  console.log("committed", touched);
} catch (e) {
  await c.query("ROLLBACK");
  console.log("rolled back", (e as Error).message, touched);
} finally {
  c.release();
  await db.end();
}
