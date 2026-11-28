//! What a backend verb prints, kept until it ends: its stdout as
//! `console.log` and `process.stdout.write` wrote it, and whether it set
//! `process.exitCode = 1` without a failure line. A verb returns
//! `Err(words)` for its `fail()`; main prints the stdout first and then
//! the failure, the order the TypeScript's own end leaves them in.

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Out {
    pub text: String,
    /// `process.exitCode = 1`: exit 1 with no failure line
    pub failed: bool,
}

impl Out {
    /// `console.log(s)`.
    pub fn line(&mut self, s: impl AsRef<str>) {
        self.text.push_str(s.as_ref());
        self.text.push('\n');
    }

    /// `console.log` for each line.
    pub fn lines<S: AsRef<str>>(&mut self, lines: impl IntoIterator<Item = S>) {
        for l in lines {
            self.line(l);
        }
    }

    /// `process.stdout.write(s)`: no newline added.
    pub fn write(&mut self, s: &str) {
        self.text.push_str(s);
    }

    /// The printed lines, for a test.
    #[cfg(test)]
    pub fn printed(&self) -> Vec<&str> {
        self.text.lines().collect()
    }
}
