# Shared settings experience

The web, extension dashboard and extension popup use one settings experience from `@denicheur-breizh/design-system`. New pages and applications must reuse it. This is the product baseline for the next application iteration, including a possible microfrontend.

## Product rules

- One Settings entry in the application header opens a modal. Global language and appearance controls belong inside it.
- General contains appearance (System, Light, Dark) and language (Français, Español, English). Preferences apply immediately and save automatically; failed saves must be reported in the modal.
- Development contains connection configuration and diagnostics. Healthy API badges, connection tooltips and technical configuration do not occupy the everyday header. Errors that affect a user action, collection progress and pending synchronization remain visible where they matter.
- The desktop modal uses section navigation on the left. Small screens and extension popups use a horizontal section list and independently scrolling content. Close remains reachable. Escape and backdrop clicks close the modal; focus stays inside while open and returns to its trigger after closing.
- Forms retain their drafts when changing sections. Closing the modal discards unsaved connection drafts. API settings keep an explicit Save action, distinct from automatic preference saving.
- All copy is localized; appearance uses the shared design tokens and respects the chosen theme. Do not add inactive account, billing or sign-out controls before those capabilities exist.

## Extension points

`ApplicationSettings` provides the entry button, General section and optional Development section. Hosts supply controlled `locale`, `theme`, change handlers, `locales`, shared `SETTINGS_LABELS[locale]`, and app-specific development content. Its `sections: SettingsSection[]` prop accepts additional sections with stable IDs, localized labels, optional icons/descriptions and content.

`SettingsDialog` and `SettingsRow` are the lower-level primitives. They have no dependencies on routing, Chrome APIs, Zustand, authentication or backend credentials. A host imports `@denicheur-breizh/design-system/styles.css` once. The native HTML dialog handles modal focus containment and background interactivity; see the [dialog reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog).

When user management arrives, the authenticated host can expose Settings from its account menu and add a real Account section. The host owns identity, permissions and sign-out. The shared settings UI must never infer an authenticated user or treat Development visibility as authorization.

For a microfrontend composed in the same page, the host owns one settings modal and passes preferences/change handlers to child applications. Children contribute sections instead of mounting competing global dialogs or writing their own preference stores. Keep React and design tokens shared at the host boundary. This pattern does not require adopting a microfrontend runtime now.

For separate origins, preferences currently remain local to each origin. Web preferences use localStorage (`denicheur:workspace`, existing version 2, and `denicheur:locale`); explicit saved light/dark choices remain compatible. Extension theme uses `chrome.storage.sync` and language uses `chrome.storage.local`, with existing listeners synchronizing popup and dashboard. Web and extension do not claim cross-origin/account synchronization. An eventual account preference service should be supplied through these same host adapters, with explicit migration and conflict rules.

## Verification

`tests/e2e/web/settings.spec.ts` covers keyboard containment, Escape/backdrop, focus restoration, system appearance changes, persistence, cross-tab updates and small viewports. `tests/e2e/extension/settings.spec.ts` covers popup/dashboard appearance sync and API draft preservation inside the modal. Existing locale and dashboard regression suites exercise the new entry path. Run `pnpm check` and `pnpm test:e2e` before publishing changes.
