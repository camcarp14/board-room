// ─── Shared Netlify function response helper ───────────────────────────────
// Formalizes the response shape already used by hand in every Clarify
// Outreach function ({ statusCode, headers, body: JSON.stringify(...) },
// with { error: "message" } on failures). No new conventions — just removes
// the need to retype the boilerplate in every function.
//
// Drop this in as netlify/functions/_shared/response.js, then:
//
//   const { json, error, methodGuard } = require("./_shared/response");
//
//   exports.handler = async (event) => {
//     const guard = methodGuard(event, "POST");
//     if (guard) return guard;
//     try {
//       const body = JSON.parse(event.body || "{}");
//       return json(200, { result: "..." });
//     } catch (err) {
//       return error(500, err.message);
//     }
//   };

function json(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}

function error(statusCode, message) {
  return json(statusCode, { error: message });
}

function methodGuard(event, allowedMethod) {
  if (event.httpMethod !== allowedMethod) {
    return { statusCode: 405, body: "Method not allowed" };
  }
  return null;
}

module.exports = { json, error, methodGuard };
