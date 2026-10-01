import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WiseBill",
  description: "Algdokumentide teisendamine Excellent Booksi e-arve XML-iks",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="et">
      <body>{children}</body>
    </html>
  );
}
