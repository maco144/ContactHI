use cosmwasm_std::{Addr, Deps, Env, StdResult};

use crate::state::{
    DefaultPolicy, EntityType, HumanPreference, Intent, PreferenceRule, BLOCKLIST, PREFERENCES,
    RATE_COUNTS,
};
use crate::msg::PermissionResponse;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Evaluate whether `sender_did` may contact `recipient` with the given `intent`.
///
/// Steps:
/// 1. Load recipient's preference profile; deny with RECIPIENT_NOT_FOUND if absent.
/// 2. Check the global blocklist for `sender_did`; deny if matched.
/// 3. Find the best-matching rule (specificity order: exact+exact > exact+any >
///    any+exact > any+any).
/// 4. If no rule found, apply `default_policy`.
/// 5. If the rule exists but `sender_did` is in the rule's per-rule blocklist, deny.
/// 6. Check time window (if set).
/// 7. Check rate limit (if set).
/// 8. Return `PermissionResponse`.
pub fn check_permission(
    deps: Deps,
    env: &Env,
    sender_did: &str,
    sender_type: &EntityType,
    recipient: &Addr,
    intent: &Intent,
) -> StdResult<PermissionResponse> {
    // 1. Load preferences
    let prefs = match PREFERENCES.may_load(deps.storage, recipient)? {
        Some(p) => p,
        None => {
            return Ok(PermissionResponse {
                allowed: false,
                allowed_channels: vec![],
                reason: Some("RECIPIENT_NOT_FOUND".to_string()),
                rate_limit_remaining: None,
            });
        }
    };

    // 2. Global blocklist check
    if is_globally_blocked(deps, recipient, sender_did)? {
        return Ok(PermissionResponse {
            allowed: false,
            allowed_channels: vec![],
            reason: Some("SENDER_GLOBALLY_BLOCKED".to_string()),
            rate_limit_remaining: None,
        });
    }

    // 3. Find best matching rule
    let matched_rule = find_best_rule(&prefs, sender_type, intent);

    // 4. No matching rule → apply default policy
    let rule = match matched_rule {
        None => {
            let allowed = matches!(prefs.default_policy, DefaultPolicy::Allow);
            return Ok(PermissionResponse {
                allowed,
                allowed_channels: vec![],
                reason: if allowed {
                    None
                } else {
                    Some("NO_MATCHING_RULE_DEFAULT_BLOCK".to_string())
                },
                rate_limit_remaining: None,
            });
        }
        Some(r) => r,
    };

    // 5. Per-rule blocklist check
    if is_pattern_blocked(sender_did, &rule.blocklist) {
        return Ok(PermissionResponse {
            allowed: false,
            allowed_channels: vec![],
            reason: Some("SENDER_RULE_BLOCKED".to_string()),
            rate_limit_remaining: None,
        });
    }

    // 6. Time window check
    if let Some(ref window) = rule.time_window {
        if !is_within_time_window(env, window) {
            return Ok(PermissionResponse {
                allowed: false,
                allowed_channels: vec![],
                reason: Some("OUTSIDE_TIME_WINDOW".to_string()),
                rate_limit_remaining: None,
            });
        }
    }

    // 7. Rate limit check
    let rate_limit_remaining = if let Some(ref rl) = rule.rate_limit {
        let (remaining, allowed) = check_rate_limit(
            deps,
            env,
            recipient,
            sender_did,
            rl.count,
            rl.period_seconds,
        )?;
        if !allowed {
            return Ok(PermissionResponse {
                allowed: false,
                allowed_channels: vec![],
                reason: Some("RATE_LIMIT_EXCEEDED".to_string()),
                rate_limit_remaining: Some(0),
            });
        }
        Some(remaining)
    } else {
        None
    };

    Ok(PermissionResponse {
        allowed: true,
        allowed_channels: rule.allowed_channels.clone(),
        reason: None,
        rate_limit_remaining,
    })
}

// ---------------------------------------------------------------------------
// Rule matching (specificity priority)
// ---------------------------------------------------------------------------

