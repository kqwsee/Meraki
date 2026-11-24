import { THEMES, useTheme } from "../theme";
import { Icon } from "./Icon";

const themeOptions = Object.keys(THEMES) as (keyof typeof THEMES)[];

export default function ThemePicker() {
  const { theme, setTheme } = useTheme();

  return (
    <section className="card profile-panel" aria-labelledby="profile-appearance-title">
      <header className="profile-panel-head">
        <div>
          <h2 id="profile-appearance-title">Оформление</h2>
          <p>Выбор применяется сразу и сохраняется в этом браузере</p>
        </div>
      </header>
      <fieldset className="theme-picker">
        <legend>Цветовая гамма</legend>
        <div className="theme-options">
          {themeOptions.map((id) => {
            const { label, description } = THEMES[id];
            return (
              <label className="theme-option" key={id}>
                <input type="radio" name="meraki-theme" value={id} checked={theme === id}
                  onChange={() => setTheme(id)} />
                <span className="theme-option-card">
                  <span className="theme-preview" data-palette={id} aria-hidden="true">
                    <span className="theme-preview-toolbar">
                      <Icon name="graph" />
                      <span />
                    </span>
                    <span className="theme-preview-content">
                      <span className="theme-preview-route"><i /><i /><i /></span>
                      <span className="theme-preview-panel"><i /><i /><i /></span>
                    </span>
                  </span>
                  <span className="theme-option-label">
                    <strong>{label}</strong>
                    <span className="theme-option-dot" aria-hidden="true"><Icon name="check" /></span>
                    <span className="theme-option-description">{description}</span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </section>
  );
}
