//! What the test files share: a clock a test moves by hand and a scratch
//! folder for callers.json.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use canopy_auth::{CallerBook, Clock};
use tempfile::TempDir;

pub const MIN: i64 = 60 * 1000;
pub const DAY: i64 = 24 * 60 * MIN;

/// A clock that reads `t`, which the test moves.
#[derive(Clone)]
pub struct Time(Arc<AtomicI64>);

impl Time {
    pub fn at(ms: i64) -> Time {
        Time(Arc::new(AtomicI64::new(ms)))
    }
    pub fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    pub fn set(&self, ms: i64) {
        self.0.store(ms, Ordering::SeqCst);
    }
    pub fn add(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
    pub fn clock(&self) -> Clock {
        let t = self.0.clone();
        Arc::new(move || t.load(Ordering::SeqCst))
    }
}

/// A scratch folder holding callers.json, and the clock its books run on.
pub struct Scratch {
    pub dir: TempDir,
    pub file: PathBuf,
    pub t: Time,
}

impl Scratch {
    pub fn new() -> Scratch {
        let dir = tempfile::Builder::new()
            .prefix("canopy-callers-")
            .tempdir()
            .unwrap();
        let file = dir.path().join("callers.json");
        Scratch {
            dir,
            file,
            t: Time::at(1_000_000),
        }
    }

    /// a book on this folder's file, as `new CallerBook({ file, now })`
    pub fn open(&self) -> Arc<CallerBook> {
        Arc::new(CallerBook::open_with_clock(&self.file, self.t.clock()))
    }
}
