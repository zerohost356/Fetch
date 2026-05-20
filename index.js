const axios = require("axios");
const fs    = require("fs-extra");
const path  = require("path");

const ACCOUNTS_FILE    = path.join(__dirname, "accounts.json");
const DISCORD_API      = "https://discord.com/api/v9";
const CYBERTEMP_API    = "https://api.cybertemp.xyz";
const CYBERTEMP_KEY    = "tk_c778bd5ad07ce105b35626a03856352e428b314752ce521d70b598ef640369a2";
const FIXED_DOMAIN     = "picturehostel.org";
const NOPECHA_API      = "https://api.nopecha.com";
const NOPECHA_KEY      = "qz700n8v7gn4iadh";
const DISCORD_SITEKEY  = "f5561ba9-8f1e-40ca-9b5b-a0b3f719ef34";
const DISCORD_REG_URL  = "https://discord.com/register";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(tag, msg) {
  const t = new Date().toLocaleTimeString("vi-VN");
  console.log(`[${t}] [${tag}] ${msg}`);
}

// Password format: Tc4OTc0MzQ4MjM0MzU4$
// = base64(random 13-digit number) stripped padding + "$"
function genPassword() {
  const digits = String(Math.floor(Math.random() * 9e12 + 1e12));
  const b64    = Buffer.from(digits).toString("base64").replace(/=/g, "");
  return b64 + "$";
}

// Username: random alphanumeric 8–16 chars, starts with letter
function genUsername() {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const chars   = "abcdefghijklmnopqrstuvwxyz0123456789_";
  const len     = Math.floor(Math.random() * 9) + 8;
  let name      = letters[Math.floor(Math.random() * letters.length)];
  for (let i = 1; i < len; i++) name += chars[Math.floor(Math.random() * chars.length)];
  return name;
}

