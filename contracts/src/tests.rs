//! Unit tests for the CHI/1.0 preference registry.
//!
//! This contract decides, for every message in the protocol, whether it may be
//! delivered. Until 2026-09-02 it had no tests at all — `cargo test` reported
//! `test result: ok` on zero tests, which reads identical to a passing suite.
//!
//! The rule-matching ladder in §5.3 of the spec is the load-bearing part: it is
//! the only thing standing between "consent-first" and "a mailing list". Most
//! of what follows exercises that ladder and the deny paths around it.

use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{from_json, Addr, Timestamp};

use crate::contract::{execute, instantiate, query, MAX_RULES};
use crate::error::ContractError;
use crate::msg::{
    ExecuteMsg, InstantiateMsg, IsBlockedResponse, PermissionResponse, PreferencesResponse,
    QueryMsg, RulesResponse,
};
use crate::state::{
    Channel, DefaultPolicy, EntityType, Intent, PreferenceRule, RateLimit, TimeWindow,
};

const HUMAN: &str = "cosmos1human000000000000000000000000000000";
const STRANGER: &str = "cosmos1stranger00000000000000000000000000";
const SENDER_DID: &str = "did:chi:cosmos1sender0000000000000000000000";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

fn rule(sender_type: EntityType, intent: Intent, channels: Vec<Channel>) -> PreferenceRule {
    PreferenceRule {
        sender_type,
        intent,
        allowed_channels: channels,
        rate_limit: None,
        time_window: None,
        blocklist: vec![],
    }
}

/// Set up a contract with `HUMAN` holding the given rules and policy.
fn setup(
    rules: Vec<PreferenceRule>,
    default_policy: DefaultPolicy,
) -> cosmwasm_std::OwnedDeps<
    cosmwasm_std::testing::MockStorage,
    cosmwasm_std::testing::MockApi,
    cosmwasm_std::testing::MockQuerier,
> {
    let mut deps = mock_dependencies();
    instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info("deployer", &[]),
        InstantiateMsg { admin: None },
    )
    .unwrap();

    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::RegisterPreferences {
            rules,
            default_policy,
            webhook_url: None,
        },
    )
    .unwrap();

    deps
}

fn ask(
    deps: cosmwasm_std::Deps,
    sender_type: EntityType,
    intent: Intent,
) -> PermissionResponse {
    ask_as(deps, mock_env(), SENDER_DID, sender_type, intent)
}

fn ask_as(
    deps: cosmwasm_std::Deps,
    env: cosmwasm_std::Env,
    sender_did: &str,
    sender_type: EntityType,
    intent: Intent,
) -> PermissionResponse {
    let bin = query(
        deps,
        env,
        QueryMsg::CheckPermission {
            sender_did: sender_did.to_string(),
            sender_type,
            recipient: HUMAN.to_string(),
            intent,
        },
    )
    .unwrap();
    from_json(&bin).unwrap()
}

// ---------------------------------------------------------------------------
// Instantiate / registration
// ---------------------------------------------------------------------------

#[test]
fn instantiate_sets_contract_version() {
    let mut deps = mock_dependencies();
    let res = instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info("deployer", &[]),
        InstantiateMsg { admin: None },
    )
    .unwrap();
    assert!(res
        .attributes
        .iter()
        .any(|a| a.key == "action" && a.value == "instantiate"));
}

#[test]
fn register_then_get_preferences_round_trips() {
    let deps = setup(
        vec![rule(EntityType::AA, Intent::Inform, vec![Channel::Email])],
        DefaultPolicy::Block,
    );

    let bin = query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::GetPreferences {
            address: HUMAN.to_string(),
        },
    )
    .unwrap();
    let prefs: PreferencesResponse = from_json(&bin).unwrap();

    assert_eq!(prefs.owner, HUMAN);
    assert_eq!(prefs.rules.len(), 1);
    assert_eq!(prefs.default_policy, DefaultPolicy::Block);
}

