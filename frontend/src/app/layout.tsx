import type { Metadata } from "next";
import { IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

// One workhorse family for the whole console; tabular figures are switched on in CSS.
const plex = IBM_Plex_Sans({
  variable: "--font-plex",
  subsets: ["latin"],
  axes: ["wdth"],
});

export const metadata: Metadata = {
  title: "Disaster Relief Router",
  description: "Flood response for Guwahati: from a messy report to a safe, approved dispatch.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plex.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
