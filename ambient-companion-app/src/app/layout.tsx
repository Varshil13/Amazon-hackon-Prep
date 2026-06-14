import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alexa Ambient · Smart Home",
  description: "Context-Aware Smart Home AI for Indian Households",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