/// Priority tiers (lower number = higher priority):
/// 0: exact sender_type + exact intent
/// 1: exact sender_type + Any intent
/// 2: Any sender_type   + exact intent
/// 3: Any sender_type   + Any intent
fn rule_priority(rule: &PreferenceRule, sender_type: &EntityType, intent: &Intent) -> Option<u8> {
    let sender_match_exact = entity_types_match_exact(&rule.sender_type, sender_type);
    let sender_match_any = matches!(rule.sender_type, EntityType::Any);
    let intent_match_exact = intents_match_exact(&rule.intent, intent);
    let intent_match_any = matches!(rule.intent, Intent::Any);

    match (
        sender_match_exact || sender_match_any,
        sender_match_exact,
        intent_match_exact || intent_match_any,
        intent_match_exact,
    ) {
        (true, true, true, true) => Some(0),   // exact + exact
        (true, true, true, false) => Some(1),  // exact sender + Any intent
        (true, false, true, true) => Some(2),  // Any sender + exact intent
        (true, false, true, false) => Some(3), // Any + Any
        _ => None,                             // no match
    }
}

fn find_best_rule<'a>(
    prefs: &'a HumanPreference,
    sender_type: &EntityType,
    intent: &Intent,
) -> Option<&'a PreferenceRule> {
    let mut best: Option<(u8, &PreferenceRule)> = None;

    for rule in &prefs.rules {
        if let Some(priority) = rule_priority(rule, sender_type, intent) {
            match best {
                None => best = Some((priority, rule)),
                Some((current_priority, _)) if priority < current_priority => {
                    best = Some((priority, rule));
                }
                _ => {}
            }
        }
    }

    best.map(|(_, rule)| rule)
}

// ---------------------------------------------------------------------------
// Blocklist helpers
// ---------------------------------------------------------------------------

