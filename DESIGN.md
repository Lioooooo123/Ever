# Karissa TUI design system

## 1. Visual Theme and Atmosphere

Karissa is a calm, dark operations console for long-horizon coding work. It uses an ink-black canvas, warm coral state signals, compact information density, and explicit runtime language instead of decorative panels.

## 2. Color Palette and Roles

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| Canvas | `#11100f` | `#f8f8f8` | Terminal and exported page ground |
| Surface | `#191716` | `#ffffff` | Elevated transcript surface |
| Accent | `#ff7a66` | `#b94f3e` | Karissa identity, active state, cursor |
| Accent bright | `#ff9a87` | `#d66b58` | Focused border and high-priority state |
| Text | `#e8e3df` | `#1f2328` | Primary copy |
| Muted | `#99918c` | `#6c6c6c` | Metadata and secondary copy |
| Success | `#8fbf9f` | `#588458` | Settled and verified states |
| Warning | `#d8ad62` | `#9a7326` | Retry, budget, and deadline pressure |
| Error | `#ef6f6c` | `#aa5555` | Failure and unknown outcome |

## 3. Typography Rules

Use the terminal's configured monospace face. The hierarchy comes from weight, case, and spacing: `KARISSA` is bold uppercase, runtime states are uppercase labels, body copy is sentence case, and metadata stays regular or dim. Do not use ASCII art as the primary wordmark.

## 4. Component Stylings

- Header: `KARISSA / RUNTIME`, version, and current `TASK` or `SESSION` scope on one scan line.
- Editor: existing square terminal frame, coral for active focus, semantic warning and error colors for constrained states.
- Status: compact state prefix such as `RUNNING`, `RETRY`, `CHECKPOINT`, or `BRANCH`, followed by the actionable detail.
- Footer: scope and workspace first, usage and model second. No card shell.
- Selectors: coral arrow and text for the selected row, neutral text otherwise.
- Tool execution: neutral pending surface, green settled surface, red failed surface.

## 5. Layout Principles

Use the existing character-cell grid and a one-cell spacing rhythm. Orient first, show state second, enable action third. The transcript owns flexible height; editor and footer remain compact. The interface must remain legible at 80 by 24 cells.

## 6. Depth and Elevation

Depth uses background steps, not shadows. The dark canvas is `#11100f`, standard surfaces are `#191716`, pending tool surfaces are `#252322`, and focused selection is `#332a29`. Borders are reserved for focus, dialogs, and execution boundaries.

## 7. Do's and Don'ts

- Do make Task identity visible whenever a durable Task is active.
- Do distinguish settled, waiting, paused, failed, and unknown states by text as well as color.
- Do keep keyboard actions immediate and animation-free.
- Do preserve information density for senior developers.
- Do use warm coral only for identity and active state.
- Don't use purple, cyan, gradients, glass, or decorative card grids.
- Don't hide critical state behind icons or color alone.
- Don't animate routine key presses or editor actions.
- Don't expose lease, fencing, and reservation internals in the default surface.

## 8. Responsive Behavior

The primary target is 80 by 24 cells. At narrow widths, truncate the workspace and model before Task identity or safety state. Expanded startup help collapses to one command line. Footer metrics may drop from right to left, while the current scope remains visible.

## 9. Agent Prompt Guide

Quick reference: canvas `#11100f`, surface `#191716`, accent `#ff7a66`, accent bright `#ff9a87`, text `#e8e3df`, muted `#99918c`, success `#8fbf9f`, warning `#d8ad62`, error `#ef6f6c`.

- "Add a Karissa Task status row on canvas `#11100f`, one-cell horizontal padding, bold uppercase state in `#ff7a66`, sentence-case detail in `#99918c`, and no animation."
- "Create an 80-cell runtime header with `KARISSA` bold in `#ff7a66`, `/ RUNTIME` in `#6f6966`, and `[TASK abc12345]` in `#8fbf9f`; keep it to one line."
- "Build a fail-closed warning panel using a one-cell border in `#d8ad62`, body text `#e8e3df`, no shadow, no rounded treatment, and an explicit recovery command."
- "Add a settled checkpoint indicator with `CHECKPOINT` in `#8fbf9f`, metadata in `#99918c`, one-line height, and no motion."

## 10. Task Home

The no-argument entry is the night-shift control surface, not an empty chat. Its first three lines are `KARISSA / NIGHT SHIFT`, active and total Task counts, and one sentence explaining the next action. The queue follows immediately without cards.

- Put `NEW TASK` first, durable Task rows second, then `REFRESH` and `QUIT`.
- Format each Task row as state, eight-character Task ID, then a one-line title.
- Preserve Task state and ID before truncating the title.
- Open a selected Task into a small action menu. Destructive cancellation must remain explicit.
- Closing the TUI never cancels a Worker. Detach and cancel are separate actions.
