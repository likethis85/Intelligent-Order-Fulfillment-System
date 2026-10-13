/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },

        // ===== Business design tokens =====
        // Surface (界面层底色)
        surface: {
          bg: "#FAFAF7",       // 页面米白底
          card: "#FFFFFF",     // 卡片白底
          subtle: "#F3F1EA",   // 轻量 hover / 选中底
          muted: "#EFEDE6",    // 次轻底
        },
        // Edge (边框)
        edge: {
          DEFAULT: "#E8E6E0",  // 常规
          strong: "#D8D5CC",   // 强调
          muted: "#EFEDE6",    // 轻量
        },
        // Ink (文字)
        ink: {
          primary: "#1C1B18",   // 主文字
          secondary: "#6B685E", // 二级
          muted: "#8A877F",     // 辅文
          faint: "#B5B2A8",     // 弱化
          disabled: "#B9B6AD",  // 禁用
        },
        // Action (交互)
        action: {
          primary: "#1C1B18",       // 主按钮底
          "primary-hover": "#3a382f",
          "primary-fg": "#FFFFFF",
          danger: "#B4452F",
          "danger-fg": "#C00000",
          link: "#2E5FA3",
        },
        // Stage (直播排品阶段) — 已降饱和，融进米白调
        stage: {
          "open-bg": "#F3F1EA",     "open-fg": "#1C1B18",
          "connect-bg": "#EDEEE5",  "connect-fg": "#6B8060",
          "peak-bg": "#EFE9DC",     "peak-fg": "#8A7A55",
          "release-bg": "#F3F1EA",  "release-fg": "#6B685E",
          "return-bg": "#EFE6E1",   "return-fg": "#9C6E60",
          "return-row": "#FDF8F6",
        },
        // Tray (货盘类型)
        tray: {
          mazong: "#1C1B18",
          store: "#2F5D8A",
          talent: "#3D7A33",
          channel: "#8A6D1A",
          ip: "#6B4F8A",
        },
        // Misc
        excel: {
          price: "#A6CE39",
          value: "#FFF200",
          code: "#3B9BE6",
        },
        chart: {
          "bar-1": "#C9BFA6",
          "bar-2": "#B7C4B0",
        },
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}