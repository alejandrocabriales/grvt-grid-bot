import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GRVT Grid Bot",
  description: "Automated grid trading bot for GRVT.io",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* Suppress errors thrown by browser extensions (e.g. GRVT inpage.js) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.sseError = function(){};
              window.addEventListener('error', function(e) {
                if (e.filename && e.filename.startsWith('chrome-extension://')) {
                  e.stopImmediatePropagation();
                  e.preventDefault();
                  return false;
                }
              }, true);
            `,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
