use cosmwasm_std::{
    entry_point, to_json_binary, Binary, Deps, DepsMut, Env, Event, MessageInfo, Response,
    StdResult,
};
use cw2::set_contract_version;

use crate::error::ContractError;
use crate::helpers::{
    check_permission, is_globally_blocked, is_pattern_blocked, validate_preference_rule,
    validate_webhook_url,
};
use crate::msg::{
    ExecuteMsg, InstantiateMsg, IsBlockedResponse, PermissionResponse, PreferencesResponse,
    QueryMsg, RulesResponse,
};
use crate::state::{
    HumanPreference, BLOCKLIST, CONTRACT_NAME, CONTRACT_VERSION, PREFERENCES,
};

pub const MAX_RULES: usize = 64;
pub const MAX_BLOCKLIST: usize = 512;

// ---------------------------------------------------------------------------
// Instantiate
// ---------------------------------------------------------------------------

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    _msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("contract", CONTRACT_NAME)
        .add_attribute("version", CONTRACT_VERSION))
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::RegisterPreferences {
            rules,
            default_policy,
            webhook_url,
        } => execute_register_preferences(deps, env, info, rules, default_policy, webhook_url),

        ExecuteMsg::UpdatePreferences {
            rules,
            default_policy,
            webhook_url,
        } => execute_update_preferences(deps, env, info, rules, default_policy, webhook_url),

        ExecuteMsg::AddRule { rule } => execute_add_rule(deps, env, info, rule),

        ExecuteMsg::RemoveRule { index } => execute_remove_rule(deps, env, info, index),

        ExecuteMsg::BlockSender { pattern } => execute_block_sender(deps, info, pattern),

        ExecuteMsg::UnblockSender { pattern } => execute_unblock_sender(deps, info, pattern),

        ExecuteMsg::DeletePreferences {} => execute_delete_preferences(deps, info),
    }
}

// ---------------------------------------------------------------------------
// Execute handlers
// ---------------------------------------------------------------------------

fn execute_register_preferences(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    rules: Vec<crate::state::PreferenceRule>,
    default_policy: crate::state::DefaultPolicy,
    webhook_url: Option<String>,
) -> Result<Response, ContractError> {
    let owner = &info.sender;

    // Fail if profile already exists
    if PREFERENCES.may_load(deps.storage, owner)?.is_some() {
        return Err(ContractError::PreferencesAlreadyExist {});
    }

    if rules.len() > MAX_RULES {
        return Err(ContractError::TooManyRules { max: MAX_RULES });
    }

    for rule in &rules {
        validate_preference_rule(rule)?;
    }

    if let Some(ref url) = webhook_url {
        validate_webhook_url(url)?;
    }

    let prefs = HumanPreference {
        owner: owner.clone(),
        rules,
        default_policy,
        webhook_url,
        updated_at: env.block.time.seconds(),
    };

    PREFERENCES.save(deps.storage, owner, &prefs)?;

    let event = Event::new("wasm-chi")
        .add_attribute("action", "register_preferences")
        .add_attribute("owner", owner.to_string());

    Ok(Response::new().add_event(event))
}

fn execute_update_preferences(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    rules: Vec<crate::state::PreferenceRule>,
    default_policy: crate::state::DefaultPolicy,
    webhook_url: Option<String>,
) -> Result<Response, ContractError> {
    let owner = &info.sender;

    // Must already exist
    let mut prefs = PREFERENCES
        .may_load(deps.storage, owner)?
        .ok_or_else(|| ContractError::PreferencesNotFound {
            address: owner.to_string(),
        })?;

    if rules.len() > MAX_RULES {
        return Err(ContractError::TooManyRules { max: MAX_RULES });
    }

    for rule in &rules {
        validate_preference_rule(rule)?;
    }

    if let Some(ref url) = webhook_url {
        validate_webhook_url(url)?;
    }

    prefs.rules = rules;
    prefs.default_policy = default_policy;
    prefs.webhook_url = webhook_url;
    prefs.updated_at = env.block.time.seconds();

    PREFERENCES.save(deps.storage, owner, &prefs)?;

    let event = Event::new("wasm-chi")
        .add_attribute("action", "update_preferences")
        .add_attribute("owner", owner.to_string());

    Ok(Response::new().add_event(event))
}

fn execute_add_rule(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    rule: crate::state::PreferenceRule,
) -> Result<Response, ContractError> {
    let owner = &info.sender;

    let mut prefs = PREFERENCES
        .may_load(deps.storage, owner)?
        .ok_or_else(|| ContractError::PreferencesNotFound {
            address: owner.to_string(),
        })?;

    if prefs.rules.len() >= MAX_RULES {
        return Err(ContractError::TooManyRules { max: MAX_RULES });
    }

    validate_preference_rule(&rule)?;

    prefs.rules.push(rule);
    prefs.updated_at = env.block.time.seconds();

    PREFERENCES.save(deps.storage, owner, &prefs)?;

    let event = Event::new("wasm-chi")
        .add_attribute("action", "add_rule")
        .add_attribute("owner", owner.to_string())
        .add_attribute("rule_count", prefs.rules.len().to_string());

    Ok(Response::new().add_event(event))
}

