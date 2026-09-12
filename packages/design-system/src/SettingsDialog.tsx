import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, Select } from "./index";

export type ThemePreference = "system" | "light" | "dark";

export interface SettingsSection {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  content: ReactNode;
}

export interface SettingsLabels {
  title: string;
  close: string;
  general: string;
  generalDescription: string;
  development: string;
  developmentDescription: string;
  language: string;
  languageDescription: string;
  theme: string;
  themeDescription: string;
  system: string;
  light: string;
  dark: string;
  automatic: string;
  saving: string;
  saveFailed: string;
}

function SettingsIcon({ kind = "settings" }: { kind?: "settings" | "code" | "close" }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "close" ? <path d="m6 6 12 12M6 18 18 6" /> : kind === "code" ? <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /> : <>
        <path d="M9.5 3h5l.6 2.4 2 .9 2.2-.7 2.5 4.3-1.7 1.8v2.3l1.7 1.8-2.5 4.3-2.2-.7-2 .9-.6 2.4h-5l-.6-2.4-2-.9-2.2.7-2.5-4.3 1.7-1.8v-2.3L1.8 9.9l2.5-4.3 2.2.7 2-.9Z" transform="translate(1 0) scale(.92)" />
        <circle cx="12" cy="12" r="3" />
      </>}
    </svg>
  );
}

/** Mount only while open. Native dialog supplies inert background and focus containment. */
export function SettingsDialog({ title, closeLabel, sections, onClose }: {
  title: string;
  closeLabel: string;
  sections: readonly SettingsSection[];
  onClose: () => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [activeId, setActiveId] = useState(sections[0]?.id);
  const active = sections.find((section) => section.id === activeId) ?? sections[0];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <dialog
      className="settings-dialog"
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex], [contenteditable="true"]',
        )).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      <div className="settings-layout">
        <header className="settings-header">
          <h2 id={`${id}-title`}>{title}</h2>
          <Button variant="ghost" iconOnly aria-label={closeLabel} onClick={onClose} autoFocus>
            <SettingsIcon kind="close" />
          </Button>
        </header>
        <nav className="settings-nav" aria-label={title}>
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              aria-current={section.id === active?.id ? "page" : undefined}
              aria-controls={`${id}-content`}
              onClick={() => setActiveId(section.id)}
            >
              {section.icon}
              <span>{section.label}</span>
            </button>
          ))}
        </nav>
        <section className="settings-content" id={`${id}-content`} aria-labelledby={`${id}-section`}>
          <div className="settings-section-heading">
            <h3 id={`${id}-section`}>{active?.label}</h3>
            {active?.description && <p>{active.description}</p>}
          </div>
          {sections.map((section) => (
            <div key={section.id} hidden={section.id !== active?.id}>
              <VisitedSection active={section.id === active?.id}>{section.content}</VisitedSection>
            </div>
          ))}
        </section>
      </div>
    </dialog>,
    document.body,
  );
}

// Keep form drafts when navigating sections, but do not initialize development tools on open.
function VisitedSection({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  return active || visited ? children : null;
}

export function SettingsRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <span>{label}</span>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** Controlled host adapter: storage, identity and API credentials stay outside the design system. */
export interface ApplicationSettingsProps<Locale extends string> {
  labels: SettingsLabels;
  locale: Locale;
  locales: readonly { value: Locale; label: string }[];
  onLocaleChange: (locale: Locale) => void | Promise<void>;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void | Promise<void>;
  development?: ReactNode;
  sections?: readonly SettingsSection[];
  compact?: boolean;
}

export function ApplicationSettings<Locale extends string>({
  labels, locale, locales, onLocaleChange, theme, onThemeChange,
  development, sections = [], compact = false,
}: ApplicationSettingsProps<Locale>) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const saving = useRef(false);

  async function changePreference(save: () => void | Promise<void>) {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setFailed(false);
    try {
      await save();
    } catch {
      setFailed(true);
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  const general = <>
    <SettingsRow label={labels.theme} description={labels.themeDescription}>
      <Select
        aria-label={labels.theme}
        value={theme}
        disabled={pending}
        onChange={(event) => {
          const value = event.target.value as ThemePreference;
          void changePreference(() => onThemeChange(value));
        }}
      >
        <option value="system">{labels.system}</option>
        <option value="light">{labels.light}</option>
        <option value="dark">{labels.dark}</option>
      </Select>
    </SettingsRow>
    <SettingsRow label={labels.language} description={labels.languageDescription}>
      <Select
        aria-label={labels.language}
        value={locale}
        disabled={pending}
        onChange={(event) => {
          const value = event.target.value as Locale;
          void changePreference(() => onLocaleChange(value));
        }}
      >
        {locales.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </Select>
    </SettingsRow>
    <p className={failed ? "settings-feedback field-error" : "settings-feedback"} role={failed ? "alert" : "status"}>
      {failed ? labels.saveFailed : pending ? labels.saving : labels.automatic}
    </p>
  </>;

  return <>
    <Button
      className="settings-trigger"
      variant="ghost"
      aria-label={labels.title}
      aria-haspopup="dialog"
      onClick={() => { setFailed(false); setOpen(true); }}
    >
      <SettingsIcon />
      {!compact && <span>{labels.title}</span>}
    </Button>
    {open && (
      <SettingsDialog
        title={labels.title}
        closeLabel={labels.close}
        onClose={() => setOpen(false)}
        sections={[
          { id: "general", label: labels.general, description: labels.generalDescription, icon: <SettingsIcon />, content: general },
          ...sections,
          ...(development ? [{ id: "development", label: labels.development, description: labels.developmentDescription, icon: <SettingsIcon kind="code" />, content: development }] : []),
        ]}
      />
    )}
  </>;
}
