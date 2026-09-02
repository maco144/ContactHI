//! ContactHI — CHI/1.0 router-node shared state (SpacetimeDB 2.x).
//!
//! All router nodes are stateless; the federation's shared state lives here.
//! Every table is `public` so inboxes and dashboards can hold real-time
//! subscriptions against them.
//!
//! Publish:
//!   spacetime publish contacthi --server http://localhost:3000

use spacetimedb::{ReducerContext, Table};

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

/// Tracks every CHI message through the system.
#[spacetimedb::table(name = "messages", accessor = messages, public)]
pub struct Message {
    #[primary_key]
    pub message_id: String,
    pub sender_did: String,
    /// Entity Identity code (CA, LM, GN, AA, RB, DR, VH, US, CP, HS) — spec §4.3
    pub sender_type: String,
    pub recipient_did: String,
    /// CHI intent, `class.action` (e.g. "inform.shipping_update") — spec §6.3
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

/// Threading links: which message a given message responds to (spec §9.3).
///
/// This is deliberately a separate table rather than a `reply_to` column on
/// `messages`. SpacetimeDB 2.0.4 requires a `#[default(...)]` to add a column
/// to a populated table, and the macro emits that expression inside
/// `const _: () = {}` — so a `String` default cannot compile (String has a
/// destructor and is not const-constructible). Adding a table is additive and
/// needs no migration; adding the column would have meant destroying the
/// database. Not worth losing data over a field placement.
#[spacetimedb::table(name = "message_threads", accessor = message_threads, public)]
pub struct MessageThread {
    /// The reply's own message_id
    #[primary_key]
    pub message_id: String,
    /// The message_id being responded to
    pub reply_to: String,
}

/// Delivery acknowledgement — one row per message, updated as it progresses.
#[spacetimedb::table(name = "acks", accessor = acks, public)]
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
#[spacetimedb::table(name = "preference_cache", accessor = preference_cache, public)]
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
#[spacetimedb::table(name = "router_nodes", accessor = router_nodes, public)]
pub struct RouterNode {
    #[primary_key]
    pub node_id: String,
    pub endpoint_url: String,
    /// Unix timestamp in milliseconds of last heartbeat
    pub last_seen: u64,
    pub messages_routed: u64,
}

/// In-band delivery target for agent-to-agent messages — the default fallback
/// channel when no external channel (push/sms/email/webhook) is configured or
/// succeeds. Partitioned by `recipient_did` so an agent subscribes only to its
/// own inbox.
#[spacetimedb::table(name = "agent_inbox", accessor = agent_inbox, public)]
pub struct AgentInboxEntry {
    #[primary_key]
    pub message_id: String,
    pub recipient_did: String,
    pub sender_did: String,
    /// Entity Identity code (CA, LM, GN, AA, RB, DR, VH, US, CP, HS) — spec §4.3
    pub sender_type: String,
    pub intent: String,
    pub payload_type: String,
    /// The envelope payload, JSON-serialized
    pub payload_json: String,
    /// Unix timestamp in milliseconds
    pub created_at: u64,
    pub read: bool,
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
pub fn submit_message(
    ctx: &ReducerContext,
    message_id: String,
    sender_did: String,
    sender_type: String,
    recipient_did: String,
    intent: String,
    priority: u8,
    ttl_seconds: u32,
    payload_type: String,
    created_at: u64,
    expires_at: u64,
    router_node: String,
    reply_to: String,
) {
    let ts = now_ms(ctx);

    // Reject messages that have already expired.
    if expires_at <= ts {
        log::warn!(
            "submit_message: message {} has already expired (expires_at={}, now={})",
            message_id,
            expires_at,
            ts
        );
        return;
    }

    // Idempotency: if the message already exists, silently ignore.
    if ctx.db.messages().message_id().find(&message_id).is_some() {
        log::info!(
            "submit_message: duplicate message_id {}, ignoring",
            message_id
        );
        return;
    }

    ctx.db.messages().insert(Message {
        message_id: message_id.clone(),
        sender_did,
        sender_type,
        recipient_did,
        intent,
        priority,
        ttl_seconds,
        payload_type,
        created_at,
        expires_at,
        router_node: router_node.clone(),
    });

    // Record the threading link only when this message is actually a reply.
    if !reply_to.is_empty() {
        ctx.db.message_threads().insert(MessageThread {
            message_id: message_id.clone(),
            reply_to,
        });
    }

    // Seed the ack row as pending.
    ctx.db.acks().insert(Ack {
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
    if let Some(node) = ctx.db.router_nodes().node_id().find(&router_node) {
        ctx.db.router_nodes().node_id().update(RouterNode {
            messages_routed: node.messages_routed + 1,
            ..node
        });
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

    let Some(mut ack) = ctx.db.acks().message_id().find(&message_id) else {
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

    ctx.db.acks().message_id().update(ack);

    log::info!("update_ack: message_id={} → status={}", message_id, status);
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

    if ctx
        .db
        .preference_cache()
        .recipient_did()
        .find(&recipient_did)
        .is_some()
    {
        ctx.db.preference_cache().recipient_did().update(entry);
    } else {
        ctx.db.preference_cache().insert(entry);
    }

    log::info!("cache_preferences: cached preferences for {}", recipient_did);
}

/// Called by a router node to register itself or send a heartbeat.
/// Creates the node row on first call, updates last_seen on subsequent calls.
#[spacetimedb::reducer]
pub fn register_node(ctx: &ReducerContext, node_id: String, endpoint_url: String) {
    let ts = now_ms(ctx);

    if let Some(node) = ctx.db.router_nodes().node_id().find(&node_id) {
        ctx.db.router_nodes().node_id().update(RouterNode {
            endpoint_url,
            last_seen: ts,
            ..node
        });
        log::info!("register_node: heartbeat from node_id={}", node_id);
    } else {
        ctx.db.router_nodes().insert(RouterNode {
            node_id: node_id.clone(),
            endpoint_url,
            last_seen: ts,
            messages_routed: 0,
        });
        log::info!("register_node: new node registered node_id={}", node_id);
    }
}

/// Called by a router node to deliver a message in-band, without an external
/// channel. This is the default fallback in the delivery-channel ordering.
#[spacetimedb::reducer]
pub fn write_agent_inbox(
    ctx: &ReducerContext,
    message_id: String,
    recipient_did: String,
    sender_did: String,
    sender_type: String,
    intent: String,
    payload_type: String,
    payload_json: String,
    created_at: u64,
) {
    // Idempotency: redelivery of the same message must not duplicate the entry.
    if ctx.db.agent_inbox().message_id().find(&message_id).is_some() {
        log::info!(
            "write_agent_inbox: duplicate message_id {}, ignoring",
            message_id
        );
        return;
    }

    ctx.db.agent_inbox().insert(AgentInboxEntry {
        message_id: message_id.clone(),
        recipient_did: recipient_did.clone(),
        sender_did,
        sender_type,
        intent,
        payload_type,
        payload_json,
        created_at,
        read: false,
    });

    log::info!(
        "write_agent_inbox: message_id={} → {}",
        message_id,
        recipient_did
    );
}

/// Marks an inbox entry read. Called by the recipient's agent, not by a router.
#[spacetimedb::reducer]
pub fn mark_inbox_read(ctx: &ReducerContext, message_id: String) {
    let Some(entry) = ctx.db.agent_inbox().message_id().find(&message_id) else {
        log::warn!("mark_inbox_read: unknown message_id={}", message_id);
        return;
    };

    ctx.db.agent_inbox().message_id().update(AgentInboxEntry {
        read: true,
        ..entry
    });
}

/// Called periodically (e.g. by a scheduled reducer or external cron) to expire
/// messages whose TTL has elapsed.  Marks their acks as "expired" and cleans
/// stale preference-cache entries.
#[spacetimedb::reducer]
pub fn expire_messages(ctx: &ReducerContext) {
    let ts = now_ms(ctx);
    let mut expired_count: u32 = 0;

    // Expire messages whose expires_at has passed and whose ack is still pending/delivered.
    for message in ctx.db.messages().iter() {
        if message.expires_at < ts {
            if let Some(ack) = ctx.db.acks().message_id().find(&message.message_id) {
                if ack.status == "pending" || ack.status == "delivered" {
                    ctx.db.acks().message_id().update(Ack {
                        status: "expired".to_string(),
                        error_code: Some("TTL_ELAPSED".to_string()),
                        updated_at: ts,
                        ..ack
                    });
                    expired_count += 1;
                }
            }
        }
    }

    // Evict stale preference-cache entries.
    let mut evicted_prefs: u32 = 0;
    let stale_prefs: Vec<String> = ctx
        .db
        .preference_cache()
        .iter()
        .filter(|entry| entry.cached_at + (entry.ttl_seconds as u64 * 1_000) < ts)
        .map(|entry| entry.recipient_did)
        .collect();
    for recipient_did in stale_prefs {
        ctx.db
            .preference_cache()
            .recipient_did()
            .delete(&recipient_did);
        evicted_prefs += 1;
    }

    // Evict router nodes that haven't sent a heartbeat in over 5 minutes.
    let stale_threshold_ms: u64 = 5 * 60 * 1_000;
    let mut evicted_nodes: u32 = 0;
    let stale_nodes: Vec<String> = ctx
        .db
        .router_nodes()
        .iter()
        .filter(|node| ts.saturating_sub(node.last_seen) > stale_threshold_ms)
        .map(|node| node.node_id)
        .collect();
    for node_id in stale_nodes {
        ctx.db.router_nodes().node_id().delete(&node_id);
        evicted_nodes += 1;
    }

    log::info!(
        "expire_messages: expired {} messages, evicted {} pref-cache entries, removed {} stale nodes",
        expired_count,
        evicted_prefs,
        evicted_nodes
    );
}
