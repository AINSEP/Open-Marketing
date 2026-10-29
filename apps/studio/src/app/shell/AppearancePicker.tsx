import type { useAppearance } from "../../shared/ui/index.js";
import { ACCENTS } from "../../themes/registry.js";

type Appearance = ReturnType<typeof useAppearance>;

/** One device-local picker; native radios provide focus, arrow keys and checked semantics. */
export function AppearancePicker(props: { appearance: Appearance }) {
  return <section className="settings-card appearance-card" aria-labelledby="appearance-heading">
    <span className="eyebrow">DEVICE PREFERENCES</span><h2 id="appearance-heading">Appearance</h2>
    <fieldset style={{ display: "flex", flexWrap: "wrap", gap: 12, border: 0, padding: 0, minWidth: 0 }}>
      <legend>Theme</legend>
      <ThemeChoice appearance={props.appearance} theme={props.appearance.themes[0]} />
      <ThemeChoice appearance={props.appearance} theme={props.appearance.themes[1]} />
      <ThemeChoice appearance={props.appearance} theme={props.appearance.themes[2]} />
      <ThemeChoice appearance={props.appearance} theme={props.appearance.themes[3]} />
      <ThemeChoice appearance={props.appearance} theme={props.appearance.themes[4]} />
      <ThemeChoice appearance={props.appearance} theme={props.appearance.themes[5]} />
    </fieldset>
    <div className="appearance-control"><label htmlFor="appearance-mode">Appearance</label>
      <select data-agent-element="appearance-mode" data-agent-role="field" data-agent-label="Appearance" id="appearance-mode" value={props.appearance.preference} onChange={props.appearance.change}>
        <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select></div>
    <p className="muted">System follows your device’s light or dark appearance.</p>
    <fieldset style={{ display: "flex", flexWrap: "wrap", gap: 16, border: 0, padding: 0, minWidth: 0 }}>
      <legend>Accent</legend>
      <AccentChoice appearance={props.appearance} choice={ACCENTS.default} />
      <AccentChoice appearance={props.appearance} choice={ACCENTS.green} />
      <AccentChoice appearance={props.appearance} choice={ACCENTS.blue} />
      <AccentChoice appearance={props.appearance} choice={ACCENTS.violet} />
    </fieldset>
  </section>;
}

/** Preview colours are registry samples, never style values from storage or user input. */
function ThemeChoice(props: { appearance: Appearance; theme: Appearance["themes"][number] }) {
  return <label style={{ display: "grid", gap: 8, padding: 12, borderRadius: "var(--jini-radius-sm)", border: "1px solid var(--jini-control-border)", cursor: "pointer" }}>
    <span aria-hidden="true" data-theme-preview={props.theme.id} data-scheme={props.appearance.scheme} style={{ display: "block", width: 120, height: 64, padding: 8, borderRadius: "var(--jini-radius-sm)", background: props.theme.preview[props.appearance.scheme].bg }}>
      <span style={{ display: "block", height: "100%", padding: 8, borderRadius: "var(--jini-radius-sm)", background: props.theme.preview[props.appearance.scheme].panel, color: props.theme.preview[props.appearance.scheme].text }}>
        <span style={{ display: "block", width: "65%", height: 3, background: "currentColor", marginBottom: 8 }} />
        <span style={{ display: "block", width: 18, height: 18, borderRadius: "var(--jini-radius-pill)", background: ACCENTS[props.appearance.accents[props.theme.id] ?? "default"].swatch[props.appearance.scheme] ?? props.theme.preview[props.appearance.scheme].accent }} />
      </span>
    </span>
    <span><input type="radio" name="admin-theme" value={props.theme.id} checked={props.appearance.theme === props.theme.id} onChange={props.appearance.changeTheme}
      data-agent-element={"appearance-theme-" + props.theme.id} data-agent-role="field" data-agent-label={props.theme.label + " theme"} /> {props.theme.label}</span>
  </label>;
}

/** Dots accompany visible names and native checked indicators; colour is never the only cue. */
function AccentChoice(props: { appearance: Appearance; choice: (typeof ACCENTS)[keyof typeof ACCENTS] }) {
  return <label style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 44, cursor: "pointer" }}>
    <input type="radio" name="admin-accent" value={props.choice.id} checked={props.appearance.accent === props.choice.id} onChange={props.appearance.changeAccent}
      data-agent-element={"appearance-accent-" + props.choice.id} data-agent-role="field" data-agent-label={props.choice.label + " accent"} />
    <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: "var(--jini-radius-pill)", border: "1px solid var(--jini-control-border)", background: props.choice.swatch[props.appearance.scheme] ?? `var(--jini-theme-${props.appearance.scheme}-primary)` }} />{props.choice.label}
  </label>;
}
