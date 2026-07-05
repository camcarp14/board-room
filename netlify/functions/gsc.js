// Google Search Console → last N days for zerotosecure.com, shaped for the
// Morning Brief card. Zero dependencies — signs the service-account JWT with
// node:crypto.
// Needs: GSC_CLIENT_EMAIL and GSC_PRIVATE_KEY (from a service account JSON;
// store the key with literal \n sequences, this file converts them back —
// and defensively cleans up the other common paste-mangling issues too,
// since "re-paste it perfectly" has proven fragile in practice).
// The service account email must be added as a user on the Search Console
// property (sc-domain:zerotosecure.com or the URL-prefix property).
const crypto = require("crypto");
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Cleans up the ways a PEM key commonly gets mangled when copy-pasted
// through a JSON file → terminal → browser text field round trip:
// surrounding quotes accidentally included, literal \n vs real newlines,
// Windows CRLF, stray leading/trailing whitespace.
function normalizePrivateKey(raw) {
  let key = (raw || "").trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1).trim();
  key = key.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return key.trim() + "\n";
}
// Checks the key at least LOOKS like valid PEM before handing it to
// node:crypto — a shape mismatch here is what produces the cryptic
// "error:1E08010C:DECODER routines::unsupported" with no useful detail.
function pemShapeError(key) {
  const hasBegin = /-----BEGIN (RSA )?PRIVATE KEY-----/.test(key);
  const hasEnd = /-----END (RSA )?PRIVATE KEY-----/.test(key);
  if (!hasBegin || !hasEnd) {
    // Show exactly what's there instead of guessing again — this is just
    // the PEM header/footer wrapper text, never the sensitive key body,
    // so it's safe to surface. Char codes catch invisible/look-alike
    // characters (e.g. an em-dash swapped in for a hyphen by autocorrect
    // somewhere in the copy-paste chain) that look identical when printed.
    const head = key.slice(0, 40);
    const headCodes = [...head.slice(0, 10)].map(c => c.codePointAt(0).toString(16).padStart(4, "0")).join(" ");
    const tail = key.slice(-40).trim();
    return `GSC_PRIVATE_KEY doesn't look like a valid PEM key after cleanup (missing ${!hasBegin ? "the BEGIN" : "the END"} marker; length after cleanup: ${key.length} chars — plausible for a real key). First 40 chars as stored: "${head}" (unicode code points of the first 10: ${headCodes} — a plain hyphen is 002d; anything else there, like 2013 or 2014, means a dash got swapped by autocorrect somewhere in the copy chain). Last 40 chars: "${tail}".`;
  }
  const bodyLines = key.split("\n").filter(l => l && !l.startsWith("-----"));
  if (bodyLines.length < 10) {
    return `GSC_PRIVATE_KEY has the right BEGIN/END markers but only ${bodyLines.length} content line(s) — that's too short for a real key, likely truncated during paste. Re-copy the full "private_key" value.`;
  }
  return null;
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function getAccessToken(email, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  let sig;
  try {
    sig = b64url(signer.sign(privateKey));
  } catch (e) {
    throw new Error(`the key has valid PEM markers but node:crypto couldn't use it to sign (${e.message}) — it may be corrupted, the wrong key type, or need to be regenerated from Google Cloud (IAM & Admin → Service Accounts → your account → Keys → Add Key)`);
  }
  const jwt = `${header}.${claims}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(data.error_description || "token exchange failed");
  return data.access_token;
}

const fmtDate = (d) => d.toISOString().slice(0, 10);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const email = process.env.GSC_CLIENT_EMAIL;
  const rawKey = process.env.GSC_PRIVATE_KEY;
  const configured = !!(email && rawKey);

  if (body.ping) return json(200, { success: true, service: "gsc", configured, missing: configured ? undefined : "GSC_CLIENT_EMAIL / GSC_PRIVATE_KEY" });
  if (!configured) return json(500, { error: "GSC env vars not set" });

  const privateKey = normalizePrivateKey(rawKey);
  const shapeError = pemShapeError(privateKey);
  if (shapeError) return json(500, { error: shapeError });

  const site = process.env.GSC_SITE_URL || `sc-domain:${(body.site || "zerotosecure.com").replace(/^https?:\/\//, "")}`;
  const days = Math.min(body.days || 14, 90);

  try {
    const token = await getAccessToken(email, privateKey);
    const query = async (startDaysAgo, endDaysAgo, byDate) => {
      const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: fmtDate(new Date(Date.now() - startDaysAgo * 86400000)),
          endDate: fmtDate(new Date(Date.now() - endDaysAgo * 86400000)),
          dimensions: byDate ? ["date"] : [],
          rowLimit: 100,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return data.rows || [];
    };

    // GSC data lags ~2 days; shift both windows back accordingly.
    const [curRows, prevRow, curDaily] = await Promise.all([
      query(days + 2, 2, false),
      query(2 * days + 2, days + 2, false),
      query(days + 2, 2, true),
    ]);
    const cur = curRows[0] || { impressions: 0, clicks: 0, position: 0 };
    const prev = prevRow[0] || { impressions: 0, clicks: 0, position: 0 };

    const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(Math.round(n));
    const pct = (a, b) => b ? `${a >= b ? "▲" : "▼"} ${Math.abs(Math.round(((a - b) / b) * 100))}%` : "";

    return json(200, {
      success: true,
      impressions: fmtK(cur.impressions), impressionsD: pct(cur.impressions, prev.impressions),
      clicks: fmtK(cur.clicks), clicksD: pct(cur.clicks, prev.clicks),
      pos: cur.position ? cur.position.toFixed(1) : "—",
      posD: prev.position ? `${cur.position <= prev.position ? "▲" : "▼"} from ${prev.position.toFixed(1)}` : "",
      series: curDaily.map(r => r.impressions),
      daily: curDaily.map(r => ({
        date: r.keys[0],
        impressions: r.impressions,
        clicks: r.clicks,
        position: r.position,
      })),
      note: `${fmtK(cur.clicks)} clicks on ${fmtK(cur.impressions)} impressions (last ${days}d, 2-day data lag).`,
    });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
