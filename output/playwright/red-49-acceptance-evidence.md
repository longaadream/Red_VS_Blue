# RED-49 UI acceptance evidence

Validated on 2026-08-16 with the local training page at a 1280×720 desktop viewport and an 844×390 landscape mobile viewport. The browser fixture used a 20×16 board, 16 visible pieces, and repeating 0/1/2/4-negative-status cases.

## Results

| Check | Result |
| --- | --- |
| Board summaries | 16/16 visible; status counts repeated as 0, 1, 2, 2 |
| Board status cap | Maximum 2 high-priority negative summaries |
| Empty-state spacing | The 0-status piece rendered no status dot |
| Crowded-board overlap | 0 intersecting summary pairs; maximum summary width 33 px |
| Selection/cancel | Board click selected red49-piece-3; second click cleared selection |
| Full selected detail | 4/4 visible statuses, including layers, remaining turns, and descriptions |
| Snapshot-driven update | 4 → 2 → 4 status rows; faction styling changed red → blue → red |
| Mobile landscape | 844×390; 16 summaries, maximum 2 board statuses, 4 selected-detail rows, 0 overlaps, and no horizontal overflow |
| Runtime | WebGL active; no new relevant console errors or page exceptions during the fixture |

The training route still reports its pre-existing missing local runtime/skill asset 404s before the fixture starts. The RED-49 interaction and snapshot cycle added no console error, warning, or uncaught exception.

At 844×390, the pre-existing training setup overlay cannot scroll its Start Training button into view. The battle fixture bypassed only that setup overlay before validating RED-49; track the setup-layout issue separately.

## Screenshots

- [Before — desktop 1280×720](red-49-before-desktop-1280x720.png)
- [After — crowded desktop 1280×720](red-49-after-desktop-1280x720.png)
- [After — selected detail modal 1280×720](red-49-status-detail-desktop-1280x720.png)
- [After — mobile landscape 844×390](red-49-after-mobile-844x390.png)

## Rollback

Revert the RED-49 visual commit. No game-rule, save-format, dependency, economy, or random-algorithm changes are included.
