use spacetimedb::{spacetimedb, ReducerContext};

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

/// Tracks every CHI message through the system.
#[spacetimedb::table(name = messages, public)]
pub struct Message {
    #[primary_key]
    pub message_id: String,
    pub sender_did: String,
    /// EntityType code (e.g. "human", "agent", "service")
    pub sender_type: String,
    pub recipient_did: String,
    /// CHI intent string (e.g. "message.send", "payment.request")
    pub intent: String,
    /// 0–255; higher is more urgent
    pub priority: u8,
    pub ttl_seconds: u32,
    /// MIME-like payload descriptor (e.g. "text/plain", "application/json")
    pub payload_type: String,
    /// Unix timestamp in milliseconds
    pub created_at: u64,
    /// Unix timestamp in milliseconds
    pub expires_at: u64,
    /// ID of the router node that accepted this message
    pub router_node: String,
}

/// Delivery acknowledgement — one row per message, updated as it progresses.
#[spacetimedb::table(name = acks, public)]
pub struct Ack {
    #[primary_key]
    pub message_id: String,
    /// pending | delivered | read | responded | expired | failed
    pub status: String,
    pub channel_used: Option<String>,
    pub delivered_at: Option<u64>,
    pub read_at: Option<u64>,
    pub responded_at: Option<u64>,
    pub error_code: Option<String>,
    /// Unix timestamp in milliseconds
    pub updated_at: u64,
}

/// Router-side cache of on-chain recipient preferences (TTL-based invalidation).
#[spacetimedb::table(name = preference_cache, public)]
pub struct PreferenceCache {
    #[primary_key]
    pub recipient_did: String,
    /// JSON-serialized Vec<PreferenceRule>
    pub rules_json: String,
    /// "block" | "allow" — applied when no rule matches
    pub default_policy: String,
    /// Unix timestamp in milliseconds
    pub cached_at: u64,
    /// Cache lifetime in seconds; default 300
    pub ttl_seconds: u32,
}

/// Registry of active router nodes in the federation.
#[spacetimedb::table(name = router_nodes, public)]
pub struct RouterNode {
    #[primary_key]
    pub node_id: String,
    pub endpoint_url: String,
    /// Unix timestamp in milliseconds of last heartbeat
    pub last_seen: u64,
    pub messages_routed: u64,
}

// ---------------------------------------------------------------------------
// Helper: current time in milliseconds
// ---------------------------------------------------------------------------

