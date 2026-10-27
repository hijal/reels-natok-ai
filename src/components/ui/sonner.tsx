"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  /* all dark themes (dark, dark-gray) → dark toaster */
  const sonnerTheme: ToasterProps["theme"] = theme === "light" ? "light" : "dark"

  return (
    <Sonner
      theme={sonnerTheme}
      className="toaster group"
      style={
        {
          /* (fix 717) Gray OPAQUE plate styled to application theme.
             Previously background was set via color-mix(... , transparent) — toasts
             were translucent and the interface showed through. Now background is
             solid --toast-surface (a custom variable for each theme: light,
             dark, gray, "Studio"), border — --border, text — --foreground.
             Toast type (error/success/…) is distinguished by ICON COLOR — styled
             via [data-sonner-toast][data-type=…] in globals.css.
             The plate and close button are defined there as well (see [data-sonner-toast]). */
          "--normal-bg": "var(--toast-surface)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--toast-surface)",
          "--success-text": "var(--foreground)",
          "--success-border": "var(--border)",
          "--error-bg": "var(--toast-surface)",
          "--error-text": "var(--foreground)",
          "--error-border": "var(--border)",
          "--warning-bg": "var(--toast-surface)",
          "--warning-text": "var(--foreground)",
          "--warning-border": "var(--border)",
          "--info-bg": "var(--toast-surface)",
          "--info-text": "var(--foreground)",
          "--info-border": "var(--border)",
        } as React.CSSProperties
      }
      /* (fix 717) Compact toast size. Dimensions/rounded corners/background/border/
         shadow/close button are overridden by globals.css ([data-sonner-toast]).
         Tailwind classes "!border !shadow-sm" were removed: they conflicted with
         our rules via !important (cascade order not guaranteed). */
      toastOptions={{
        style: {
          fontSize: "12px",
          maxWidth: "300px",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
