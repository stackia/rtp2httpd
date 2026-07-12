---
name: design-system
description: Maintain the rtp2httpd Web UI design system. Always use when creating or editing UI components or visual UI elements in the status page or web player, and when changing themes, colors, glass materials, elevation, shadows, highlights, status semantics, or shared visual styling.
---

# Design System

Keep visual decisions shared across the status page and web player.

## Architecture

- Define theme primitives in `web-ui/src/index.css` under the light and dark theme scopes.
- Keep the status experience purple and the player experience blue through scoped theme primitives.
- Compose shared materials, levels, states, density, and semantic tone through `web-ui/src/lib/design-system.ts`.
- Compose shared utilities in components; keep component files focused on layout, content, and performance behavior.
- Treat material, spatial elevation, and semantic tone as separate decisions.

## Selection

- Use frost for persistent page structure, clear for nested or interactive content, and smoke over video.
- Use panel for major regions, inset for groups, tile for repeated units, bar for anchored strips, float for transient UI, and modal for blocking UI.
- Preserve Z-axis contrast: canvas is darkest, then panel, inset, tile, and raised content becomes progressively lighter.
- Use dense only when content must remain readable over a complex background.
- Use active only for the current selection or playback target; use semantic tone only to communicate status.
- Add scrims only behind blocking overlays. Source visual effects, interaction feedback, typography, and meters from the shared system.

## Workflow

1. Compose an existing material and level before extending the shared system.
2. Preserve both light and dark behavior and keep player overlays readable over video.
3. Add reusable visual decisions to the shared system; keep only geometry, dynamic values, and performance utilities local.
4. Keep state meaning independent from elevation; color must not be the only state cue.
5. Run the Web UI type check, formatter/linter, and production build after changes.
