import type { Metadata } from "next";
import { Archivo_Black, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// Heavy blocky grotesque, the closest free face to the IMAX wordmark
const archivoBlack = Archivo_Black({
  weight: "400",
  variable: "--font-archivo-black",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "70mm IMAX Ticket Monitor",
  description:
    "Live ticket availability for The Odyssey, Dune: Part Three, and Godzilla Minus Zero in IMAX 70mm film (Cinemark Dallas, AMC Lincoln Square) and IMAX DL2 dual laser (Bullock Museum).",
};

// Apply saved/system theme before first paint to avoid a flash
const themeScript = `(function(){try{var t=localStorage.getItem("odyssey70mm.theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${archivoBlack.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
