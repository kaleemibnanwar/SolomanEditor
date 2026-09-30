import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { initTelemetry } from "@/lib/telemetry";
import "./globals.css";

// Start usage telemetry unless the user has opted out (see Settings). Never
// awaited — it must not delay first paint, and a network-less clarity.ms only
// fails its own internal request.
void initTelemetry();

createRoot(document.getElementById("root")!).render(<App />);