#[test]
fn registering_twice_is_rejected() {
    let mut deps = setup(vec![], DefaultPolicy::Block);
    let err = execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::RegisterPreferences {
            rules: vec![],
            default_policy: DefaultPolicy::Allow,
            webhook_url: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::PreferencesAlreadyExist {}));
}

#[test]
fn rules_beyond_the_maximum_are_rejected() {
    let mut deps = mock_dependencies();
    instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info("deployer", &[]),
        InstantiateMsg { admin: None },
    )
    .unwrap();

    let too_many = (0..MAX_RULES + 1)
        .map(|_| rule(EntityType::AA, Intent::Inform, vec![Channel::Email]))
        .collect();

    let err = execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::RegisterPreferences {
            rules: too_many,
            default_policy: DefaultPolicy::Block,
            webhook_url: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::TooManyRules { .. }));
}

#[test]
fn webhook_url_must_be_https() {
    let mut deps = mock_dependencies();
    instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info("deployer", &[]),
        InstantiateMsg { admin: None },
    )
    .unwrap();

    let err = execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::RegisterPreferences {
            rules: vec![],
            default_policy: DefaultPolicy::Block,
            webhook_url: Some("http://insecure.example.com/hook".to_string()),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidWebhookUrl {}));
}

// ---------------------------------------------------------------------------
// Owner-only enforcement
//
// "No admin can override individual user preferences" is a stated design
// guarantee. These are the tests that make it one.
// ---------------------------------------------------------------------------

#[test]
fn a_stranger_cannot_modify_someone_elses_rules() {
    let mut deps = setup(
        vec![rule(EntityType::AA, Intent::Inform, vec![Channel::Email])],
        DefaultPolicy::Block,
    );

    for msg in [
        ExecuteMsg::UpdatePreferences {
            rules: vec![],
            default_policy: DefaultPolicy::Allow,
            webhook_url: None,
        },
        ExecuteMsg::AddRule {
            rule: rule(EntityType::Any, Intent::Any, vec![Channel::Sms]),
        },
        ExecuteMsg::RemoveRule { index: 0 },
        ExecuteMsg::DeletePreferences {},
    ] {
        let err = execute(deps.as_mut(), mock_env(), mock_info(STRANGER, &[]), msg).unwrap_err();
        assert!(
            matches!(
                err,
                ContractError::Unauthorized {} | ContractError::PreferencesNotFound { .. }
            ),
            "a stranger must not be able to act on another profile, got {err:?}"
        );
    }

    // And the original profile is untouched.
    let granted = ask(deps.as_ref(), EntityType::AA, Intent::Inform);
    assert!(granted.allowed);
}

#[test]
fn owner_can_add_and_remove_rules() {
    let mut deps = setup(vec![], DefaultPolicy::Block);

    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::AddRule {
            rule: rule(EntityType::AA, Intent::Inform, vec![Channel::Push]),
        },
    )
    .unwrap();
    assert!(ask(deps.as_ref(), EntityType::AA, Intent::Inform).allowed);

    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::RemoveRule { index: 0 },
    )
    .unwrap();
    assert!(!ask(deps.as_ref(), EntityType::AA, Intent::Inform).allowed);
}

#[test]
fn removing_an_out_of_range_rule_is_rejected() {
    let mut deps = setup(vec![], DefaultPolicy::Block);
    let err = execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::RemoveRule { index: 7 },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::RuleIndexOutOfBounds { .. }));
}

// ---------------------------------------------------------------------------
// The rule-matching ladder (spec §5.3)
//
// 1. exact sender_type + exact intent
// 2. exact sender_type + Any intent
// 3. Any sender_type   + exact intent
// 4. Any sender_type   + Any intent
// 5. → default_policy
// ---------------------------------------------------------------------------

