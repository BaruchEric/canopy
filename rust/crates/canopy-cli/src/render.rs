//! The terminal's colours (`src/cli/render.ts`): canopy's palette, on when
//! stdout is a terminal and NO_COLOR is unset or empty, and Bun's red
//! `console.error` on stderr. Every verb paints through this one copy.

use canopy_core::treelines::{Seg, Tone};
use std::io::IsTerminal;

/// `useColor`: stdout is a terminal and NO_COLOR is unset or empty.
pub fn use_color() -> bool {
    std::io::stdout().is_terminal() && std::env::var("NO_COLOR").map_or(true, |v| v.is_empty())
}

/// render.ts's palette, painting or passing text through as `color` says.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Paint {
    pub color: bool,
}

impl Paint {
    fn wrap(&self, code: &str, s: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }

    pub fn moss(&self, s: &str) -> String {
        self.wrap("38;2;147;201;139", s)
    }

    pub fn lichen(&self, s: &str) -> String {
        self.wrap("38;2;217;179;107", s)
    }

    pub fn rust(&self, s: &str) -> String {
        self.wrap("38;2;201;123;95", s)
    }

    pub fn sky(&self, s: &str) -> String {
        self.wrap("38;2;127;180;201", s)
    }

    pub fn dim(&self, s: &str) -> String {
        self.wrap("2", s)
    }

    pub fn bold(&self, s: &str) -> String {
        self.wrap("1", s)
    }

    /// `TONES[tone](s)`.
    pub fn tone(&self, tone: Tone, s: &str) -> String {
        match tone {
            Tone::Moss => self.moss(s),
            Tone::Lichen => self.lichen(s),
            Tone::Rust => self.rust(s),
            Tone::Sky => self.sky(s),
            Tone::Dim => self.dim(s),
            Tone::Bold => self.bold(s),
        }
    }

    /// One of `paintLine()`'s segments: its tone, or its text as it is.
    pub fn seg(&self, seg: &Seg) -> String {
        match seg.tone {
            Some(t) => self.tone(t, &seg.text),
            None => seg.text.clone(),
        }
    }
}

/// `console.error(s)`: Bun paints a string red when stderr is a terminal
/// and NO_COLOR is unset or empty.
pub fn say_err(s: &str) {
    let red =
        std::io::stderr().is_terminal() && std::env::var("NO_COLOR").map_or(true, |v| v.is_empty());
    if red {
        eprintln!("\x1b[0m\x1b[31m{s}\x1b[0m");
    } else {
        eprintln!("{s}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_palette_paints_render_ts_colours_or_nothing() {
        let on = Paint { color: true };
        assert_eq!(on.moss("a"), "\x1b[38;2;147;201;139ma\x1b[0m");
        assert_eq!(on.tone(Tone::Dim, "a"), "\x1b[2ma\x1b[0m");
        assert_eq!(on.tone(Tone::Sky, "a"), "\x1b[38;2;127;180;201ma\x1b[0m");
        assert_eq!(Paint { color: false }.bold("a"), "a");
    }
}
