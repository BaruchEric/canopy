---
version: alpha
name: Shared repo spec
colors:
  primary: "#3e7a38"
  primary-dark: "#93c98b"
  on-primary: "#ffffff"
  on-primary-dark: "#0c110d"
  secondary: "#2f7a99"
  secondary-dark: "#7fb4c9"
  surface: "#fafbf8"
  surface-dark: "#121a14"
  on-surface: "#232d20"
  on-surface-dark: "#dce5da"
  accent: "#a5762a"
  accent-dark: "#d9b36b"
  danger: "#a84e2f"
  danger-dark: "#c97b5f"
  border: "#d8dfd0"
  border-dark: "#33422e"
typography:
  display:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.15
  h1:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
  h2:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.3
  mono:
    fontFamily: JetBrains Mono, ui-monospace, Menlo, monospace
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: 4px
  md: 6px
  lg: 10px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 8px 12px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 8px 12px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: 8px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: 16px
  badge:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: 2px 8px
---

## Overview

Quiet, dense, readable tools. Plain surfaces, one green for the main action,
state shown by color and a word together. Light and dark themes are equal:
every color has a `-dark` pair, and the app follows the OS until the user picks.

## Colors

- `primary` is the one action that moves the screen forward. One per view.
- `secondary` marks information: links, selected rows, badges.
- `accent` marks warnings; `danger` only destructive actions and failures.
- `surface` and `on-surface` carry everything else; `border` separates.
- Text on any color meets WCAG AA (4.5:1 for body, 3:1 for large text).

## Typography

Inter for interface text, JetBrains Mono for code, paths, hashes and numbers
that line up. Six styles only: display, h1, h2, body, label and mono. Sentence
case everywhere, no all-caps headings.

## Layout

A 4px grid: every gap and padding is a spacing token. Content columns stay
under 72 characters of body text. Pages work from 360px wide upward; on
narrow screens, lists stack before anything scrolls sideways.

## Elevation & Depth

Flat by default. A popover, menu or sheet floats with one soft shadow and a
`border` edge; nothing else casts a shadow. No gradients on controls.

## Shapes

`sm` for inputs and badges, `md` for buttons, `lg` for cards and sheets. No
fully round controls except avatars and status dots.

## Components

- Buttons: a label, never an icon alone; 32px tall, 44px on touch screens.
- `input`: the label sits above it, the error below it in `danger`.
- `card`: one subject per card, its title in `h2`, actions on the bottom row.
- `badge`: a short word or a count, never a sentence.

## Do's and Don'ts

- Do use the CSS variables from `design.md export --format css-tailwind`.
- Don't hard-code a hex value in new UI.
- Do pair every state color with a word or an icon, for color-blind readers.
- Don't add a second primary button to a view.
- Do support light and dark from the first commit of a screen.
- Don't add a new font, color or radius here without a version bump.
- Do keep focus rings visible on every interactive element.
- Don't restyle existing screens unless the task asks for it.
- Do use the mono style for paths, ids and hashes.
- Don't animate longer than 200ms, and honor reduced motion.
