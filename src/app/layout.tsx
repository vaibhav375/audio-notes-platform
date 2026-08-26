import type { Metadata } from "next";
import Link from "next/link";
import {
  Bricolage_Grotesque,
  Instrument_Sans,
  JetBrains_Mono,
} from "next/font/google";
import "./globals.css";

const display = Bricolage_Grotesque({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "700", "800"],
});

const body = Instrument_Sans({
  variable: "--font-body",
  subsets: ["latin"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Audio Notes",
  description:
    "Upload a recording, get a transcript from Gnani's speech-to-text API and an LLM summary.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} ${mono.variable}`}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="masthead">
          <Link href="/" className="wordmark">
            <span className="wordmark__ticks" aria-hidden="true">
              {Array.from({ length: 7 }).map((_, i) => (
                <i key={i} />
              ))}
            </span>
            Audio Notes
          </Link>
          <nav className="masthead__nav">
            <Link href="/">Library</Link>
            <Link href="/architecture">Architecture</Link>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="footer">
          <span>Speech-to-text by Gnani.ai · summaries by Qwen</span>
        </footer>
      </body>
    </html>
  );
}
