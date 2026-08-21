# RED-101 Design QA

## Comparison target

- Source visual truth: docs/product/main-menu-screenprint-reference-v1.png
- Rendered implementation: output/playwright/13-post-rebase-final-1280x800.jpg
- Responsive evidence: output/playwright/14-post-rebase-final-960x640.jpg
- Mode chooser evidence: output/playwright/16-post-rebase-mode-chooser-1280x800.jpg
- Final side-by-side comparison: output/playwright/15-post-rebase-reference-vs-implementation.jpg
- State: local identity named “玩家”, default local rating ELO 1200, no local match records, main menu at rest.

## Normalization

- Source pixels: 1586 × 992 (16:10).
- Implementation pixels: 1280 × 800.
- CSS viewport: 1280 × 800; Playwright screenshot scale: CSS; device scale factor: 1.
- The source was downsampled to 1280 × 800 with high-quality bicubic interpolation before being placed beside the implementation. No browser chrome or device frame was included.
- Responsive verification used a 960 × 640 CSS viewport and produced a 960 × 640 screenshot. The measured document scroll size was exactly 960 × 640.

## Full-view comparison evidence

output/playwright/15-post-rebase-reference-vs-implementation.jpg places the normalized source and final implementation in the same image. The comparison confirms the same major composition: oversized distressed RED/VS/BLUE title, left red-and-black sword mass, central paper opening, red-versus-blue chess conflict with yellow impact color on the right, red primary action, four vertically grouped modes, lower secondary navigation, and an upper-right account stamp.

Focused crops were not required because the combined image keeps each side at a readable 1280 × 800. The account stamp, primary menu typography, footer labels, ink texture, and illustration edges remain legible at that size. The separate mode-chooser capture verifies the most important non-resting state.

## Required fidelity surfaces

- Fonts and typography: the static title is a real raster screenprint asset rather than a code approximation. Live Chinese labels use the existing system Chinese stack with heavy optical weights, compact line height, and the same hierarchy as the source. No actionable wrapping or truncation was found at either viewport.
- Spacing and layout rhythm: title, account stamp, main actions, footer navigation, and opposing illustration occupy the same visual zones as the source. The 960 × 640 capture has no overlap, clipping, horizontal scroll, or vertical scroll.
- Colors and visual tokens: cream paper, brick red, cobalt blue, deep navy/black, and sparse yellow impact rays match the selected direction. There are no gradients, glass surfaces, or dark web-dashboard containers on the main screen.
- Image quality and asset fidelity: the background and account avatar are real raster assets. Both preserve distressed silkscreen edges and paper texture without CSS art, inline SVG, emoji, placeholder shapes, visible seams, or stretch artifacts.
- Copy and content: “开始游戏 / 本地联机 / 单人练习 / 训练营 / 图鉴 / 战绩 / 更多” match the approved menu. The account stamp visibly includes player name, ELO 1200, and “账号设置”. Dynamic names and ratings remain connected to the existing identity and records logic.

## Interaction and browser evidence

- “开始游戏” opens a light screenprint mode chooser with local, server, and single-player choices.
- Keyboard sequence Tab → Enter selected local play and opened localPlayOverlay.
- Escape closed the chooser and returned focus to playMenuBtn; no menu overlay remained open.
- The account stamp opened the existing identity sheet and returned focus to userPill after close.
- “更多” exposed only server settings and resource-pack management; the forbidden PVP debugger entry was not restored.
- The browser reported one favicon/script 404 in both the pre-change baseline and final capture. No new console error or warning was introduced by RED-101.

## Comparison history

### Iteration 1 — blocked

- [P1][imagery] The first implementation used a softer chess-and-cards composition and omitted the source's black cut-paper masses and yellow impact rays.
- [P2][layout] Main navigation and the account stamp were positioned as a new composition instead of matching the source zones.
- Evidence: output/playwright/05-reference-vs-implementation-1280x800.jpg.
- Fixes: regenerated the background from the reference comparison, restored the black/red edge silhouettes and yellow conflict rays, moved the live menu and account stamp into the source-aligned paper openings, restored the solid red primary action, and added a real screenprint avatar asset.

### Iteration 2 — passed

- Post-fix evidence: output/playwright/15-post-rebase-reference-vs-implementation.jpg.
- The earlier P1/P2 findings are resolved. No actionable P0/P1/P2 mismatch remains.

## Findings

- No actionable P0, P1, or P2 finding remains.
- [P3][polish] The live account stamp omits the source's decorative dashed divider and chevron so that dynamic account content remains simpler and more robust.
- [P3][polish] Footer separators are represented by spacing rather than printed dots. This does not change hierarchy, meaning, or interaction.

## Open questions

- Final product taste remains a human acceptance decision; the implementation intentionally preserves dynamic identity content instead of baking the reference player's name into the raster.

## Implementation checklist

- [x] Reference and implementation normalized and compared in one image.
- [x] 1280 × 800 main state captured.
- [x] 960 × 640 no-scroll state captured.
- [x] Primary chooser and keyboard path verified.
- [x] Account settings visibility and focus return verified.
- [x] Five required fidelity surfaces reviewed.
- [x] Earlier P1/P2 findings fixed and re-compared.

final result: passed