export type Lang = "zh" | "en" | "ms";

export type PoolCopy = {
  ribbon: string;
  title: string;
  help: string;
  total: string;
  free: string;
  assigned: string;
  lowOk: string;
  lowBad: string;
  add: string;
  close: string;
  network: string;
  auto: string;
  netBtc: string;
  netEth: string;
  netUsdtEth: string;
  netUsdtTron: string;
  pasteLabel: string;
  pasteHint: string;
  totp: string;
  totpHint: string;
  save: string;
  checking: string;
  ready: string;
  blocked: string;
  saved: string;
  lineUnknown: string;
  lineEvm: string;
  lineMismatch: string;
  lineBtc: string;
  lineEvmSum: string;
  lineTron: string;
  lineDup: string;
  lineGeneric: string;
  search: string;
  filterAll: string;
  filterFree: string;
  filterAssigned: string;
  filterRetired: string;
  colAddress: string;
  colNetwork: string;
  colStatus: string;
  colCustomer: string;
  none: string;
  empty: string;
  replace: string;
  remove: string;
  newAddress: string;
  cancel: string;
  replaced: string;
  removed: string;
  removeWarn: string;
  more: string;
  moreHelp: string;
  thresholdTitle: string;
  thresholdHint: string;
  csvTitle: string;
  csvHint: string;
  retireTitle: string;
  retireHint: string;
  assignTitle: string;
  assignHint: string;
  email: string;
  pick: string;
  logout: string;
  loading: string;
  statusFree: string;
  statusAssigned: string;
  statusRetired: string;
  errTotp: string;
  errTotpNeed: string;
  errLocked: string;
  errInUse: string;
  errDup: string;
  errBad: string;
  errMissing: string;
  errGeneric: string;
  loginKicker: string;
  loginTitle: string;
  loginLede: string;
  loginHeading: string;
  password: string;
  signIn: string;
  doneThreshold: string;
  doneCsv: string;
  doneRetire: string;
  doneAssign: string;
};

const zh: PoolCopy = {
  ribbon: "地址后台",
  title: "充值地址",
  help: "每行粘贴一个地址。比特币和波场会自动认出。以太坊地址要先选 ETH 或 USDT。保存、更换、删除各填一次验证器上当前的 6 位数字。",
  total: "全部",
  free: "空闲",
  assigned: "已分配",
  lowOk: "空闲地址够用",
  lowBad: "有的网络空闲地址不多",
  add: "添加地址",
  close: "收起",
  network: "网络",
  auto: "自动识别",
  netBtc: "比特币",
  netEth: "以太坊 · ETH",
  netUsdtEth: "以太坊 · USDT",
  netUsdtTron: "波场 · USDT",
  pasteLabel: "地址",
  pasteHint: "一行一个。不要加表头。",
  totp: "验证码",
  totpHint: "看验证器上现在的 6 位数字。这一次保存只用这一组。",
  save: "保存",
  checking: "正在检查…",
  ready: "可以保存 {n} 个",
  blocked: "有 {n} 行需要改，还不能保存",
  saved: "已添加 {n} 个地址",
  lineUnknown: "看不出这是哪种地址",
  lineEvm: "这是以太坊地址，请在上面选择 ETH 或 USDT",
  lineMismatch: "这一行和所选网络对不上",
  lineBtc: "比特币地址没通过检查",
  lineEvmSum: "以太坊地址没通过检查",
  lineTron: "波场地址没通过检查",
  lineDup: "这个地址已经有了",
  lineGeneric: "这一行不能用",
  search: "搜索地址或客户",
  filterAll: "全部状态",
  filterFree: "空闲",
  filterAssigned: "已分配",
  filterRetired: "已停用",
  colAddress: "地址",
  colNetwork: "网络",
  colStatus: "状态",
  colCustomer: "客户",
  none: "还没有客户",
  empty: "没有符合的地址",
  replace: "更换",
  remove: "删除",
  newAddress: "新地址",
  cancel: "取消",
  replaced: "已换成新地址。客户会在页面上看到通知。",
  removed: "已删除",
  removeWarn: "这个地址还没分给客户。删除后不能恢复。",
  more: "更多",
  moreHelp: "平时不用打开。这里是库存提醒、表格导入、停用和手动分配。",
  thresholdTitle: "空闲地址太少时提醒我",
  thresholdHint: "某个网络的空闲地址少于此数时，你会收到通知。",
  csvTitle: "按表格粘贴",
  csvHint: "每行：币种,网络,地址。例如 BTC,Bitcoin,bc1…",
  retireTitle: "停用已分配的地址",
  retireHint: "停用后客户不能再用它。客户会收到通知。旧地址仍用来核对已经转出的款项。",
  assignTitle: "把空闲地址分给客户",
  assignHint: "填客户登录用的邮箱。",
  email: "客户邮箱",
  pick: "选择地址",
  logout: "退出",
  loading: "正在加载…",
  statusFree: "空闲",
  statusAssigned: "已分配",
  statusRetired: "已停用",
  errTotp: "验证码不对。请看验证器上现在的 6 位数字。",
  errTotpNeed: "请先填写验证码。",
  errLocked: "验证码错了太多次。请等 15 分钟再试。",
  errInUse: "这个地址已经分给客户，不能删除。",
  errDup: "这个地址已经存在。",
  errBad: "地址格式不对。",
  errMissing: "没有找到。",
  errGeneric: "没有完成。请再试一次。",
  loginKicker: "地址",
  loginTitle: "只改充值地址",
  loginLede: "用所有者账号登录。每次添加、更换或删除都要验证器上的新数字。主后台只能看，不能改。",
  loginHeading: "所有者登录",
  password: "密码",
  signIn: "登录",
  doneThreshold: "提醒线已保存",
  doneCsv: "表格里的地址已处理",
  doneRetire: "地址已停用。客户会收到通知。",
  doneAssign: "已分给这位客户",
};

