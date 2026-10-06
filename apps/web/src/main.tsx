import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeRoot } from "./theme";
import "./styles.css";
import "./motion.css";
import "./theme-fabric.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeRoot><App /></ThemeRoot>
  </React.StrictMode>
);
