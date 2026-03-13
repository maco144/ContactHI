use cosmwasm_schema::{cw_serde, QueryResponses};
use crate::state::{Channel, DefaultPolicy, EntityType, Intent, PreferenceRule};

// ---------------------------------------------------------------------------
// Instantiate
// ---------------------------------------------------------------------------

#[cw_serde]
pub struct InstantiateMsg {
    /// Optional admin address. If omitted, the instantiator becomes admin.
    pub admin: Option<String>,
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

#[cw_serde]
pub enum ExecuteMsg {
    /// Create a new preference profile for the caller. Fails if one already exists.
    RegisterPreferences {
        rules: Vec<PreferenceRule>,
        default_policy: DefaultPolicy,
        /// Must start with "https://" when provided.
        webhook_url: Option<String>,
    },

    /// Replace the caller's entire preference profile (rules + policy + webhook).
    UpdatePreferences {
        rules: Vec<PreferenceRule>,
        default_policy: DefaultPolicy,
        webhook_url: Option<String>,
    },

    /// Append a single rule to the caller's existing profile.
    AddRule { rule: PreferenceRule },

    /// Remove the rule at position `index` from the caller's profile.
    RemoveRule { index: u32 },

    /// Add a DID or domain pattern to the caller's global blocklist.
    BlockSender { pattern: String },

    /// Remove a pattern from the caller's global blocklist.
    UnblockSender { pattern: String },

    /// Delete the caller's preference profile entirely.
    DeletePreferences {},
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Return the full preference profile for `address`.
    #[returns(PreferencesResponse)]
    GetPreferences { address: String },

    /// Check whether `sender_did` may contact `recipient` with the given intent.
    #[returns(PermissionResponse)]
    CheckPermission {
        /// The DID (or address) of the entity attempting to send.
        sender_did: String,
        /// The entity type code of the sender.
        sender_type: EntityType,
        /// The recipient's bech32 address.
        recipient: String,
        /// The intent of the message.
        intent: Intent,
    },

    /// Check whether `sender_pattern` matches any blocked entry for `recipient`.
    #[returns(IsBlockedResponse)]
    IsBlocked {
        sender_pattern: String,
        recipient: String,
    },

    /// Return the list of rules for `address`.
    #[returns(RulesResponse)]
    GetRules { address: String },
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[cw_serde]
pub struct PreferencesResponse {
    pub owner: String,
    pub rules: Vec<PreferenceRule>,
    pub default_policy: DefaultPolicy,
    pub webhook_url: Option<String>,
    pub updated_at: u64,
}

#[cw_serde]
pub struct PermissionResponse {
    pub allowed: bool,
    pub allowed_channels: Vec<Channel>,
    /// Human-readable reason when denied or rate-limited.
    pub reason: Option<String>,
    /// Remaining calls allowed in the current rate-limit window, if applicable.
    pub rate_limit_remaining: Option<u32>,
}

#[cw_serde]
pub struct IsBlockedResponse {
    pub blocked: bool,
}

#[cw_serde]
pub struct RulesResponse {
    pub rules: Vec<PreferenceRule>,
}