const en: PoolCopy = {
  ribbon: "Address desk",
  title: "Deposit addresses",
  help: "Paste one address per line. Bitcoin and TRON are recognised automatically. For an Ethereum address, choose ETH or USDT first. Adding, replacing, and removing each ask once for the 6 digits currently on your authenticator.",
  total: "Total",
  free: "Free",
  assigned: "Assigned",
  lowOk: "Enough free addresses",
  lowBad: "Some networks are running low",
  add: "Add addresses",
  close: "Close",
  network: "Network",
  auto: "Detect automatically",
  netBtc: "Bitcoin",
  netEth: "Ethereum · ETH",
  netUsdtEth: "Ethereum · USDT",
  netUsdtTron: "TRON · USDT",
  pasteLabel: "Addresses",
  pasteHint: "One per line. No header row.",
  totp: "Code",
  totpHint: "The 6 digits on your authenticator right now. One code covers this whole save.",
  save: "Save",
  checking: "Checking…",
  ready: "{n} ready to save",
  blocked: "{n} lines need a fix before saving",
  saved: "Added {n} addresses",
  lineUnknown: "This does not look like a supported address",
  lineEvm: "This is an Ethereum address. Choose ETH or USDT above",
  lineMismatch: "This line does not match the network you chose",
  lineBtc: "This Bitcoin address did not pass the check",
  lineEvmSum: "This Ethereum address did not pass the check",
  lineTron: "This TRON address did not pass the check",
  lineDup: "This address is already in the list",
  lineGeneric: "This line cannot be used",
  search: "Search address or customer",
  filterAll: "All statuses",
  filterFree: "Free",
  filterAssigned: "Assigned",
  filterRetired: "Stopped",
  colAddress: "Address",
  colNetwork: "Network",
  colStatus: "Status",
  colCustomer: "Customer",
  none: "No customer yet",
  empty: "No addresses match",
  replace: "Replace",
  remove: "Remove",
  newAddress: "New address",
  cancel: "Cancel",
  replaced: "Replaced. The customer will see a notice in the app.",
  removed: "Removed",
  removeWarn: "This address is not assigned to a customer. Removing it cannot be undone.",
  more: "More",
  moreHelp: "Leave this closed. It holds the low-stock reminder, spreadsheet paste, stop, and manual assign.",
  thresholdTitle: "Remind me when free addresses run low",
  thresholdHint: "You get a notice when a network has fewer free addresses than this number.",
  csvTitle: "Paste a spreadsheet",
  csvHint: "One line: asset,network,address. Example BTC,Bitcoin,bc1…",
  retireTitle: "Stop an assigned address",
  retireHint: "The customer can no longer use it and will be notified. The old address still identifies funds already sent.",
  assignTitle: "Give a free address to a customer",
  assignHint: "Use the email they sign in with.",
  email: "Customer email",
  pick: "Choose an address",
  logout: "Sign out",
  loading: "Loading…",
  statusFree: "Free",
  statusAssigned: "Assigned",
  statusRetired: "Stopped",
  errTotp: "That code is not current. Use the 6 digits on your authenticator now.",
  errTotpNeed: "Enter the code first.",
  errLocked: "Too many wrong codes. Wait 15 minutes.",
  errInUse: "This address is assigned to a customer and cannot be removed.",
  errDup: "This address is already stored.",
  errBad: "That address is not valid.",
  errMissing: "Not found.",
  errGeneric: "That did not go through. Try again.",
  loginKicker: "Addresses",
  loginTitle: "Deposit addresses only",
  loginLede: "Sign in with the owner account. Every add, replace, or remove needs a new authenticator code. The main admin can look, not change.",
  loginHeading: "Owner sign-in",
  password: "Password",
  signIn: "Sign in",
  doneThreshold: "Reminder saved",
  doneCsv: "Spreadsheet rows processed",
  doneRetire: "Address stopped. The customer will be notified.",
  doneAssign: "Assigned to that customer",
};

