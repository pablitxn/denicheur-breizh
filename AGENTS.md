# Shared application settings

When adding global preferences, an application shell, or a new app/microfrontend, read [the shared settings experience](docs/settings-experience.md) and preserve that product contract.

- Reuse `ApplicationSettings`, `SettingsDialog` and `SettingsRow` from `@denicheur-breizh/design-system`, with localized copy from `@denicheur-breizh/i18n`.
- Keep global appearance and language controls inside Settings. Put API configuration and technical diagnostics in Development. Keep actionable workflow errors and progress near the affected action.
- Extend the shared modal with sections instead of building another global settings surface. In a composed microfrontend, the host owns the modal and preference adapters.
- When accounts are implemented, connect real account state and actions to this pattern. Preserve the existing experience until those capabilities are available.
- Preserve keyboard access, focus restoration, small-screen layout, theme support and the existing preference storage keys when extending the UI.
