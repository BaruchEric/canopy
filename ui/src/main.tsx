import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installSoftKeys } from "./softkeys";
import { registerWorker } from "./install";
import "./styles.css";

installSoftKeys();

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
registerWorker();
