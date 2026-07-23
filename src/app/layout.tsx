import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "IMAX Ticket Monitor · 70mm & 1.43 Dual Laser",
  description:
    "Live ticket availability for The Odyssey, Dune: Part Three, and Godzilla Minus Zero in IMAX 70mm (Cinemark Dallas, AMC Lincoln Square) and IMAX 1.43 dual laser (Bullock Museum).",
};

// Apply saved/system theme before first paint to avoid a flash
const themeScript = `(function(){try{var t=localStorage.getItem("odyssey70mm.theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
