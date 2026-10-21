import type { Metadata } from "next";
import "./globals.css";
import { AuthGate } from "./auth";
import { Nav } from "./ui";

export const metadata: Metadata = {
  title: "WiseBill",
  description: "Algdokumentide teisendamine Excellent Booksi e-arve XML-iks",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="et">
      <body>
        <AuthGate>
          <Nav />
          {children}
        </AuthGate>
      </body>
    </html>
  );
}
