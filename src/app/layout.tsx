import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "./ui";

export const metadata: Metadata = {
  title: "WiseBill",
  description: "Ostuarved PDF-ist või pildilt e-arveks ja Billberrysse",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="et">
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