/// A rule's channel list is the observable fingerprint of *which* rule matched,
/// so each tier gets a distinct channel and the assertions read unambiguously.
fn ladder_rules() -> Vec<PreferenceRule> {
    vec![
        rule(EntityType::Any, Intent::Any, vec![Channel::Webhook]), // tier 4
        rule(EntityType::Any, Intent::Inform, vec![Channel::Email]), // tier 3
        rule(EntityType::AA, Intent::Any, vec![Channel::Sms]),      // tier 2
        rule(EntityType::AA, Intent::Inform, vec![Channel::Push]),  // tier 1
    ]
}

#[test]
fn exact_sender_and_exact_intent_wins_over_everything() {
    let deps = setup(ladder_rules(), DefaultPolicy::Block);
    let res = ask(deps.as_ref(), EntityType::AA, Intent::Inform);
    assert!(res.allowed);
    assert_eq!(res.allowed_channels, vec![Channel::Push]);
}

#[test]
fn exact_sender_with_any_intent_beats_any_sender_with_exact_intent() {
    let deps = setup(ladder_rules(), DefaultPolicy::Block);
    // AA + Collect: tier-1 rule does not apply, tier-2 (AA + Any) should win
    // over tier-4. Tier-3 is Any+Inform and does not apply either.
    let res = ask(deps.as_ref(), EntityType::AA, Intent::Collect);
    assert!(res.allowed);
    assert_eq!(res.allowed_channels, vec![Channel::Sms]);
}

#[test]
fn any_sender_with_exact_intent_beats_the_double_wildcard() {
    let deps = setup(ladder_rules(), DefaultPolicy::Block);
    // LM + Inform: only tier-3 (Any + Inform) and tier-4 apply; tier-3 wins.
    let res = ask(deps.as_ref(), EntityType::LM, Intent::Inform);
    assert!(res.allowed);
    assert_eq!(res.allowed_channels, vec![Channel::Email]);
}

#[test]
fn the_double_wildcard_catches_what_nothing_else_matches() {
    let deps = setup(ladder_rules(), DefaultPolicy::Block);
    let res = ask(deps.as_ref(), EntityType::RB, Intent::Escalate);
    assert!(res.allowed);
    assert_eq!(res.allowed_channels, vec![Channel::Webhook]);
}

#[test]
fn rule_order_in_the_list_does_not_affect_precedence() {
    // Specificity, not declaration order, decides. Reversing the list must not
    // change any outcome — otherwise the ladder is really "first match wins".
    let mut reversed = ladder_rules();
    reversed.reverse();
    let deps = setup(reversed, DefaultPolicy::Block);

    assert_eq!(
        ask(deps.as_ref(), EntityType::AA, Intent::Inform).allowed_channels,
        vec![Channel::Push]
    );
    assert_eq!(
        ask(deps.as_ref(), EntityType::AA, Intent::Collect).allowed_channels,
        vec![Channel::Sms]
    );
    assert_eq!(
        ask(deps.as_ref(), EntityType::LM, Intent::Inform).allowed_channels,
        vec![Channel::Email]
    );
}

// ---------------------------------------------------------------------------
// Default policy — the consent-first guarantee
// ---------------------------------------------------------------------------

#[test]
fn no_matching_rule_under_block_policy_denies() {
    let deps = setup(
        vec![rule(EntityType::AA, Intent::Inform, vec![Channel::Push])],
        DefaultPolicy::Block,
    );
    let res = ask(deps.as_ref(), EntityType::LM, Intent::Escalate);
    assert!(!res.allowed);
    assert_eq!(
        res.reason.as_deref(),
        Some("NO_MATCHING_RULE_DEFAULT_BLOCK")
    );
    assert!(res.allowed_channels.is_empty());
}

#[test]
fn an_empty_profile_under_block_policy_denies_everything() {
    let deps = setup(vec![], DefaultPolicy::Block);
    for (ty, intent) in [
        (EntityType::AA, Intent::Inform),
        (EntityType::US, Intent::Authorize),
        (EntityType::HS, Intent::Result),
    ] {
        assert!(
            !ask(deps.as_ref(), ty, intent).allowed,
            "registering with no rules must not make you reachable"
        );
    }
}

