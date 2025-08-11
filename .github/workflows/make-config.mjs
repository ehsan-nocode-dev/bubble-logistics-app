import fs from "fs";

const cfg = {
  baseUrl: process.env.BUBBLE_BASE_URL || "https://logistics-app-10761.bubbleapps.io",
  env: process.env.BUBBLE_ENV || "dev",                       // "dev" or "live"
  apiToken: process.env.BUBBLE_API_TOKEN,                     // from GitHub Secret
  batchSize: Number(process.env.BATCH_SIZE || 5),
  throttleMs: Number(process.env.THROTTLE_MS || 100),
  retry: { retries: 3, backoffMs: 500 },
  types: [
    {
      name: "User",
      endpoint: "/api/1.1/obj/User",
      count: Number(process.env.ADMIN_COUNT || 1),
      fields: {
        "User Role": "Admin",
        "email": "{{faker.internet.email}}",
        "Slug": "{{faker.internet.userName}}",
        "is_seed": true
      }
    },
    {
      name: "User",
      endpoint: "/api/1.1/obj/User",
      count: Number(process.env.CUSTOMER_COUNT || 9),
      fields: {
        "User Role": "Customer",
        "email": "{{faker.internet.email}}",
        "Slug": "{{faker.internet.userName}}",
        "is_seed": true
      }
    },
    {
      name: "User",
      endpoint: "/api/1.1/obj/User",
      count: Number(process.env.PROVIDER_COUNT || 10),
      fields: {
        "User Role": "Service Provider",
        "email": "{{faker.internet.email}}",
        "Slug": "{{faker.internet.userName}}",
        "is_seed": true
      }
    }
  ]
};

if (!cfg.apiToken) {
  console.error("Missing BUBBLE_API_TOKEN env var.");
  process.exit(1);
}

fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2));
console.log("config.json written:");
console.log(JSON.stringify(cfg, null, 2));
