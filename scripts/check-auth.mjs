import "dotenv/config";
import { baseConfig } from "../src/config.mjs";

const domain =
  typeof baseConfig.domain === "string"
    ? baseConfig.domain
    : "https://open.larksuite.com";

const url = `${domain.replace(/\/$/, "")}/open-apis/auth/v3/app_access_token/internal`;

const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json; charset=utf-8",
  },
  body: JSON.stringify({
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  }),
});

const data = await response.json();

if (!response.ok || data.code !== 0) {
  console.error("Auth check failed:", JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      app_id: process.env.LARK_APP_ID,
      expire: data.expire,
      tenant_access_token_prefix: String(data.tenant_access_token || "").slice(0, 12),
    },
    null,
    2,
  ),
);
