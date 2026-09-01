export const config = {
  port: process.env.PORT || 3001,
  node_id: process.env.NODE_ID || 'contacthi-node-local',
  cosmos_rpc: process.env.COSMOS_RPC || 'https://rpc.cosmos.directory/cosmoshub',
  registry_contract: process.env.REGISTRY_CONTRACT || '',
  // CHI is consent-first: with no registry contract there is nothing to enforce
  // against, and every permission check trivially grants. Running that way is a
  // deliberate act, not a default — see `assertConsentPosture` in index.ts.
  allow_no_registry: process.env.CHI_ALLOW_NO_REGISTRY === 'true',
  spacetimedb_url: process.env.SPACETIMEDB_URL || 'http://localhost:3000',
  spacetimedb_db: process.env.SPACETIMEDB_DB || 'contacthi',
  nullcone_url: process.env.NULLCONE_URL || 'https://nullcone.example.com',
  // Delivery channel configs
  fcm_key: process.env.FCM_KEY || '',
  twilio_sid: process.env.TWILIO_ACCOUNT_SID || '',
  twilio_token: process.env.TWILIO_AUTH_TOKEN || '',
  twilio_from: process.env.TWILIO_FROM || '',
  smtp_host: process.env.SMTP_HOST || '',
  smtp_user: process.env.SMTP_USER || '',
  smtp_pass: process.env.SMTP_PASS || '',
} as const;