#[test]
fn no_matching_rule_under_allow_policy_permits() {
    let deps = setup(vec![], DefaultPolicy::Allow);
    let res = ask(deps.as_ref(), EntityType::LM, Intent::Escalate);
    assert!(res.allowed);
}

#[test]
fn an_unregistered_recipient_is_not_reachable() {
    let mut deps = mock_dependencies();
    instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info("deployer", &[]),
        InstantiateMsg { admin: None },
    )
    .unwrap();

    let res = ask(deps.as_ref(), EntityType::AA, Intent::Inform);
    assert!(!res.allowed);
    assert_eq!(res.reason.as_deref(), Some("RECIPIENT_NOT_FOUND"));
}

// ---------------------------------------------------------------------------
// Blocklists
// ---------------------------------------------------------------------------

#[test]
fn the_global_blocklist_overrides_an_allowing_rule() {
    let mut deps = setup(
        vec![rule(EntityType::Any, Intent::Any, vec![Channel::Push])],
        DefaultPolicy::Allow,
    );
    assert!(ask(deps.as_ref(), EntityType::AA, Intent::Inform).allowed);

    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::BlockSender {
            pattern: SENDER_DID.to_string(),
        },
    )
    .unwrap();

    let res = ask(deps.as_ref(), EntityType::AA, Intent::Inform);
    assert!(!res.allowed);
    assert_eq!(res.reason.as_deref(), Some("SENDER_GLOBALLY_BLOCKED"));
}

#[test]
fn unblocking_restores_reachability() {
    let mut deps = setup(
        vec![rule(EntityType::Any, Intent::Any, vec![Channel::Push])],
        DefaultPolicy::Allow,
    );
    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::BlockSender {
            pattern: SENDER_DID.to_string(),
        },
    )
    .unwrap();
    assert!(!ask(deps.as_ref(), EntityType::AA, Intent::Inform).allowed);

    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::UnblockSender {
            pattern: SENDER_DID.to_string(),
        },
    )
    .unwrap();
    assert!(ask(deps.as_ref(), EntityType::AA, Intent::Inform).allowed);
}

#[test]
fn a_stranger_cannot_block_on_someone_elses_behalf() {
    let mut deps = setup(
        vec![rule(EntityType::Any, Intent::Any, vec![Channel::Push])],
        DefaultPolicy::Allow,
    );
    let err = execute(
        deps.as_mut(),
        mock_env(),
        mock_info(STRANGER, &[]),
        ExecuteMsg::BlockSender {
            pattern: SENDER_DID.to_string(),
        },
    );
    // Whether this errors or writes to the stranger's own list, HUMAN's
    // reachability must be unchanged.
    let _ = err;
    assert!(
        ask(deps.as_ref(), EntityType::AA, Intent::Inform).allowed,
        "one account's block must never affect another account's profile"
    );
}

#[test]
fn wildcard_blocklist_patterns_match_by_suffix_and_prefix() {
    let mut deps = setup(
        vec![rule(EntityType::Any, Intent::Any, vec![Channel::Push])],
        DefaultPolicy::Allow,
    );
    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::BlockSender {
            pattern: "*.evil.com".to_string(),
        },
    )
    .unwrap();

    let blocked = ask_as(
        deps.as_ref(),
        mock_env(),
        "agent.evil.com",
        EntityType::AA,
        Intent::Inform,
    );
    assert!(!blocked.allowed);

    let unrelated = ask_as(
        deps.as_ref(),
        mock_env(),
        "agent.good.com",
        EntityType::AA,
        Intent::Inform,
    );
    assert!(unrelated.allowed);
}

