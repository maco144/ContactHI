use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized: caller is not the preference owner")]
    Unauthorized {},

    #[error("Preferences not found for address: {address}")]
    PreferencesNotFound { address: String },

    #[error("Rule index out of bounds: index {index}, length {length}")]
    RuleIndexOutOfBounds { index: usize, length: usize },

    #[error("Invalid rate limit: count must be greater than zero")]
    InvalidRateLimit {},

    #[error("Invalid time window: start must be before end, hours 0-23, minutes 0-59")]
    InvalidTimeWindow {},

    #[error("Invalid webhook URL: must begin with https://")]
    InvalidWebhookUrl {},

    #[error("Blocklist pattern cannot be empty")]
    EmptyBlocklistPattern {},

    #[error("Preferences already exist for this address; use UpdatePreferences to modify")]
    PreferencesAlreadyExist {},

    #[error("Rules list exceeds maximum length of {max}")]
    TooManyRules { max: usize },

    #[error("Blocklist exceeds maximum size of {max} entries")]
    BlocklistTooLarge { max: usize },
}
