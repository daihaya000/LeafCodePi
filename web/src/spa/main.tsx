import { createRoot } from "react-dom/client";
import { Application } from "./Application";
import { installNavigation } from "./navigation";
import "../app/globals.css";

installNavigation();
createRoot(document.getElementById("root")!).render(<Application />);
