import { useEffect, type ReactNode } from "react";

interface RootReadyProps {
  children: ReactNode;
}

export function RootReady({ children }: RootReadyProps) {
  useEffect(() => {
    document.getElementById("root")?.setAttribute("aria-busy", "false");
  }, []);

  return children;
}
