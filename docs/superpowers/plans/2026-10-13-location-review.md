# Address assistance without LLM Implementation Plan

> **For agentic workers:** Use executing-plans for workbench integration and focused parallel workers for independent backend/component tasks. Steps use checkbox syntax.

**Goal:** Turn address correction into an inline, evidence-backed review: local match → optional map candidates → linked jurisdiction/grid/community → human confirmation or recorded deferral.
**Architecture:** Reuse authorized location options and existing atomic location save/version checks. Deterministic matching produces suggestions only; existing map search remains a candidate provider. New intake generates correction tasks transactionally. Deferral records a reason without confirming fields.
**Tech Stack:** TypeScript, Express/MySQL, React/AntD, existing Tianditu integration.
**Spec:** User-approved conversation design (2026-10-13): no LLM, no AI claims, preserve genuine uncertainty, simplify routine confirmation and automatically retain the existing final-result admission gate.

## Global Constraints
- Preserve user edits; no blind candidate adoption or guessed coordinates/grid codes.
- Existing final reporting approval + result verification + all corrections remain mandatory for analysis admission.
- Scope/permission/version checks stay server authoritative. No raw complaint body/contact details sent to map services.
- No guessed street master data. Existing township clues are evidence, not fabricated canonical relationships.
- Keep unrelated seven pending UI edits; touched existing correction files incorporate only compatible changes.
- Deployment authorized by user; use map-aware production build and rollback-capable release.

## Review Focus
- Ambiguous residences vs incident locations: require explicit choice.
- Same-name communities and conflicting districts: never silently pick the first.
- New location with old coordinates: clear stale coordinate association.
- Actor/complaint switches during async lookup or saving: ignore stale completion.
- Deferral/repeated intake: never confirm or reset manually verified fields.

### Task 1: Backend lifecycle (parallel worker)
Files: intake services, correctionService/routes/permission registry, focused server tests.
Interfaces: POST /complaints/:idOrNo/location-corrections/defer {expectedVersion,basis} -> {version}; confirmLocationGroup adds analysisReason.
- [ ] Write failing tests for auto tasks, duplicate protection, scoped/versioned deferral.
- [ ] Implement within existing transactions without schema changes where possible.
- [ ] Run relevant server and MySQL regressions.

### Task 2: Inline location review (parallel worker)
Files: LocationReviewPanel.tsx, locationSuggestions.ts, TiandituLocationPicker.tsx, new web tests.
Interfaces: props detail,items,disabled,onSaved(result,next),onDeferred(next); existing options/save APIs plus defer API.
- [ ] Write failing matcher and UI tests for ambiguity, association, stale draft and external query boundaries.
- [ ] Implement named choices, optional map search, advanced coordinate fold, confirmation and deferral.
- [ ] Run component tests and typecheck.

### Task 3: Workbench integration (parent)
Files: AddressCorrection.tsx, corrections.ts, types/locationCorrection.ts, MainLayout labels, workbench tests.
- [ ] Add regression proving inline review, no second modal, actionable next navigation, maintenance collapsed.
- [ ] Replace legacy position modal with LocationReviewPanel; refresh current data and choose actual next queue item only after successful save/defer.
- [ ] Show accurate admission reason, preserve other corrections; isolate state by actor.
- [ ] Run integration/navigation/authorization regressions.

### Task 4: Verification and deployment
- [ ] Independent review and fix substantive findings.
- [ ] Backend tests/typecheck, clean frontend production build with existing map configuration, browser fixture QA.
- [ ] Deploy server through existing tested container workflow plus frontend, health/API/resource checks and record revision.
