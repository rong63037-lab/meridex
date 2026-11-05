-- Move seeded logins off the demo domain and clear demo wording that is stored in the database.
-- Passwords and TOTP secrets are left unchanged.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying')
      AND column_name ILIKE '%email%'
  LOOP
    EXECUTE format(
      'UPDATE %I.%I SET %I = %L WHERE %I = %L',
      r.table_schema, r.table_name, r.column_name,
      'client@meridexexchange.com',
      r.column_name, 'demo@demo.meridexexchange.com'
    );
    EXECUTE format(
      'UPDATE %I.%I SET %I = replace(%I, %L, %L) WHERE %I LIKE %L',
      r.table_schema, r.table_name, r.column_name, r.column_name,
      '@demo.meridexexchange.com', '@meridexexchange.com',
      r.column_name, '%@demo.meridexexchange.com'
    );
  END LOOP;
END $$;

UPDATE users SET referral_code = 'MERIDEX-SG' WHERE referral_code = 'MERIDEX-DEMO';

UPDATE reward_tasks SET title_en = 'Make a simulated deposit' WHERE id = 'task-deposit' AND title_en = 'Make a demo deposit';

UPDATE help_articles
SET title_en = 'Simulated deposits', title_ms = 'Deposit simulasi'
WHERE id = 'help-deposit';

UPDATE announcements
SET id = 'ann-notice',
    title = '公告',
    body = '新加坡牌照申请进行中。奖励与杠杆模式可能需要牌照，页面会标明。'
WHERE id = 'ann-demo';

UPDATE campaigns SET id = 'camp-welcome', name = '新户任务' WHERE id = 'camp-demo';
UPDATE campaigns SET name = '新户任务' WHERE name LIKE '%演示%';

UPDATE surv_alerts
SET detail = replace(replace(replace(replace(detail, '演示机器人', '机器人'), '巡检台演示', '巡检台'), '告警演示', '告警'), '演示', '')
WHERE detail LIKE '%演示%';

INSERT INTO risk_cases (id, alert_id, subject_user_id, title, status, assignee_id, created_at, updated_at)
SELECT 'case-wash', alert_id, subject_user_id, '案件 · 自成交尝试', status, assignee_id, created_at, updated_at
FROM risk_cases
WHERE id = 'case-demo-wash'
ON CONFLICT (id) DO NOTHING;

UPDATE risk_case_notes SET case_id = 'case-wash' WHERE case_id = 'case-demo-wash';
UPDATE risk_case_notes SET body = replace(replace(body, '演示机器人', '机器人'), '演示', '') WHERE body LIKE '%演示%';
DELETE FROM risk_cases WHERE id = 'case-demo-wash';

UPDATE risk_cases SET title = '案件 · 自成交尝试' WHERE id = 'case-wash' AND title LIKE '%演示%';

UPDATE chat_messages SET body = replace(body, '演示坐席：', '坐席：') WHERE body LIKE '%演示%';
UPDATE geo_alerts SET detail = replace(detail, '演示预置：', '预置：') WHERE detail LIKE '%演示%';

UPDATE redemptions SET detail = replace(detail, '（演示）', '（模拟）') WHERE detail LIKE '%演示%';
UPDATE crypto_transfers
SET address = replace(address, 'demo:', 'mx:'),
    tx_hash = replace(tx_hash, '0xdemo', '0x'),
    detail = replace(replace(detail, '演示地址，不会广播到公链', '模拟地址，不会广播到公链'), '（演示，非真实链）', '（非真实链）')
WHERE address LIKE 'demo:%' OR tx_hash LIKE '0xdemo%' OR detail LIKE '%演示%';

UPDATE deposit_records SET txid = replace(txid, '0xdemo', '0x') WHERE txid LIKE '0xdemo%';

UPDATE instruments SET regulatory_tag = replace(regulatory_tag, 'demo only', 'licence application in progress')
WHERE regulatory_tag ILIKE '%demo only%';
UPDATE instruments SET regulatory_tag = 'DPT – stablecoin, requires MAS DPT licence'
WHERE regulatory_tag = 'DPT – stablecoin, licence application in progress';
UPDATE instruments SET regulatory_tag = 'DPT – tokenised gold, requires MAS DPT licence'
WHERE regulatory_tag = 'DPT – tokenised gold, licence application in progress';
UPDATE instruments SET regulatory_tag = 'CFTC/state · licence application in progress'
WHERE regulatory_tag = 'CFTC/state · licence application in progress';
UPDATE instruments SET regulatory_tag = 'FX · licence application in progress'
WHERE regulatory_tag = 'licence application in progress';

DELETE FROM content_overrides
WHERE value ILIKE '%demo%' OR value LIKE '%演示%' OR key ILIKE '%demo%';

-- Stored sentences (alerts, notes, audit detail) can still name the old address.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying')
  LOOP
    EXECUTE format(
      'UPDATE %I.%I SET %I = replace(%I, %L, %L) WHERE %I LIKE %L',
      r.table_schema, r.table_name, r.column_name, r.column_name,
      'demo@demo.meridexexchange.com', 'client@meridexexchange.com',
      r.column_name, '%demo@demo.meridexexchange.com%'
    );
    EXECUTE format(
      'UPDATE %I.%I SET %I = replace(%I, %L, %L) WHERE %I LIKE %L',
      r.table_schema, r.table_name, r.column_name, r.column_name,
      '@demo.meridexexchange.com', '@meridexexchange.com',
      r.column_name, '%@demo.meridexexchange.com%'
    );
  END LOOP;
END $$;