#[test]
fn a_per_rule_blocklist_denies_even_when_the_rule_matches() {
    let mut blocked_rule = rule(EntityType::Any, Intent::Any, vec![Channel::Push]);
    blocked_rule.blocklist = vec![SENDER_DID.to_string()];
    let deps = setup(vec![blocked_rule], DefaultPolicy::Allow);

    let res = ask(deps.as_ref(), EntityType::AA, Intent::Inform);
    assert!(!res.allowed);
    assert_eq!(res.reason.as_deref(), Some("SENDER_RULE_BLOCKED"));
}

#[test]
fn is_blocked_query_reports_global_and_per_rule_patterns() {
    let mut deps = setup(
        vec![rule(EntityType::Any, Intent::Any, vec![Channel::Push])],
        DefaultPolicy::Allow,
    );
    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::BlockSender {
            pattern: SENDER_DID.to_string(),
        },
    )
    .unwrap();

    let bin = query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::IsBlocked {
            sender_pattern: SENDER_DID.to_string(),
            recipient: HUMAN.to_string(),
        },
    )
    .unwrap();
    let res: IsBlockedResponse = from_json(&bin).unwrap();
    assert!(res.blocked);
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

/// Build an env whose block time sits at `hour:minute` UTC on some day.
fn env_at(hour: u64, minute: u64) -> cosmwasm_std::Env {
    let mut env = mock_env();
    env.block.time = Timestamp::from_seconds(86_400 * 20_000 + hour * 3600 + minute * 60);
    env
}

#[test]
fn a_message_inside_the_time_window_is_allowed() {
    let mut r = rule(EntityType::Any, Intent::Any, vec![Channel::Push]);
    r.time_window = Some(TimeWindow {
        start_hour: 9,
        start_minute: 0,
        end_hour: 17,
        end_minute: 0,
    });
    let deps = setup(vec![r], DefaultPolicy::Block);

    let res = ask_as(
        deps.as_ref(),
        env_at(12, 0),
        SENDER_DID,
        EntityType::AA,
        Intent::Inform,
    );
    assert!(res.allowed);
}

#[test]
fn a_message_outside_the_time_window_is_denied() {
    let mut r = rule(EntityType::Any, Intent::Any, vec![Channel::Push]);
    r.time_window = Some(TimeWindow {
        start_hour: 9,
        start_minute: 0,
        end_hour: 17,
        end_minute: 0,
    });
    let deps = setup(vec![r], DefaultPolicy::Block);

    let res = ask_as(
        deps.as_ref(),
        env_at(3, 0),
        SENDER_DID,
        EntityType::AA,
        Intent::Inform,
    );
    assert!(!res.allowed);
    assert_eq!(res.reason.as_deref(), Some("OUTSIDE_TIME_WINDOW"));
}