fn execute_remove_rule(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    index: u32,
) -> Result<Response, ContractError> {
    let owner = &info.sender;
    let idx = index as usize;

    let mut prefs = PREFERENCES
        .may_load(deps.storage, owner)?
        .ok_or_else(|| ContractError::PreferencesNotFound {
            address: owner.to_string(),
        })?;

    if idx >= prefs.rules.len() {
        return Err(ContractError::RuleIndexOutOfBounds {
            index: idx,
            length: prefs.rules.len(),
        });
    }

    prefs.rules.remove(idx);
    prefs.updated_at = env.block.time.seconds();

    PREFERENCES.save(deps.storage, owner, &prefs)?;

    let event = Event::new("wasm-chi")
        .add_attribute("action", "remove_rule")
        .add_attribute("owner", owner.to_string())
        .add_attribute("removed_index", index.to_string());

    Ok(Response::new().add_event(event))
}

fn execute_block_sender(
    deps: DepsMut,
    info: MessageInfo,
    pattern: String,
) -> Result<Response, ContractError> {
    if pattern.is_empty() {
        return Err(ContractError::EmptyBlocklistPattern {});
    }

    let owner = &info.sender;

    // Check current blocklist size (iterate prefix)
    let count = BLOCKLIST
        .prefix(owner)
        .range(deps.storage, None, None, cosmwasm_std::Order::Ascending)
        .count();

    if count >= MAX_BLOCKLIST {
        return Err(ContractError::BlocklistTooLarge { max: MAX_BLOCKLIST });
    }

    BLOCKLIST.save(deps.storage, (owner, &pattern), &true)?;

    let event = Event::new("wasm-chi")
        .add_attribute("action", "block_sender")
        .add_attribute("owner", owner.to_string())
        .add_attribute("pattern", &pattern);

    Ok(Response::new().add_event(event))
}

fn execute_unblock_sender(
    deps: DepsMut,
    info: MessageInfo,
    pattern: String,
) -> Result<Response, ContractError> {
    if pattern.is_empty() {
        return Err(ContractError::EmptyBlocklistPattern {});
    }

    let owner = &info.sender;
    BLOCKLIST.remove(deps.storage, (owner, &pattern));

    let event = Event::new("wasm-chi")
        .add_attribute("action", "unblock_sender")
        .add_attribute("owner", owner.to_string())
        .add_attribute("pattern", &pattern);

    Ok(Response::new().add_event(event))
}

fn execute_delete_preferences(
    deps: DepsMut,
    info: MessageInfo,
) -> Result<Response, ContractError> {
    let owner = &info.sender;

    if PREFERENCES.may_load(deps.storage, owner)?.is_none() {
        return Err(ContractError::PreferencesNotFound {
            address: owner.to_string(),
        });
    }

    PREFERENCES.remove(deps.storage, owner);

    let event = Event::new("wasm-chi")
        .add_attribute("action", "delete_preferences")
        .add_attribute("owner", owner.to_string());

    Ok(Response::new().add_event(event))
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetPreferences { address } => {
            to_json_binary(&query_get_preferences(deps, address)?)
        }
        QueryMsg::CheckPermission {
            sender_did,
            sender_type,
            recipient,
            intent,
        } => to_json_binary(&query_check_permission(
            deps,
            env,
            sender_did,
            sender_type,
            recipient,
            intent,
        )?),
        QueryMsg::IsBlocked {
            sender_pattern,
            recipient,
        } => to_json_binary(&query_is_blocked(deps, sender_pattern, recipient)?),
        QueryMsg::GetRules { address } => to_json_binary(&query_get_rules(deps, address)?),
    }
}

// ---------------------------------------------------------------------------
// Query handlers
// ---------------------------------------------------------------------------

fn query_get_preferences(deps: Deps, address: String) -> StdResult<PreferencesResponse> {
    let addr = deps.api.addr_validate(&address)?;
    let prefs = PREFERENCES.load(deps.storage, &addr)?;
    Ok(PreferencesResponse {
        owner: prefs.owner.to_string(),
        rules: prefs.rules,
        default_policy: prefs.default_policy,
        webhook_url: prefs.webhook_url,
        updated_at: prefs.updated_at,
    })
}

fn query_check_permission(
    deps: Deps,
    env: Env,
    sender_did: String,
    sender_type: crate::state::EntityType,
    recipient: String,
    intent: crate::state::Intent,
) -> StdResult<PermissionResponse> {
    let recipient_addr = deps.api.addr_validate(&recipient)?;
    check_permission(deps, &env, &sender_did, &sender_type, &recipient_addr, &intent)
}

fn query_is_blocked(
    deps: Deps,
    sender_pattern: String,
    recipient: String,
) -> StdResult<IsBlockedResponse> {
    let recipient_addr = deps.api.addr_validate(&recipient)?;

    // Check global blocklist AND per-rule blocklists across all rules.
    let globally = is_globally_blocked(deps, &recipient_addr, &sender_pattern)?;
    if globally {
        return Ok(IsBlockedResponse { blocked: true });
    }

    // Also check rule-level blocklists.
    let prefs = PREFERENCES.may_load(deps.storage, &recipient_addr)?;
    if let Some(p) = prefs {
        for rule in &p.rules {
            if is_pattern_blocked(&sender_pattern, &rule.blocklist) {
                return Ok(IsBlockedResponse { blocked: true });
            }
        }
    }

    Ok(IsBlockedResponse { blocked: false })
}

fn query_get_rules(deps: Deps, address: String) -> StdResult<RulesResponse> {
    let addr = deps.api.addr_validate(&address)?;
    let prefs = PREFERENCES.load(deps.storage, &addr)?;
    Ok(RulesResponse { rules: prefs.rules })
}
