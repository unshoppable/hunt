//! The Claude agent: its ACP connection (`acp/`), the accounts and plan usage it runs with, Claude Code's configuration
//! folder (`claude_config.rs`), the Chrome its Playwright tools drive and the app pages it opens, the repository's
//! guardrail skill and declined guardrails, the guardrails and the text in its context window, and the skills of its swf steps.

pub mod accounts;
pub mod acp;
pub mod app_pages;
pub mod browser;
pub mod claude_config;
pub mod context_parts;
pub mod declined_guardrails;
pub mod guardrail_skill;
pub mod loaded_context;
pub mod plan_usage;
pub mod swf_skills;
