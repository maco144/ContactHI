use cosmwasm_schema::cw_serde;
use cosmwasm_std::Addr;
use cw_storage_plus::Map;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// Entity Identity type codes from the Entity Identity specification.
#[cw_serde]
pub enum EntityType {
    /// Conversational Agent
    CA,
    /// Language Model
    LM,
    /// Generative Model
    GN,
    /// Autonomous Agent
    AA,
    /// Robot
    RB,
    /// Drone
    DR,
    /// Vehicle
    VH,
    /// Human User
    US,
    /// Copilot
    CP,
    /// Hive / Swarm
    HS,
    /// Wildcard — matches any entity type
    Any,
}

/// Intent codes for the message being sent.
#[cw_serde]
pub enum Intent {
    /// Informational — no action required
    Inform,
    /// Data collection request
    Collect,
    /// Authorization request
    Authorize,
    /// Escalation / alert
    Escalate,
    /// Result / response delivery
    Result,
    /// Wildcard — matches any intent
    Any,
}

/// Delivery channels that a rule may permit.
#[cw_serde]
pub enum Channel {
    Push,
    Sms,
    Email,
    Webhook,
    InApp,
    AgentInbox,
}

/// Whether unmatched requests default to allowed or blocked.
#[cw_serde]
pub enum DefaultPolicy {
    /// Deny anything not explicitly permitted (opt-in model, recommended default).
    Block,
    /// Allow anything not explicitly denied (opt-out model).
    Allow,
}

// ---------------------------------------------------------------------------
// Sub-structures
// ---------------------------------------------------------------------------

/// Per-period rate limit.
#[cw_serde]
pub struct RateLimit {
    /// Maximum number of messages permitted within `period_seconds`.
    pub count: u32,
    /// Rolling window size in seconds (e.g. 86400 for one day).
    pub period_seconds: u64,
}

/// Allowed contact time window in UTC.
#[cw_serde]
pub struct TimeWindow {
    /// UTC hour for window open (0–23).
    pub start_hour: u8,
    /// UTC minute for window open (0–59).
    pub start_minute: u8,
    /// UTC hour for window close (0–23).
    pub end_hour: u8,
    /// UTC minute for window close (0–59).
    pub end_minute: u8,
}

/// A single preference rule matching a sender-type + intent combination.
#[cw_serde]
pub struct PreferenceRule {
    /// Which sender type this rule applies to (`Any` = wildcard).
    pub sender_type: EntityType,
    /// Which intent this rule applies to (`Any` = wildcard).
    pub intent: Intent,
    /// Channels permitted when this rule matches.
    pub allowed_channels: Vec<Channel>,
    /// Optional per-rule rate limit.
    pub rate_limit: Option<RateLimit>,
    /// Optional time-of-day restriction (UTC).
    pub time_window: Option<TimeWindow>,
    /// DID or domain patterns that are denied even if the rule would otherwise match.
    pub blocklist: Vec<String>,
}

// ---------------------------------------------------------------------------
// Top-level profile
// ---------------------------------------------------------------------------

/// A human's full contact preference profile.
#[cw_serde]
pub struct HumanPreference {
    /// The owner's verified address; only they may modify this profile.
    pub owner: Addr,
    /// Ordered list of preference rules. Evaluated with specificity priority.
    pub rules: Vec<PreferenceRule>,
    /// Policy applied when no rule matches.
    pub default_policy: DefaultPolicy,
    /// Delivery URL used for the `Webhook` channel.
    pub webhook_url: Option<String>,
    /// Block timestamp (seconds) of the last update.
    pub updated_at: u64,
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/// Primary preference registry: owner address -> HumanPreference.
pub const PREFERENCES: Map<&Addr, HumanPreference> = Map::new("preferences");

/// Global per-owner blocklist: (owner, pattern) -> true.
/// Key is a composite of the owner address bytes and the raw pattern string.
pub const BLOCKLIST: Map<(&Addr, &str), bool> = Map::new("blocklist");

/// Rate-limit counters: (recipient, sender, period_key) -> message count in window.
/// `period_key` encodes the rolling window start (e.g. "<period_seconds>:<window_start>").
pub const RATE_COUNTS: Map<(&Addr, &Addr, &str), u32> = Map::new("rate_counts");

/// Contract metadata key (stored by cw2).
pub const CONTRACT_NAME: &str = "contacthi-contracts:preference-registry";
pub const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