function genDOB() {
  const y = Math.floor(Math.random() * 15) + 1990;
  const m = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const d = String(Math.floor(Math.random() * 28) + 1).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function extractOTP(text) {
  const clean = (text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
  const m = clean.match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

// ─── Nopecha — hCaptcha Solver ────────────────────────────────────────────────

async function nopechaSolve(sitekey, url, extraData = {}) {
  log("CAPTCHA", `Gửi yêu cầu giải hCaptcha (Nopecha)...`);

  const body = {
    type:    "hcaptcha",
    sitekey,
    url,
    key:     NOPECHA_KEY,
    ...extraData,
  };

  const submitRes = await axios.post(NOPECHA_API, body);
  const jobId = submitRes.data?.data;
  if (!jobId) throw new Error(`Nopecha submit lỗi: ${JSON.stringify(submitRes.data)}`);
  log("CAPTCHA", `Job ID: ${jobId} — đang chờ giải...`);

  // Poll cho đến khi có kết quả (tối đa 3 phút)
  const start = Date.now();
  while (Date.now() - start < 180000) {
    await sleep(6000);
    try {
      const pollRes = await axios.get(NOPECHA_API, {
        params: { type: "hcaptcha", id: jobId, key: NOPECHA_KEY },
      });
      const d = pollRes.data;

      if (d.error === 0 && d.data) {
        const token = Array.isArray(d.data) ? d.data[0] : d.data;
        if (token && token.length > 10) {
          log("CAPTCHA", `Giải thành công! Token: ${token.slice(0, 30)}...`);
          return token;
        }
      }
      // error 9 = still processing, continue polling
      if (d.error !== 9 && d.error !== 0) {
        throw new Error(`Nopecha lỗi code ${d.error}: ${JSON.stringify(d)}`);
      }
      log("CAPTCHA", `Đang xử lý... (${Math.round((Date.now()-start)/1000)}s)`);
    } catch (e) {
      if (e.message.includes("Nopecha lỗi")) throw e;
      log("CAPTCHA", `Poll lỗi: ${e.message}`);
    }
  }
  throw new Error("Timeout giải captcha (3 phút)");
}

// ─── CyberTemp API ────────────────────────────────────────────────────────────

function generateMail() {
  const rand = Math.floor(Math.random() * 900000000 + 100000000);
  const mail = `user${rand}@${FIXED_DOMAIN}`;
  log("MAIL", `Email tạm: ${mail}`);
  return mail;
}

async function getMails(mail) {
  const res = await axios.get(`${CYBERTEMP_API}/getMail`, {
    params:  { email: mail, limit: 50 },
    headers: { "X-API-KEY": CYBERTEMP_KEY },
  });
  return res.data;
}

async function waitForOTP(mail, timeoutMs = 180000) {
  log("MAIL", "Đang chờ email xác nhận Discord (tối đa 3 phút)...");
  const start = Date.now();
  const seen  = new Set();

  while (Date.now() - start < timeoutMs) {
    await sleep(5000);
    try {
      const data = await getMails(mail);
      const msgs = Array.isArray(data) ? data : (data.messages || data.data || data.mails || []);

      for (const msg of msgs) {
        const id = msg.id || msg._id || msg.subject || JSON.stringify(msg).slice(0, 40);
        if (seen.has(id)) continue;
        seen.add(id);

        const body = msg.body || msg.text || msg.html || msg.content || JSON.stringify(msg);
        const otp  = extractOTP(body);
        if (otp) {
          log("MAIL", `OTP / mã xác nhận: ${otp}`);
          return otp;
        }
        log("MAIL", `Mail mới nhưng không có OTP (subject: ${msg.subject || "?"})`);
      }
      log("MAIL", `Chưa có mail... (${Math.round((Date.now()-start)/1000)}s)`);
    } catch (e) {
      log("MAIL", `Poll lỗi: ${e.message}`);
    }
  }
  throw new Error("Timeout chờ OTP Discord (3 phút)");
}

// ─── Discord API ──────────────────────────────────────────────────────────────

const DISCORD_HEADERS = {
  "Content-Type":    "application/json",
  "Accept":          "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Origin":          "https://discord.com",
  "Referer":         "https://discord.com/register",
  "X-Super-Properties": Buffer.from(JSON.stringify({
    os: "Windows", browser: "Chrome", device: "",
    system_locale: "en-US",
    browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    browser_version: "124.0.0.0",
    os_version: "10",
    referrer: "",
    referring_domain: "",
    referrer_current: "",
    referring_domain_current: "",
    release_channel: "stable",
    client_build_number: 285609,
    client_event_source: null,
  })).toString("base64"),
  "X-Discord-Locale":   "en-US",
  "X-Discord-Timezone": "Asia/Ho_Chi_Minh",
};

// Đăng ký — tự động xử lý captcha nếu Discord yêu cầu
async function discordRegister(email, username, password, dob) {
  const baseBody = {
    email,
    username,
    password,
    date_of_birth:              dob,
    consent:                    true,
    gift_code_sku_id:           null,
    promotional_email_opt_in:   false,
  };

  log("DISCORD", `Đăng ký: ${email} / ${username}`);

  let body = { ...baseBody };

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await axios.post(`${DISCORD_API}/auth/register`, body, { headers: DISCORD_HEADERS });
      log("DISCORD", `register OK → status=${r.status}`);
      return r.data;
    } catch (e) {
      const resp   = e?.response?.data;
      const status = e?.response?.status;

      // Captcha yêu cầu
      if (status === 400 && resp?.captcha_key?.includes("captcha-required")) {
        const sitekey  = resp.captcha_sitekey  || DISCORD_SITEKEY;
        const rqdata   = resp.captcha_rqdata   || undefined;
        const rqtoken  = resp.captcha_rqtoken  || undefined;
        log("DISCORD", `Captcha yêu cầu! sitekey=${sitekey}`);

        const extra = {};
        if (rqdata)  extra.data    = rqdata;
        if (rqtoken) extra.rqtoken = rqtoken;

        const captchaToken = await nopechaSolve(sitekey, DISCORD_REG_URL, extra);
        body = { ...baseBody, captcha_key: captchaToken };
        log("DISCORD", `Thử lại với captcha (lần ${attempt})...`);
        continue;
      }

      // Rate limit — ném ra ngoài để main xử lý retry
      throw e;
    }
  }
  throw new Error("Vượt captcha thất bại sau 4 lần");
}

async function discordVerifyEmail(token, otp) {
  const r = await axios.post(
    `${DISCORD_API}/auth/verify`,
    { token: otp },
    { headers: { ...DISCORD_HEADERS, Authorization: token } }
  );
  log("DISCORD", `verify → status=${r.status}`);
  return r.data;
}

// Login xác nhận sau khi đăng ký thành công
async function discordLogin(email, password) {
  log("LOGIN", `Đăng nhập: ${email}`);
  const body = {
    login:             email,
    password,
    undelete:          false,
    captcha_key:       null,
    login_source:      null,
    gift_code_sku_id:  null,
  };

  for (let i = 1; i <= 5; i++) {
    try {
      const r = await axios.post(`${DISCORD_API}/auth/login`, body, { headers: DISCORD_HEADERS });
      log("LOGIN", `Đăng nhập thành công (lần ${i}) → status=${r.status}`);
      return r.data;
    } catch (e) {
      const resp   = e?.response?.data;
      const status = e?.response?.status;

      // Captcha khi login
      if (status === 400 && resp?.captcha_key?.includes("captcha-required")) {
        const sitekey = resp.captcha_sitekey || DISCORD_SITEKEY;
        log("LOGIN", `Captcha yêu cầu khi login, giải Nopecha...`);
        const extra = {};
        if (resp.captcha_rqdata)  extra.data    = resp.captcha_rqdata;
        if (resp.captcha_rqtoken) extra.rqtoken = resp.captcha_rqtoken;
        const captchaToken = await nopechaSolve(sitekey, DISCORD_REG_URL, extra);
        body.captcha_key = captchaToken;
        continue;
      }

      // Rate limit
      if (status === 429) {
        const wait = (resp?.retry_after ? Math.ceil(resp.retry_after) + 3 : 15) * 1000;
        log("LOGIN", `Rate limit, chờ ${wait/1000}s...`);
        await sleep(wait);
        continue;
      }

      log("LOGIN", `Lỗi login lần ${i}: ${JSON.stringify(resp) || e.message}`);
      if (i < 5) await sleep(3000);
    }
  }
  throw new Error("Login thất bại sau 5 lần");
}

// ─── Lưu kết quả ─────────────────────────────────────────────────────────────

async function saveAccount(entry) {
  let list = [];
  if (fs.existsSync(ACCOUNTS_FILE))
    list = fs.readJsonSync(ACCOUNTS_FILE, { throws: false }) || [];
  list.push(entry);
  fs.writeJsonSync(ACCOUNTS_FILE, list, { spaces: 2 });
  log("SAVE", `Lưu accounts.json (tổng: ${list.length} tài khoản)`);
}

// ─── Một lần thử ─────────────────────────────────────────────────────────────

async function tryOnce(attempt) {
  log("TRY", "─".repeat(52));
  log("TRY", `Lần thử #${attempt} — discord.com`);
  log("TRY", "─".repeat(52));

  // 1. Sinh thông tin
  const email    = generateMail();
  const username = genUsername();
  const password = genPassword();
  const dob      = genDOB();

  log("GEN", `Username : ${username}`);
  log("GEN", `Password : ${password}`);
  log("GEN", `DOB      : ${dob}`);

  // 2. Đăng ký Discord (có captcha bypass)
  let regData;
  try {
    regData = await discordRegister(email, username, password, dob);
  } catch (e) {
    const resp = e?.response?.data;
    if (resp) log("DISCORD", `Lỗi register: ${JSON.stringify(resp)}`);
    throw e;
  }

  log("DISCORD", `regData: ${JSON.stringify(regData)}`);

  const discordToken = regData.token;
  if (!discordToken) throw new Error(`Đăng ký không trả về token: ${JSON.stringify(regData)}`);
  log("DISCORD", `Token đăng ký: ${discordToken.slice(0, 20)}...`);

  // 3. Chờ OTP xác nhận email
  const otp = await waitForOTP(email);

  // 4. Xác nhận email
  let verifyData = {};
  try {
    verifyData = await discordVerifyEmail(discordToken, otp);
    log("DISCORD", `Xác nhận email thành công`);
  } catch (e) {
    log("DISCORD", `Xác nhận lỗi (vẫn tiếp tục): ${e?.response?.data ? JSON.stringify(e.response.data) : e.message}`);
  }

  // 5. Login xác nhận tài khoản
  log("LOGIN", "Đăng nhập xác nhận tài khoản...");
  const loginData = await discordLogin(email, password);
  const finalToken = loginData?.token || verifyData.token || discordToken;
  log("LOGIN", `Token login: ${finalToken.slice(0, 20)}...`);

  return { email, username, password, dob, token: finalToken, regData, verifyData, loginData };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(60));
  console.log("  Discord — Auto Register");
  console.log("  TempMail : cybertemp.xyz | Domain: picturehostel.org");
  console.log("  Captcha  : Nopecha hCaptcha bypass (Free)");
  console.log("  Loop vô hạn đến khi THÀNH CÔNG thì dừng");
  console.log("═".repeat(60));
  console.log();

  // Ví dụ format password:
  log("GEN", `Ví dụ password: ${genPassword()}`);
  log("GEN", `Ví dụ username: ${genUsername()}`);
  console.log();

  let attempt = 0;

  while (true) {
    attempt++;
    try {
      const result = await tryOnce(attempt);

      const entry = {
        createdAt:  new Date().toISOString(),
        email:      result.email,
        username:   result.username,
        password:   result.password,
        dob:        result.dob,
        token:      result.token,
        regData:    result.regData,
        verifyData: result.verifyData,
        loginData:  result.loginData,
      };

      await saveAccount(entry);

      console.log();
      console.log("═".repeat(60));
      console.log("  DANG KY + DANG NHAP DISCORD THANH CONG!");
      console.log("═".repeat(60));
      console.log(`  Email    : ${result.email}`);
      console.log(`  Username : ${result.username}`);
      console.log(`  Password : ${result.password}`);
      console.log(`  DOB      : ${result.dob}`);
      console.log(`  Token    : ${result.token ?? "(xem accounts.json)"}`);
      console.log(`  Saved to : accounts.json`);
      console.log("═".repeat(60));
      process.exit(0);

    } catch (err) {
      const resp        = err?.response?.data;
      const status      = err?.response?.status;
      const retryAfterS = resp?.retry_after ? Math.ceil(resp.retry_after) + 5 : null;
      const delay       = status === 429
        ? (retryAfterS ? retryAfterS * 1000 : 60000)
        : status >= 500 ? 10000 : 5000;

      log("RETRY", `Lần #${attempt} thất bại: ${err.message}`);
      if (resp) log("RETRY", `Response: ${JSON.stringify(resp)}`);
      log("RETRY", `Thử lại sau ${delay / 1000}s...`);
      console.log();
      await sleep(delay);
    }
  }
}

main();
