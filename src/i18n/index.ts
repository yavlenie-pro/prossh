import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import ru from "./ru.json";
import zh from "./zh.json";

const SUPPORTED = new Set(["en", "ru", "zh"]);

// Determine initial language: check localStorage, then browser locale
function getInitialLang(): string {
  const stored = localStorage.getItem("prossh.lang");
  if (stored && SUPPORTED.has(stored)) return stored;
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith("ru")) return "ru";
  if (nav.startsWith("zh")) return "zh";
  return "en";
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
    zh: { translation: zh },
  },
  lng: getInitialLang(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;

/** Persist language choice. */
export function setLanguage(lang: string) {
  void i18n.changeLanguage(lang);
  localStorage.setItem("prossh.lang", lang);
}