const ms: PoolCopy = {
  ribbon: "Meja alamat",
  title: "Alamat deposit",
  help: "Tampal satu alamat setiap baris. Bitcoin dan TRON dikenali sendiri. Untuk alamat Ethereum, pilih ETH atau USDT dahulu. Tambah, ganti, dan padam masing-masing minta 6 digit semasa pada pengesah sekali.",
  total: "Jumlah",
  free: "Kosong",
  assigned: "Diberi",
  lowOk: "Alamat kosong mencukupi",
  lowBad: "Ada rangkaian yang hampir habis",
  add: "Tambah alamat",
  close: "Tutup",
  network: "Rangkaian",
  auto: "Kenal pasti sendiri",
  netBtc: "Bitcoin",
  netEth: "Ethereum · ETH",
  netUsdtEth: "Ethereum · USDT",
  netUsdtTron: "TRON · USDT",
  pasteLabel: "Alamat",
  pasteHint: "Satu setiap baris. Jangan letak tajuk.",
  totp: "Kod",
  totpHint: "6 digit pada pengesah sekarang. Satu kod meliputi simpanan ini.",
  save: "Simpan",
  checking: "Sedang semak…",
  ready: "{n} sedia disimpan",
  blocked: "{n} baris perlu dibetulkan sebelum simpan",
  saved: "{n} alamat ditambah",
  lineUnknown: "Alamat ini tidak dikenali",
  lineEvm: "Ini alamat Ethereum. Pilih ETH atau USDT di atas",
  lineMismatch: "Baris ini tidak sepadan dengan rangkaian yang dipilih",
  lineBtc: "Alamat Bitcoin tidak lulus semakan",
  lineEvmSum: "Alamat Ethereum tidak lulus semakan",
  lineTron: "Alamat TRON tidak lulus semakan",
  lineDup: "Alamat ini sudah ada",
  lineGeneric: "Baris ini tidak boleh digunakan",
  search: "Cari alamat atau pelanggan",
  filterAll: "Semua status",
  filterFree: "Kosong",
  filterAssigned: "Diberi",
  filterRetired: "Dihentikan",
  colAddress: "Alamat",
  colNetwork: "Rangkaian",
  colStatus: "Status",
  colCustomer: "Pelanggan",
  none: "Belum ada pelanggan",
  empty: "Tiada alamat yang sepadan",
  replace: "Ganti",
  remove: "Padam",
  newAddress: "Alamat baharu",
  cancel: "Batal",
  replaced: "Diganti. Pelanggan akan nampak notis dalam aplikasi.",
  removed: "Dipadam",
  removeWarn: "Alamat ini belum diberi kepada pelanggan. Padam tidak boleh diundur.",
  more: "Lagi",
  moreHelp: "Biarkan tertutup. Di sini ada peringatan stok, tampalan jadual, henti, dan pemberian manual.",
  thresholdTitle: "Ingatkan saya bila alamat kosong semakin sedikit",
  thresholdHint: "Anda dapat notis bila rangkaian mempunyai alamat kosong kurang daripada nombor ini.",
  csvTitle: "Tampal jadual",
  csvHint: "Satu baris: aset,rangkaian,alamat. Contoh BTC,Bitcoin,bc1…",
  retireTitle: "Hentikan alamat yang sudah diberi",
  retireHint: "Pelanggan tidak boleh guna lagi dan akan dimaklumkan. Alamat lama masih mengenal pasti dana yang sudah dihantar.",
  assignTitle: "Beri alamat kosong kepada pelanggan",
  assignHint: "Guna e-mel log masuk pelanggan.",
  email: "E-mel pelanggan",
  pick: "Pilih alamat",
  logout: "Keluar",
  loading: "Memuatkan…",
  statusFree: "Kosong",
  statusAssigned: "Diberi",
  statusRetired: "Dihentikan",
  errTotp: "Kod itu bukan yang semasa. Guna 6 digit pada pengesah sekarang.",
  errTotpNeed: "Isi kod dahulu.",
  errLocked: "Terlalu banyak kod salah. Tunggu 15 minit.",
  errInUse: "Alamat ini sudah diberi kepada pelanggan dan tidak boleh dipadam.",
  errDup: "Alamat ini sudah disimpan.",
  errBad: "Alamat tidak sah.",
  errMissing: "Tidak dijumpai.",
  errGeneric: "Tidak berjaya. Cuba lagi.",
  loginKicker: "Alamat",
  loginTitle: "Alamat deposit sahaja",
  loginLede: "Log masuk dengan akaun pemilik. Setiap tambah, ganti, atau padam perlukan kod pengesah yang baharu. Admin utama hanya boleh lihat.",
  loginHeading: "Log masuk pemilik",
  password: "Kata laluan",
  signIn: "Log masuk",
  doneThreshold: "Peringatan disimpan",
  doneCsv: "Baris jadual diproses",
  doneRetire: "Alamat dihentikan. Pelanggan akan dimaklumkan.",
  doneAssign: "Diberi kepada pelanggan itu",
};

export const poolCopy: Record<Lang, PoolCopy> = { zh, en, ms };

export function fill(template: string, n: number): string {
  return template.replace("{n}", String(n));
}
