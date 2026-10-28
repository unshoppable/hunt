//! The Claude agent: its ACP connection (`acp/`), the accounts and plan usage it runs with, Claude Code's configuration
//! folder (`claude_config.rs`), the Chrome its Playwright tools drive, the repository's guardrail skill and declined
//! guardrails, and the skills of its swf steps.

pub mod accounts;
pub mod acp;
pub mod browser;
pub mod claude_config;
pub mod declined_guardrails;
pub mod guardrail_skill;
pub mod plan_usage;
pub mod swf_skills;
