import { createContext, useContext, useState, type ReactNode } from "react";

export const THEMES = {
  mint: { label: "Мята", mode: "dark", description: "Графит и мятный акцент" },
  ember: { label: "Уголь", mode: "dark", description: "Чёрный и тёмно-оранжевый" },
  linen: { label: "Лён", mode: "light", description: "Бумажный фон и терракота" },
  mist: { label: "Туман", mode: "light", description: "Серо-голубой фон и синий" },
} as const;

type Theme = keyof typeof THEMES;
const STORAGE_KEY = "meraki_theme";
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null);

function isTheme(value: string | null): value is Theme {
  return value != null && Object.hasOwn(THEMES, value);
}

function initialTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : "mint";
  } catch {
    return "mint";
  }
}

// Apply the saved palette before mounting the first screen.
const savedTheme = initialTheme();
document.documentElement.dataset.theme = savedTheme;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState(savedTheme);

  function setTheme(next: Theme) {
    document.documentElement.dataset.theme = next;
    updateTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The current page can still change theme when browser storage is unavailable.
    }
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is required");
  return value;
}

export function useColorMode() {
  return THEMES[useTheme().theme].mode;
}
