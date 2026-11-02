const zh = {
  banner: "客服不会在聊天中提供任何收款账户或钱包地址，也不会要求你转账到个人账户。充值请只使用资金页显示的信息。",
  depositQueue: "充值协助",
  callbackQueue: "回拨",
  tasks: "到账跟进",
  reply: "回复",
  guide: "发送资金页链接",
  assign: "指定客户经理",
  customer: "客户邮箱",
  manager: "员工邮箱",
  vip: "标记为大客户",
  save: "保存",
  empty: "空",
  warning: "这条消息里有未关联到该客户的地址，已拦截。请改用充值地址卡片。",
  card: "发送充值地址卡片",
  lookup: "查询充值",
  show: "显示完整地址",
  hide: "隐藏地址",
  readOnly: "只读。地址的导入、修改和删除只在地址后台 http://127.0.0.1:4319。",
};

const en = {
  banner: "Support will never send a receiving account or wallet address in chat, and will never ask you to transfer funds to a personal account. Deposit only with the details shown on the funds page.",
  depositQueue: "Deposit help",
  callbackQueue: "Callbacks",
  tasks: "Credit follow-up",
  reply: "Reply",
  guide: "Send funds-page link",
  assign: "Assign account manager",
  customer: "Customer email",
  manager: "Staff email",
  vip: "Mark as a large account",
  save: "Save",
  empty: "Empty",
  warning: "That message contained an address that is not linked to this customer. Send a deposit address card instead.",
  card: "Send deposit address card",
  lookup: "Look up a deposit",
  show: "Show full",
  hide: "Hide",
  readOnly: "Read only. Import, edit, and delete stay on the address desk at http://127.0.0.1:4319.",
};

const ms = {
  banner: "Sokongan tidak akan memberi akaun penerima atau alamat dompet dalam sembang, dan tidak akan meminta anda memindahkan dana ke akaun peribadi. Deposit hanya dengan maklumat di halaman dana.",
  depositQueue: "Bantuan deposit",
  callbackQueue: "Panggilan balik",
  tasks: "Susulan kredit",
  reply: "Balas",
  guide: "Hantar pautan halaman dana",
  assign: "Tetapkan pengurus akaun",
  customer: "E-mel pelanggan",
  manager: "E-mel kakitangan",
  vip: "Tanda sebagai akaun besar",
  save: "Simpan",
  empty: "Kosong",
  warning: "Mesej itu mengandungi alamat yang tidak dipautkan kepada pelanggan ini.",
  card: "Hantar kad alamat deposit",
  lookup: "Cari deposit",
  show: "Tunjuk penuh",
  hide: "Sembunyi",
  readOnly: "Baca sahaja. Import, edit, dan padam hanya di meja alamat http://127.0.0.1:4319.",
};

export function conciergeCopy(lang: string) {
  if (lang === "en") return en;
  if (lang === "ms") return ms;
  return zh;
}
