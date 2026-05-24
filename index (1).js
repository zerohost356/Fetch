const express = require("express");
const axios = require("axios");

function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fixEmailContent(email) {
  if (!email.content && email.html_content) {
    email.content = htmlToText(email.html_content);
  }
  if (email.content) {
    email.content = email.content
      .replace(/\r\n/g, " ")
      .replace(/\r/g, " ")
      .replace(/\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return email;
}

const app = express();
const PORT = 5000;

const BASE = "https://mail.chatgpt.org.uk";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let session = {
  sid: "",
  token: "",
  email: "",
  expiresAt: 0,
};

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function isTokenValid() {
  return session.sid && session.token && session.expiresAt - nowUnix() > 60;
}

async function getSession() {
  const res = await axios.get(BASE + "/", {
    headers: { "User-Agent": UA },
    maxRedirects: 5,
    timeout: 15000,
  });
  const setCookie = res.headers["set-cookie"] || [];
  let sid = "";
  for (const c of setCookie) {
    const m = c.match(/gm_sid=([^;]+)/);
    if (m) { sid = m[1]; break; }
  }
  if (!sid) throw new Error("Could not get session cookie from upstream site");
  return sid;
}

async function getToken(sid, email) {
  const res = await axios.post(
    BASE + "/api/inbox-token",
    email ? { email } : {},
    {
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Referer: BASE + "/",
        Origin: BASE,
        Cookie: `gm_sid=${sid}`,
      },
      timeout: 15000,
    }
  );
  const data = res.data;
  if (!data.success || !data.auth) {
    throw new Error("Failed to get inbox token: " + JSON.stringify(data));
  }
  return {
    token: data.auth.token,
    email: data.auth.email || email || "",
    expiresAt: data.auth.expires_at || 0,
  };
}

async function ensureAuth(email) {
  if (email && session.email !== email) {
    if (!session.sid) session.sid = await getSession();
    const auth = await getToken(session.sid, email);
    return { sid: session.sid, ...auth };
  }
  if (!isTokenValid()) {
    session.sid = await getSession();
    const auth = await getToken(session.sid, session.email || undefined);
    session = { sid: session.sid, ...auth };
  }
  return session;
}

function extractToken(responseData) {
  if (responseData && responseData.auth && responseData.auth.token) {
    session.token = responseData.auth.token;
    session.email = responseData.auth.email || session.email;
    session.expiresAt = responseData.auth.expires_at || session.expiresAt;
  }
}

async function callUpstream(url, params, sid, token) {
  const res = await axios.get(url, {
    headers: {
      "User-Agent": UA,
      Referer: BASE + "/",
      Origin: BASE,
      "X-Inbox-Token": token,
      Cookie: `gm_sid=${sid}`,
    },
    params,
    timeout: 15000,
  });
  return res;
}

async function callUpstreamPost(url, body, sid, token) {
  const res = await axios.post(url, body, {
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Referer: BASE + "/",
      Origin: BASE,
      "X-Inbox-Token": token,
      Cookie: `gm_sid=${sid}`,
    },
    timeout: 15000,
  });
  return res;
}

app.set("json escape", false);
app.use(express.json());

app.use((req, res, next) => {
  res.json = (data) => {
    const raw = JSON.stringify(data, null, 2).replace(/\\u[\da-fA-F]{4}/g, (m) =>
      String.fromCharCode(parseInt(m.slice(2), 16))
    );
    res.set("Content-Type", "application/json; charset=utf-8");
    return res.send(raw);
  };
  next();
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    endpoints: {
      generate_email: "GET /api/generator-email",
      custom_email: "GET /api/generator-email/custom?username=<name>&domain=<domain>",
      read_inbox: "GET /api/email?inbox=<your_email>",
      list_domains: "GET /api/domains",
    },
  });
});

app.get("/api/generator-email", async (req, res) => {
  try {
    const auth = await ensureAuth();
    const upstream = await callUpstream(
      BASE + "/api/generate-email",
      undefined,
      auth.sid,
      auth.token
    );
    extractToken(upstream.data);
    return res.status(200).json(upstream.data);
  } catch (err) {
    console.error("generate-email error:", err.message);
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    return res.status(status).json(data);
  }
});

app.get("/api/generator-email/custom", async (req, res) => {
  const { username, domain } = req.query;
  if (!username || !domain) {
    return res.status(400).json({
      success: false,
      error: "Missing required query params: username and domain",
      example: "/api/generator-email/custom?username=bucujjj&domain=inmune.ddns.net",
    });
  }
  try {
    const auth = await ensureAuth();
    const upstream = await callUpstreamPost(
      BASE + "/api/generate-email",
      { prefix: username, domain: domain },
      auth.sid,
      auth.token
    );
    extractToken(upstream.data);
    return res.status(200).json(upstream.data);
  } catch (err) {
    console.error("custom email error:", err.message);
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    return res.status(status).json(data);
  }
});

app.get("/api/domains", async (req, res) => {
  try {
    const auth = await ensureAuth();
    const upstream = await callUpstream(
      BASE + "/api/domains/status",
      undefined,
      auth.sid,
      auth.token
    );
    extractToken(upstream.data);
    return res.status(200).json(upstream.data);
  } catch (err) {
    console.error("domains error:", err.message);
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    return res.status(status).json(data);
  }
});

app.get("/api/email", async (req, res) => {
  const inbox = req.query.inbox;
  if (!inbox) {
    return res
      .status(400)
      .json({ success: false, error: "Missing required query param: inbox" });
  }
  const limited = req.query.limited ? parseInt(req.query.limited, 10) : null;
  try {
    const auth = await ensureAuth(inbox);
    const upstream = await callUpstream(
      BASE + "/api/emails",
      { email: inbox },
      auth.sid,
      auth.token
    );
    extractToken(upstream.data);
    const body = upstream.data;
    if (body.data && Array.isArray(body.data.emails)) {
      body.data.emails = body.data.emails.map(fixEmailContent).map((email) => {
        const { html_content, ...rest } = email;
        return rest;
      });
      if (limited && Number.isFinite(limited) && limited > 0) {
        body.data.emails = body.data.emails.slice(0, limited);
      }
      body.data.count = body.data.emails.length;
    }
    return res.status(200).json(body);
  } catch (err) {
    console.error("email inbox error:", err.message);
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    return res.status(status).json(data);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`  GET /api/generator-email`);
  console.log(`  GET /api/email?inbox=<your_email>`);
  console.log(`  GET /api/domains`);
});