/// Check if `sender_did` is in the recipient's global blocklist.
/// Matches exact strings AND simple suffix wildcards (e.g. "*.evil.com").
pub fn is_globally_blocked(
    deps: Deps,
    recipient: &Addr,
    sender_did: &str,
) -> StdResult<bool> {
    // Collect all blocklist entries for this recipient and do pattern matching.
    // We iterate because Map doesn't support full-scan prefix queries without
    // the iterator feature — using prefix scan here via cw-storage-plus range.
    let prefix = BLOCKLIST.prefix(recipient);
    let entries: Vec<(String, bool)> = prefix
        .range(deps.storage, None, None, cosmwasm_std::Order::Ascending)
        .collect::<StdResult<Vec<_>>>()?;

    for (pattern, blocked) in entries {
        if blocked && pattern_matches(sender_did, &pattern) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Check if `sender_did` matches any pattern in an ad-hoc list (per-rule blocklist).
pub fn is_pattern_blocked(sender_did: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| pattern_matches(sender_did, p))
}

/// Pattern matching rules:
/// - Exact match always wins.
/// - `*.domain.com` matches anything ending in `.domain.com`.
/// - `did:*` matches anything starting with `did:`.
/// - Plain `*` matches everything.
fn pattern_matches(value: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if pattern == value {
        return true;
    }
    if let Some(suffix) = pattern.strip_prefix("*.") {
        return value.ends_with(suffix) || value == suffix;
    }
    if let Some(prefix) = pattern.strip_suffix("*") {
        return value.starts_with(prefix);
    }
    false
}

// ---------------------------------------------------------------------------
// Time window
// ---------------------------------------------------------------------------

fn is_within_time_window(env: &Env, window: &crate::state::TimeWindow) -> bool {
    // Block time in seconds since Unix epoch.
    let block_secs = env.block.time.seconds();
    let seconds_in_day: u64 = 86_400;
    let secs_today = block_secs % seconds_in_day;

    let start_secs = (window.start_hour as u64) * 3600 + (window.start_minute as u64) * 60;
    let end_secs = (window.end_hour as u64) * 3600 + (window.end_minute as u64) * 60;

    if start_secs <= end_secs {
        secs_today >= start_secs && secs_today < end_secs
    } else {
        // Wraps midnight: e.g. 22:00–06:00
        secs_today >= start_secs || secs_today < end_secs
    }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/// Returns `(remaining, is_allowed)`.
/// Uses a fixed-window strategy keyed on `floor(now / period_seconds)`.
fn check_rate_limit(
    deps: Deps,
    env: &Env,
    recipient: &Addr,
    sender_did: &str,
    limit: u32,
    period_seconds: u64,
) -> StdResult<(u32, bool)> {
    let now = env.block.time.seconds();
    let window_id = now / period_seconds;
    let period_key = format!("{}:{}", period_seconds, window_id);

    // We need a stable Addr for the sender to use as a Map key.
    // If sender_did is a valid bech32, use it; otherwise treat it as a raw string key
    // embedded in the period_key (no secondary address validation needed here —
    // counting is best-effort keyed on the raw DID string).
    let sender_key_str = format!("{}:{}", sender_did, period_key);
    // Use a synthetic Addr (unchecked) for the Map composite key.
    let sender_addr = Addr::unchecked(sender_did);
    let full_period_key = format!("{}:{}", period_seconds, window_id);

    let current_count = RATE_COUNTS
        .may_load(deps.storage, (recipient, &sender_addr, &full_period_key))?
        .unwrap_or(0);

    // Suppress unused variable warning from the earlier binding.
    let _ = sender_key_str;

    if current_count >= limit {
        Ok((0, false))
    } else {
        let remaining = limit - current_count - 1; // -1 for the message being evaluated
        Ok((remaining, true))
    }
}

/// Increment the rate-limit counter for a sender→recipient pair.
/// Called from execute handlers after a message is approved.
pub fn increment_rate_count(
    storage: &mut dyn cosmwasm_std::Storage,
    env: &Env,
    recipient: &Addr,
    sender_did: &str,
    period_seconds: u64,
) -> StdResult<()> {
    let now = env.block.time.seconds();
    let window_id = now / period_seconds;
    let period_key = format!("{}:{}", period_seconds, window_id);
    let sender_addr = Addr::unchecked(sender_did);

    let count = RATE_COUNTS
        .may_load(storage, (recipient, &sender_addr, &period_key))?
        .unwrap_or(0);
    RATE_COUNTS.save(storage, (recipient, &sender_addr, &period_key), &(count + 1))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Equality helpers (without PartialEq across wildcard variants)
// ---------------------------------------------------------------------------

fn entity_types_match_exact(a: &EntityType, b: &EntityType) -> bool {
    matches!(
        (a, b),
        (EntityType::CA, EntityType::CA)
            | (EntityType::LM, EntityType::LM)
            | (EntityType::GN, EntityType::GN)
            | (EntityType::AA, EntityType::AA)
            | (EntityType::RB, EntityType::RB)
            | (EntityType::DR, EntityType::DR)
            | (EntityType::VH, EntityType::VH)
            | (EntityType::US, EntityType::US)
            | (EntityType::CP, EntityType::CP)
            | (EntityType::HS, EntityType::HS)
    )
}

fn intents_match_exact(a: &Intent, b: &Intent) -> bool {
    matches!(
        (a, b),
        (Intent::Inform, Intent::Inform)
            | (Intent::Collect, Intent::Collect)
            | (Intent::Authorize, Intent::Authorize)
            | (Intent::Escalate, Intent::Escalate)
            | (Intent::Result, Intent::Result)
    )
}

// ---------------------------------------------------------------------------
// Validation helpers (used by execute handlers)
// ---------------------------------------------------------------------------

pub fn validate_preference_rule(rule: &PreferenceRule) -> Result<(), crate::error::ContractError> {
    if let Some(ref rl) = rule.rate_limit {
        if rl.count == 0 || rl.period_seconds == 0 {
            return Err(crate::error::ContractError::InvalidRateLimit {});
        }
    }
    if let Some(ref tw) = rule.time_window {
        if tw.start_hour > 23
            || tw.end_hour > 23
            || tw.start_minute > 59
            || tw.end_minute > 59
        {
            return Err(crate::error::ContractError::InvalidTimeWindow {});
        }
    }
    Ok(())
}

pub fn validate_webhook_url(url: &str) -> Result<(), crate::error::ContractError> {
    if !url.starts_with("https://") {
        return Err(crate::error::ContractError::InvalidWebhookUrl {});
    }
    Ok(())
}
