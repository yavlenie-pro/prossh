import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantic palette — wired up via CSS variables in globals.css so the
        // active color profile can swap them at runtime without recompilation.
        bg: "rgb(var(--prossh-bg) / <alpha-value>)",
        "bg-elevated": "rgb(var(--prossh-bg-elevated) / <alpha-value>)",
        "bg-overlay": "rgb(var(--prossh-bg-overlay) / <alpha-value>)",
        fg: "rgb(var(--prossh-fg) / <alpha-value>)",
        "fg-muted": "rgb(var(--prossh-fg-muted) / <alpha-value>)",
        "fg-subtle": "rgb(var(--prossh-fg-subtle) / <alpha-value>)",
        accent: "rgb(var(--prossh-accent) / <alpha-value>)",
        "accent-hover": "rgb(var(--prossh-accent-hover) / <alpha-value>)",
        border: "rgb(var(--prossh-border) / <alpha-value>)",
        "border-subtle": "rgb(var(--prossh-border-subtle) / <alpha-value>)",
        success: "rgb(var(--prossh-success) / <alpha-value>)",
        warning: "rgb(var(--prossh-warning) / <alpha-value>)",
        danger: "rgb(var(--prossh-danger) / <alpha-value>)",
      },
      fontFamily: {
        mono: [
          "Cascadia Code",
          "JetBrains Mono",
          "Fira Code",
          "Consolas",
          "Menlo",
          "monospace",
        ],
        sans: [
          "Inter",
          "Segoe UI Variable",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
      },
      keyframes: {
        indeterminate: {
          "0%": { left: "-33%", right: "100%" },
          "50%": { left: "33%", right: "0%" },
          "100%": { left: "100%", right: "-33%" },
        },
      },
      animation: {
        indeterminate: "indeterminate 1.5s ease-in-out infinite",
      },
      borderRadius: {
        xl: "0.625rem",
      },
    },
  },
  plugins: [],
} satisfies Config;
