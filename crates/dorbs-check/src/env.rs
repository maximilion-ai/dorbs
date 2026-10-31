//! Where an environment is in its life: one repo at one recipe, key-file content and image, shared
//! by every thread on the repo, one run at a time.
//!
//! Absent → SettingUp → Ready ⇄ Busy; SettingUp → Failed; Ready ⇄ Idle, its container stopped;
//! Ready, Idle and Failed → Evicted; Failed and Evicted → SettingUp.

use serde::Serialize;

use crate::protocol::CommitSha;

/// Milliseconds since the Unix epoch.
pub type Millis = u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvState {
    Absent,
    SettingUp,
    Ready {
        tree: CommitSha,
        last_used: Millis,
    },
    Busy {
        tree: CommitSha,
        last_used: Millis,
    },
    Idle {
        tree: CommitSha,
        last_used: Millis,
    },
    Failed {
        step: String,
        output: String,
        at: Millis,
    },
    Evicted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvEvent {
    SetupStarted,
    SetupSucceeded {
        tree: CommitSha,
        at: Millis,
    },
    SetupFailed {
        step: String,
        output: String,
        at: Millis,
    },
    Acquired,
    /// A run ended; the tree is at `tree` again, with no change laid over it.
    Released {
        tree: CommitSha,
        at: Millis,
    },
    Stopped,
    Started,
    Evicted,
}

/// The state's name, as GET /environments lists it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Phase {
    Absent,
    SettingUp,
    Ready,
    Busy,
    Idle,
    Failed,
    Evicted,
}

impl EnvState {
    pub fn phase(&self) -> Phase {
        match self {
            EnvState::Absent => Phase::Absent,
            EnvState::SettingUp => Phase::SettingUp,
            EnvState::Ready { .. } => Phase::Ready,
            EnvState::Busy { .. } => Phase::Busy,
            EnvState::Idle { .. } => Phase::Idle,
            EnvState::Failed { .. } => Phase::Failed,
            EnvState::Evicted => Phase::Evicted,
        }
    }

    /// The commit the tree is at, while it has one.
    pub fn tree(&self) -> Option<&CommitSha> {
        match self {
            EnvState::Ready { tree, .. }
            | EnvState::Busy { tree, .. }
            | EnvState::Idle { tree, .. } => Some(tree),
            _ => None,
        }
    }

    /// When a run last used it; failed and absent environments go first when room is needed.
    pub fn last_used(&self) -> Millis {
        match self {
            EnvState::Ready { last_used, .. }
            | EnvState::Busy { last_used, .. }
            | EnvState::Idle { last_used, .. } => *last_used,
            _ => 0,
        }
    }

    /// The state after `event`, or None for an event the state cannot take, which is a bug in the caller.
    pub fn after(&self, event: EnvEvent) -> Option<EnvState> {
        use EnvState as S;
        Some(match (self, event) {
            (S::Absent | S::Failed { .. } | S::Evicted, EnvEvent::SetupStarted) => S::SettingUp,
            (S::SettingUp, EnvEvent::SetupSucceeded { tree, at }) => S::Ready {
                tree,
                last_used: at,
            },
            (S::SettingUp, EnvEvent::SetupFailed { step, output, at }) => {
                S::Failed { step, output, at }
            }
            (S::Ready { tree, last_used }, EnvEvent::Acquired) => S::Busy {
                tree: tree.clone(),
                last_used: *last_used,
            },
            (S::Busy { .. }, EnvEvent::Released { tree, at }) => S::Ready {
                tree,
                last_used: at,
            },
            (S::Ready { tree, last_used }, EnvEvent::Stopped) => S::Idle {
                tree: tree.clone(),
                last_used: *last_used,
            },
            (S::Idle { tree, last_used }, EnvEvent::Started) => S::Ready {
                tree: tree.clone(),
                last_used: *last_used,
            },
            (S::Ready { .. } | S::Idle { .. } | S::Failed { .. }, EnvEvent::Evicted) => S::Evicted,
            _ => return None,
        })
    }

    /// Moves to the state after `event`; panics on an event the state cannot take.
    pub fn take(&mut self, event: EnvEvent) {
        let described = format!("{:?} cannot take {event:?}", self.phase());
        *self = self
            .after(event)
            .unwrap_or_else(|| panic!("an environment in {described}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(c: char) -> CommitSha {
        CommitSha::try_from(c.to_string().repeat(40)).unwrap()
    }

    #[test]
    fn sets_up_serves_runs_one_at_a_time_idles_and_comes_back() {
        let mut state = EnvState::Absent;
        state.take(EnvEvent::SetupStarted);
        state.take(EnvEvent::SetupSucceeded {
            tree: sha('a'),
            at: 1,
        });
        assert_eq!(
            state,
            EnvState::Ready {
                tree: sha('a'),
                last_used: 1
            }
        );
        state.take(EnvEvent::Acquired);
        assert_eq!(
            state.after(EnvEvent::Acquired),
            None,
            "a second run waits for the first"
        );
        assert_eq!(
            state.after(EnvEvent::Evicted),
            None,
            "a held environment is not evicted"
        );
        state.take(EnvEvent::Released {
            tree: sha('b'),
            at: 5,
        });
        state.take(EnvEvent::Stopped);
        assert_eq!(
            state,
            EnvState::Idle {
                tree: sha('b'),
                last_used: 5
            }
        );
        state.take(EnvEvent::Started);
        assert_eq!(state.tree(), Some(&sha('b')));
    }

    #[test]
    fn keeps_a_failed_setup_and_sets_up_again_after_it_or_an_eviction() {
        let mut state = EnvState::SettingUp;
        state.take(EnvEvent::SetupFailed {
            step: "install".into(),
            output: "boom".into(),
            at: 3,
        });
        assert_eq!(state.phase(), Phase::Failed);
        assert_eq!(state.after(EnvEvent::Acquired), None);
        assert_eq!(
            state.clone().after(EnvEvent::SetupStarted),
            Some(EnvState::SettingUp)
        );
        state.take(EnvEvent::Evicted);
        state.take(EnvEvent::SetupStarted);
        assert_eq!(state, EnvState::SettingUp);
        assert_eq!(
            EnvState::SettingUp.after(EnvEvent::SetupStarted),
            None,
            "one setup at a time"
        );
    }
}