fn now_ms(ctx: &ReducerContext) -> u64 {
    // SpacetimeDB Timestamp is microseconds since epoch; convert to ms.
    let micros: i64 = ctx.timestamp.to_micros_since_unix_epoch();
    (micros / 1_000) as u64
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/// Called by a router node when it accepts a new CHI message.
/// Inserts the message record and creates a pending ack.
#[spacetimedb::reducer]
pub fn submit_message(ctx: &ReducerContext, message: Message) {
    let ts = now_ms(ctx);

    // Reject messages that have already expired.
    if message.expires_at <= ts {
        log::warn!(
            "submit_message: message {} has already expired (expires_at={}, now={})",
            message.message_id,
            message.expires_at,
            ts
        );
        return;
    }

    // Idempotency: if the message already exists, silently ignore.
    if Message::filter_by_message_id(&message.message_id).is_some() {
        log::info!(
            "submit_message: duplicate message_id {}, ignoring",
            message.message_id
        );
        return;
    }

    let message_id = message.message_id.clone();
    let router_node = message.router_node.clone();

    Message::insert(message);

    // Seed the ack row as pending.
    Ack::insert(Ack {
        message_id: message_id.clone(),
        status: "pending".to_string(),
        channel_used: None,
        delivered_at: None,
        read_at: None,
        responded_at: None,
        error_code: None,
        updated_at: ts,
    });

    // Bump the router node's counter.
    if let Some(mut node) = RouterNode::filter_by_node_id(&router_node) {
        node.messages_routed += 1;
        RouterNode::update_by_node_id(&router_node, node);
    }

    log::info!("submit_message: accepted message_id={}", message_id);
}

/// Called by a router node when delivery status changes.
/// Transitions the ack row to the new status and stamps the relevant timestamp.
#[spacetimedb::reducer]
pub fn update_ack(
    ctx: &ReducerContext,
    message_id: String,
    status: String,
    channel_used: Option<String>,
    error_code: Option<String>,
) {
    let ts = now_ms(ctx);

    let Some(mut ack) = Ack::filter_by_message_id(&message_id) else {
        log::warn!("update_ack: unknown message_id={}", message_id);
        return;
    };

    // Validate the requested transition is meaningful.
    let valid_transitions: &[&str] = &[
        "pending", "delivered", "read", "responded", "expired", "failed",
    ];
    if !valid_transitions.contains(&status.as_str()) {
        log::warn!(
            "update_ack: unknown status '{}' for message_id={}",
            status,
            message_id
        );
        return;
    }

    // Stamp the appropriate timestamp based on the new status.
    match status.as_str() {
        "delivered" => {
            ack.delivered_at = Some(ts);
            if let Some(ch) = channel_used {
                ack.channel_used = Some(ch);
            }
        }
        "read" => {
            ack.read_at = Some(ts);
        }
        "responded" => {
            ack.responded_at = Some(ts);
        }
        "failed" | "expired" => {
            ack.error_code = error_code;
        }
        _ => {}
    }

    ack.status = status.clone();
    ack.updated_at = ts;

    Ack::update_by_message_id(&message_id, ack);

    log::info!(
        "update_ack: message_id={} → status={}",
        message_id,
        status
    );
}

/// Called by a router node to cache CosmWasm preference query results.
/// Replaces any existing cache entry for the recipient.
#[spacetimedb::reducer]
pub fn cache_preferences(
    ctx: &ReducerContext,
    recipient_did: String,
    rules_json: String,
    default_policy: String,
    ttl_seconds: u32,
) {
    let ts = now_ms(ctx);

    // Validate default_policy
    if default_policy != "block" && default_policy != "allow" {
        log::warn!(
            "cache_preferences: invalid default_policy '{}' for {}",
            default_policy,
            recipient_did
        );
        return;
    }

    let entry = PreferenceCache {
        recipient_did: recipient_did.clone(),
        rules_json,
        default_policy,
        cached_at: ts,
        ttl_seconds,
    };

    if PreferenceCache::filter_by_recipient_did(&recipient_did).is_some() {
        PreferenceCache::update_by_recipient_did(&recipient_did, entry);
    } else {
        PreferenceCache::insert(entry);
    }

    log::info!("cache_preferences: cached preferences for {}", recipient_did);
}

/// Called by a router node to register itself or send a heartbeat.
/// Creates the node row on first call, updates last_seen on subsequent calls.
#[spacetimedb::reducer]
pub fn register_node(ctx: &ReducerContext, node_id: String, endpoint_url: String) {
    let ts = now_ms(ctx);

    if let Some(mut node) = RouterNode::filter_by_node_id(&node_id) {
        node.last_seen = ts;
        node.endpoint_url = endpoint_url;
        RouterNode::update_by_node_id(&node_id, node);
        log::info!("register_node: heartbeat from node_id={}", node_id);
    } else {
        RouterNode::insert(RouterNode {
            node_id: node_id.clone(),
            endpoint_url,
            last_seen: ts,
            messages_routed: 0,
        });
        log::info!("register_node: new node registered node_id={}", node_id);
    }
}

/// Called periodically (e.g. by a scheduled reducer or external cron) to expire
/// messages whose TTL has elapsed.  Marks their acks as "expired" and cleans
/// stale preference-cache entries.
#[spacetimedb::reducer]
pub fn expire_messages(ctx: &ReducerContext) {
    let ts = now_ms(ctx);
    let mut expired_count: u32 = 0;

    // Expire messages whose expires_at has passed and whose ack is still pending/delivered.
    for message in Message::iter() {
        if message.expires_at < ts {
            if let Some(ack) = Ack::filter_by_message_id(&message.message_id) {
                if ack.status == "pending" || ack.status == "delivered" {
                    let mut expired_ack = ack;
                    expired_ack.status = "expired".to_string();
                    expired_ack.error_code = Some("TTL_ELAPSED".to_string());
                    expired_ack.updated_at = ts;
                    Ack::update_by_message_id(&message.message_id, expired_ack);
                    expired_count += 1;
                }
            }
        }
    }

    // Evict stale preference-cache entries.
    let mut evicted_prefs: u32 = 0;
    for entry in PreferenceCache::iter() {
        let cache_expires_ms = entry.cached_at + (entry.ttl_seconds as u64 * 1_000);
        if cache_expires_ms < ts {
            PreferenceCache::delete_by_recipient_did(&entry.recipient_did);
            evicted_prefs += 1;
        }
    }

    // Evict router nodes that haven't sent a heartbeat in over 5 minutes.
    let stale_threshold_ms: u64 = 5 * 60 * 1_000;
    let mut evicted_nodes: u32 = 0;
    for node in RouterNode::iter() {
        if ts.saturating_sub(node.last_seen) > stale_threshold_ms {
            RouterNode::delete_by_node_id(&node.node_id);
            evicted_nodes += 1;
        }
    }

    log::info!(
        "expire_messages: expired {} messages, evicted {} pref-cache entries, removed {} stale nodes",
        expired_count,
        evicted_prefs,
        evicted_nodes
    );
}
