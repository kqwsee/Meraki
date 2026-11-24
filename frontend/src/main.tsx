import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./themes.css";
import "./design.css";
import App from "./App";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider><App /></ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
