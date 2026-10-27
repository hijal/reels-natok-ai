import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
// (fix 562) slim window header in Electron mode (not rendered in browser)
import { DesktopTitleBar } from "@/components/h3/desktop-titlebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "MiniMax H3 Studio 7",
  description:
    "Video generation with audio via MiniMax H3 on local ComfyUI",
  icons: [{ rel: "icon", url: "/logo.svg", type: "image/svg+xml" }],
};

export const viewport: Viewport = {
  themeColor: "#1c1c20",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground flex flex-col">
        {/* (fix 562) Electron: window header + content in a column. In browser
            header is not rendered, flex-1 wrapper occupies full height as before. */}
        <DesktopTitleBar />
        <div className="flex-1 min-h-0 flex flex-col">
          <ThemeProvider attribute="class" defaultTheme="dark-gray" enableSystem={false} themes={["dark", "dark-gray", "dark-calm"]}>
          {/* (fix 61) "Aurora" theme removed; (fix 98) light as well —
              if one of them is stored in browser, migrate to default
              gray theme before first render — otherwise next-themes will apply
              a non-existent class and the page will open without a theme. */}
          <script
            suppressHydrationWarning
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var k='theme';var t=localStorage.getItem(k);if(t==='aurora'||t==='light'){localStorage.setItem(k,'dark-gray');var d=document.documentElement;d.classList.remove('aurora','light');d.classList.add('dark-gray');}}catch(e){}try{var s=localStorage.getItem('h3-ui-scale');var v=(s==null||s==='100')?'80':s;var p=parseInt(v,10);if(!isNaN(p))document.documentElement.style.fontSize=p+'%';}catch(e){}})();`,
            }}
          />
          {children}
          </ThemeProvider>
          <Toaster position="bottom-center" richColors closeButton />
        </div>
      </body>
    </html>
  );
}
