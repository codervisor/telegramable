import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Telegramable",
  description: "Telegram-first AI agent interface",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