#[test]
fn a_window_that_wraps_midnight_covers_both_sides_of_it() {
    let mut r = rule(EntityType::Any, Intent::Any, vec![Channel::Push]);
    r.time_window = Some(TimeWindow {
        start_hour: 22,
        start_minute: 0,
        end_hour: 6,
        end_minute: 0,
    });
    let deps = setup(vec![r], DefaultPolicy::Block);

    // 23:00 — after start, before midnight
    assert!(ask_as(
        deps.as_ref(),
        env_at(23, 0),
        SENDER_DID,
        EntityType::AA,
        Intent::Inform
    )
    .allowed);

    // 02:00 — after midnight, before end
    assert!(ask_as(
        deps.as_ref(),
        env_at(2, 0),
        SENDER_DID,
        EntityType::AA,
        Intent::Inform
    )
    .allowed);

    // 12:00 — squarely outside
    assert!(!ask_as(
        deps.as_ref(),
        env_at(12, 0),
        SENDER_DID,
        EntityType::AA,
        Intent::Inform
    )
    .allowed);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

#[test]
fn a_rate_limited_rule_reports_its_remaining_allowance() {
    let mut r = rule(EntityType::Any, Intent::Any, vec![Channel::Push]);
    r.rate_limit = Some(RateLimit {
        count: 3,
        period_seconds: 86_400,
    });
    let deps = setup(vec![r], DefaultPolicy::Block);

    let res = ask(deps.as_ref(), EntityType::AA, Intent::Inform);
    assert!(res.allowed);
    // 3 permitted, none counted yet, 1 being evaluated → 2 left after this one.
    assert_eq!(res.rate_limit_remaining, Some(2));
}

#[test]
fn a_rate_limit_actually_stops_the_sender_once_it_is_reached() {
    // This is the test the contract is expected to fail today: nothing in the
    // contract calls `increment_rate_count`, so RATE_COUNTS is never written and
    // the ceiling can never be reached. A rate limit a human configures and the
    // registry never enforces is worse than no rate limit at all — it is a
    // promise in the UI with nothing behind it.
    let mut r = rule(EntityType::Any, Intent::Any, vec![Channel::Push]);
    r.rate_limit = Some(RateLimit {
        count: 2,
        period_seconds: 86_400,
    });
    let mut deps = setup(vec![r], DefaultPolicy::Block);

    // Burn the allowance by recording sends, as a router would after delivery.
    let env = mock_env();
    for _ in 0..2 {
        crate::helpers::increment_rate_count(
            deps.as_mut().storage,
            &env,
            &Addr::unchecked(HUMAN),
            SENDER_DID,
            86_400,
        )
        .unwrap();
    }

    let res = ask_as(
        deps.as_ref(),
        env,
        SENDER_DID,
        EntityType::AA,
        Intent::Inform,
    );
    assert!(
        !res.allowed,
        "a sender at its configured limit must be refused"
    );
    assert_eq!(res.reason.as_deref(), Some("RATE_LIMIT_EXCEEDED"));
    assert_eq!(res.rate_limit_remaining, Some(0));
}

#[test]
fn rate_limit_windows_are_independent() {
    let mut r = rule(EntityType::Any, Intent::Any, vec![Channel::Push]);
    r.rate_limit = Some(RateLimit {
        count: 1,
        period_seconds: 3_600,
    });
    let mut deps = setup(vec![r], DefaultPolicy::Block);

    let first = env_at(1, 0);
    crate::helpers::increment_rate_count(
        deps.as_mut().storage,
        &first,
        &Addr::unchecked(HUMAN),
        SENDER_DID,
        3_600,
    )
    .unwrap();
    assert!(!ask_as(deps.as_ref(), first, SENDER_DID, EntityType::AA, Intent::Inform).allowed);

    // Next hour is a fresh window.
    let later = env_at(3, 0);
    assert!(ask_as(deps.as_ref(), later, SENDER_DID, EntityType::AA, Intent::Inform).allowed);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

#[test]
fn get_rules_returns_the_stored_rules() {
    let deps = setup(
        vec![
            rule(EntityType::AA, Intent::Inform, vec![Channel::Push]),
            rule(EntityType::LM, Intent::Collect, vec![Channel::Email]),
        ],
        DefaultPolicy::Block,
    );

    let bin = query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::GetRules {
            address: HUMAN.to_string(),
        },
    )
    .unwrap();
    let res: RulesResponse = from_json(&bin).unwrap();
    assert_eq!(res.rules.len(), 2);
}

#[test]
fn deleting_preferences_makes_the_recipient_unreachable_again() {
    let mut deps = setup(
        vec![rule(EntityType::Any, Intent::Any, vec![Channel::Push])],
        DefaultPolicy::Allow,
    );
    assert!(ask(deps.as_ref(), EntityType::AA, Intent::Inform).allowed);

    execute(
        deps.as_mut(),
        mock_env(),
        mock_info(HUMAN, &[]),
        ExecuteMsg::DeletePreferences {},
    )
    .unwrap();

    let res = ask(deps.as_ref(), EntityType::AA, Intent::Inform);
    assert!(!res.allowed);
    assert_eq!(res.reason.as_deref(), Some("RECIPIENT_NOT_FOUND"));
}
